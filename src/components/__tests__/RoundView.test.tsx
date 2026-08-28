import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RoundView } from '../RoundView'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../../engine/achievementContent'
import { applyAction } from '../../engine/applyAction'
import { createEmptyBoard, setTile } from '../../engine/board'
import { cardIdFor, createPlayerCards, syncCardZonesWithBoard } from '../../engine/cards'
import { createNewGame } from '../../engine/createGame'
import { beginSelectCardsPhase } from '../../engine/round'
import { EMPTY_TALE_CONTENT } from '../../engine/taleContent'
import type { GameState, Player, Resources, Unit, UnitMovement } from '../../engine/types'
import type { TurnReview } from '../../engine/turnReview'
import { EMPTY_UNIT_CONTENT } from '../../engine/unitContent'
import type { UnitAction, UnitContent } from '../../engine/unitContent'
import type { PlayerRow } from '../../lib/dbTypes'
import unitsJson from '../../content/units.json'
import terrainJson from '../../content/terrain.json'
import resourcesJson from '../../content/resources.json'

function makePlayerRow(id: string, displayName: string, color: string): PlayerRow {
  return { id, game_id: 'g1', user_id: id, display_name: displayName, avatar_url: null, seat_index: 0, color, is_active: true, joined_at: '', ready_for_version: 0 }
}

function makeEnginePlayer(id: string, handKinds: string[]): Player {
  const cards = createPlayerCards(id)
  const handCardIds = handKinds.map((kind) => cardIdFor(id, kind))
  return {
    id,
    authUserId: null,
    displayName: id,
    color: 'red',
    handCardIds,
    currentlyPlayedCardId: null,
    discardCardIds: [],
    supplyCardIds: cards.map((c) => c.id).filter((id) => !handCardIds.includes(id)),
    declineCardIds: [],
    eliminated: false,
    resources: { gold: 3, wood: 1, stone: 0 },
  }
}

function makeState(): GameState {
  const p1 = makeEnginePlayer('p1', ['nomad', 'ship'])
  const p2 = makeEnginePlayer('p2', ['city'])
  const cards = Object.fromEntries([...createPlayerCards('p1'), ...createPlayerCards('p2')].map((c) => [c.id, c]))

  return {
    gameId: 'g1',
    playMode: 'hotseat',
    status: 'active',
    turn: 1,
    activePlayerId: null,
    roundPhase: 'selectCards',
    chosenCardIdByPlayerId: { p1: null, p2: null },
    pendingPlayerIds: ['p1', 'p2'],
    resolvedUnitIdsThisTurn: [],
    unitsCreatedThisTurn: [],
    turnOrder: ['p1', 'p2'],
    board: createEmptyBoard('hex'),
    players: [p1, p2],
    units: [],
    cards,
    resourceBank: { gold: 100, wood: 100, stone: 100 },
    activeTaleIds: [],
    gameLength: Infinity,
    winnerPlayerIds: [],
    claimedByAchievementId: { 'city-mastery': 'p2' },
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
  }
}

describe('RoundView — player status summary and achievements panel', () => {
  it("shows each player's hand as unit kinds, not just a count", () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // Hand cards render as icons now, not kind names — each icon carries the
    // kind as its accessible title.
    expect(screen.getAllByTitle('Nomad')).toHaveLength(1)
    expect(screen.getAllByTitle('Ship')).toHaveLength(1)
    expect(screen.getAllByTitle('City')).toHaveLength(1)
  })

  it('shows discard and decline cards as icons alongside hand, in the same row', () => {
    const state = makeState()
    const p1Index = state.players.findIndex((p) => p.id === 'p1')
    state.players[p1Index] = {
      ...state.players[p1Index],
      discardCardIds: [cardIdFor('p1', 'merchant')],
      declineCardIds: [cardIdFor('p1', 'mountaineer')],
    }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // Both players' chips show Hand/Discard/Decline labels; only p1 has cards in each.
    expect(screen.getAllByText('Hand')).toHaveLength(2)
    expect(screen.getAllByTitle('Nomad')).toHaveLength(1)
    expect(screen.getAllByTitle('Ship')).toHaveLength(1)
    expect(screen.getAllByText('Discard')).toHaveLength(2)
    expect(screen.getAllByTitle('Merchant')).toHaveLength(1)
    expect(screen.getAllByText('Decline')).toHaveLength(2)
    expect(screen.getAllByTitle('Mountaineer')).toHaveLength(1)

    // p2 has an empty discard and decline (but a non-empty hand) — exactly
    // those two fall back to "empty".
    expect(screen.getAllByText('empty')).toHaveLength(2)
  })

  it("shows each player's chosen card as a 'Playing' icon during the actions phase, and not otherwise", () => {
    const base = makeState() // roundPhase: 'selectCards'
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    const { rerender } = render(
      <RoundView
        state={base}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // Nobody has chosen yet, and it's not the actions phase — no "Playing" indicator at all.
    expect(screen.queryByText('Playing')).not.toBeInTheDocument()

    const state = {
      ...base,
      roundPhase: 'actions' as const,
      chosenCardIdByPlayerId: { p1: cardIdFor('p1', 'nomad'), p2: cardIdFor('p2', 'city') },
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: 'p1',
    }
    rerender(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // Alice chose Nomad, Bob chose City — each shown as their own "Playing" icon.
    expect(screen.getAllByText('Playing')).toHaveLength(2)
    expect(screen.getByTitle('Playing Nomad this turn')).toBeInTheDocument()
    expect(screen.getByTitle('Playing City this turn')).toBeInTheDocument()

    // The chosen card is still in handCardIds internally until the turn
    // resolves, but it should only render as "Playing", not also in Hand:
    // Alice's Nomad (chosen) is hidden from Hand — no bare "Nomad" icon
    // title anywhere, just the "Playing Nomad this turn" indicator — while
    // her Ship (not chosen) still shows in Hand. Bob's City (chosen, his
    // only hand card) leaves his Hand empty, so no bare "City" icon either.
    expect(screen.queryByTitle('Nomad')).not.toBeInTheDocument()
    expect(screen.queryByTitle('City')).not.toBeInTheDocument()
    expect(screen.getByTitle('Ship')).toBeInTheDocument()
  })

  it("keeps a chosen-but-unrevealed card in the Hand display during the selectCards phase", () => {
    // https://github.com/jinxbit/Rise-and-fall/issues/122 — during the
    // simultaneous select-cards phase, choosing a card shouldn't make it
    // vanish from the Hand summary (it's not revealed as "Playing" yet).
    const base = makeState() // roundPhase: 'selectCards'
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const state = {
      ...base,
      chosenCardIdByPlayerId: { p1: cardIdFor('p1', 'nomad'), p2: null },
      pendingPlayerIds: ['p2'],
    }

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // Alice already chose Nomad, but it's still selectCards — no reveal yet.
    expect(screen.queryByText('Playing')).not.toBeInTheDocument()
    // Both her hand cards, including the chosen Nomad, still show in Hand.
    expect(screen.getByTitle('Nomad')).toBeInTheDocument()
    expect(screen.getByTitle('Ship')).toBeInTheDocument()
  })

  it('marks the start player (turnOrder[0]) and moves the mark when turnOrder rotates', () => {
    const state = makeState() // turnOrder: ['p1', 'p2']
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    const { rerender } = render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    const startPlayerMark = () => screen.getByTitle('Start player — rotates to the next player each round')
    // p1 (Alice) is turnOrder[0] — the mark sits in their chip, before Bob's.
    expect(startPlayerMark().closest('button')?.textContent).toContain('Alice')

    // Once the round ends, turnOrder rotates (see engine/round.ts) — the mark should follow.
    rerender(
      <RoundView
        state={{ ...state, turnOrder: ['p2', 'p1'] }}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(startPlayerMark().closest('button')?.textContent).toContain('Bob')
  })

  it('shows every achievement (claimed and unclaimed) and the current decline buyback price', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={{ ...EMPTY_ACHIEVEMENT_CONTENT, purchaseCostTable: [5, 10, 20] }}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // A claimed achievement shows who claimed it...
    expect(screen.getByText(/^City.*Bob/)).toBeInTheDocument()
    // ...an unclaimed one says so...
    expect(screen.getByText(/^Ship.*unclaimed/)).toBeInTheDocument()
    // ...and the buyback price reflects the one achievement claimed so far (index 0 of the table)...
    expect(screen.getByText('5 gold')).toBeInTheDocument()
    // ...with the remaining, upcoming prices shown alongside it (each price its own element, so the
    // final one can be styled separately — see purchasePriceLadder's isCurrentFinal).
    const buybackParagraph = screen.getByText(/Buy back from decline/).closest('p')
    expect(buybackParagraph?.textContent).toContain('— next: 10 → 20 gold')
  })

  it("shows a Tale controllable structure (e.g. The Cathedral) in its own 'claimable' section, separate from real achievements", () => {
    const state = makeState()
    state.units = [{ id: 'cathedral_1', ownerId: 'p2', kind: 'cathedral', coord: { q: 0, r: 0 }, movement: { isMobile: false, terrains: [], canCrossCliffs: false }, traits: [] }]
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const taleContent = { ...EMPTY_TALE_CONTENT, controllableStructures: [{ kind: 'cathedral', name: 'The Cathedral', victoryPoints: 15 }] }

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={taleContent}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(screen.getByText('Tale bonuses (claimable)')).toBeInTheDocument()
    expect(screen.getByText(/^The Cathedral.*Bob/)).toBeInTheDocument()
  })

  it("marks a Tale controllable structure 'unclaimed' before it's ever built", () => {
    const state = makeState() // no cathedral unit anywhere
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const taleContent = { ...EMPTY_TALE_CONTENT, controllableStructures: [{ kind: 'cathedral', name: 'The Cathedral', victoryPoints: 15 }] }

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={taleContent}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(screen.getByText(/^The Cathedral.*unclaimed/)).toBeInTheDocument()
  })

  it('shows no Tale bonuses section when no active Tale contributes one', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(screen.queryByText('Tale bonuses (claimable)')).not.toBeInTheDocument()
  })

  it("shows how many achievements have been claimed out of the game's configured length", () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={{ ...EMPTY_ACHIEVEMENT_CONTENT, gameLength: 4 }}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // makeState() has exactly one claimed achievement.
    expect(screen.getByText('1 of 4 achievements claimed')).toBeInTheDocument()
  })

  it('marks the decline price for the game-ending achievement distinctly, and never shows a price past it', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={{ ...EMPTY_ACHIEVEMENT_CONTENT, purchaseCostTable: [5, 10, 20, 40], gameLength: 3 }}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // gameLength=3 caps the ladder at costTable[2]=20 (price for the 3rd
    // achievement, which ends the game) — costTable[3]=40 is never reached
    // and must not be shown at all.
    const buybackParagraph = screen.getByText(/Buy back from decline/).closest('p')
    expect(buybackParagraph?.textContent).toContain('— next: 10 → 20 gold')
    expect(buybackParagraph?.textContent).not.toContain('40')
    expect(screen.getByText(/→ 20/).className).toContain('text-red-400')
  })

  it("shows each player's remaining unit supply per kind (cap minus units currently on the board)", () => {
    const state = makeState()
    state.units = [
      { id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: { isMobile: true, terrains: [], canCrossCliffs: false }, traits: [] },
    ]
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const unitContent: UnitContent = {
      ...EMPTY_UNIT_CONTENT,
      unitSupplyCaps: { city: 2, temple: 2, nomad: 3, merchant: 2, mountaineer: 2, ship: 2 },
    }

    const { container } = render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={unitContent}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // Remaining supply now renders as icon+count badges (title = kind name,
    // visible text = the count) instead of a "Kind N" text list.
    // p1 has 1 of 3 Nomads built (remaining 2); p2 has built nothing at all
    // (full supply, 3, remaining).
    const nomadCounts = [...container.querySelectorAll('span[title="Nomad"]')].map((el) => el.textContent)
    expect(nomadCounts).toEqual(['2', '3'])
    const shipCounts = [...container.querySelectorAll('span[title="Ship"]')].map((el) => el.textContent)
    expect(shipCounts).toEqual(['2', '2'])
  })

  it.each([
    ['placed' as const, ['1', '0']],
    ['both' as const, ['1/2', '0/3']],
  ])("issue #346: unitReserveDisplayMode=%s shows placed (and remaining) counts instead of just remaining", (unitReserveDisplayMode, expectedNomadCounts) => {
    const state = makeState()
    state.units = [
      { id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: { isMobile: true, terrains: [], canCrossCliffs: false }, traits: [] },
    ]
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const unitContent: UnitContent = {
      ...EMPTY_UNIT_CONTENT,
      unitSupplyCaps: { city: 2, temple: 2, nomad: 3, merchant: 2, mountaineer: 2, ship: 2 },
    }

    const { container } = render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={unitContent}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        unitReserveDisplayMode={unitReserveDisplayMode}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    const nomadCounts = [...container.querySelectorAll('span[title="Nomad"]')].map((el) => el.textContent)
    expect(nomadCounts).toEqual(expectedNomadCounts)
  })

  it("shows each player's current score, computed live from claimed achievements — not just at game end (see the next test for terrain-control)", () => {
    const state = makeState() // claimedByAchievementId: { 'city-mastery': 'p2' }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={{ ...EMPTY_ACHIEVEMENT_CONTENT, achievementVictoryPoints: { 'city-mastery': 5 } }}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(screen.getByText('Score 0')).toBeInTheDocument() // p1: nothing claimed
    expect(screen.getByText('Score 5')).toBeInTheDocument() // p2: claimed city-mastery, worth 5 VP
  })

  it("includes terrain-control VP in each player's current score, not just achievements", () => {
    // The previous test's board is empty (createEmptyBoard, no units), so
    // it never actually exercised the terrain-control term despite its own
    // title claiming to — this one does, with a real 2-hex Plain region p1
    // holds a unit majority in and p2 has no presence in at all.
    let state = makeState()
    state = {
      ...state,
      board: setTile(setTile(state.board, { q: 0, r: 0 }, 'plain'), { q: 1, r: 0 }, 'plain'),
      units: [
        { id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: { isMobile: true, terrains: ['plain'], canCrossCliffs: false }, traits: [] },
        { id: 'u2', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: { isMobile: true, terrains: ['plain'], canCrossCliffs: false }, traits: [] },
      ],
    }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={{ ...EMPTY_ACHIEVEMENT_CONTENT, achievementVictoryPoints: { 'city-mastery': 5 }, terrainVictoryPoints: { plain: 3 } }}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // p1: majority (2 units) in a 2-hex Plain region at 3 VP/hex -> 6, plus nothing from achievements.
    expect(screen.getByText('Score 6')).toBeInTheDocument()
    // p2: claimed city-mastery (5 VP), no board presence at all -> no terrain-control VP.
    expect(screen.getByText('Score 5')).toBeInTheDocument()
  })

  it("includes gold VP in each player's current score (bug: gold was not counted as part of the victory point display at all)", () => {
    let state = makeState()
    state = {
      ...state,
      players: state.players.map((p) => (p.id === 'p1' ? { ...p, resources: { gold: 5, wood: 0, stone: 0 } } : { ...p, resources: { gold: 0, wood: 0, stone: 0 } })),
    }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={{ ...EMPTY_ACHIEVEMENT_CONTENT, achievementVictoryPoints: { 'city-mastery': 5 }, goldPerVictoryPoint: 2 }}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // p1: 5 gold at 2 gold/point -> 2 VP, nothing claimed -> Score 2.
    expect(screen.getByText('Score 2')).toBeInTheDocument()
    // p2: claimed city-mastery (5 VP), 0 gold -> Score 5, unchanged by gold.
    expect(screen.getByText('Score 5')).toBeInTheDocument()
  })

  it('renders the achievements panel and full player roster beside the board, after it in document order', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    const { container } = render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    const boardPlaceholder = [...container.querySelectorAll('div')].find((el) => el.textContent === 'Board has not been generated yet.')
    const achievementsBlock = [...container.querySelectorAll('p')].find((el) => el.textContent?.startsWith('Buy back from decline'))
    expect(boardPlaceholder).toBeTruthy()
    expect(achievementsBlock).toBeTruthy()
    // The achievements panel — and the full player roster it sits directly
    // under — comes after the board in document order: it's the sidebar
    // beside the map, not a block near the top of the page.
    expect(boardPlaceholder!.compareDocumentPosition(achievementsBlock!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('RoundView — select-cards phase auto-plays a single-card hand (issue #25)', () => {
  it("submits the only card in hand on your turn to choose, without needing a click", () => {
    const state = makeState() // p2's hand is just ['city']
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const onChooseCard = vi.fn()

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p2"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={onChooseCard}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(onChooseCard).toHaveBeenCalledTimes(1)
    expect(onChooseCard).toHaveBeenCalledWith(cardIdFor('p2', 'city'))
    // No clickable card button rendered — there's nothing left to decide.
    expect(screen.queryByRole('button', { name: 'City' })).not.toBeInTheDocument()
  })

  it('still shows a clickable choice when the hand has more than one card', () => {
    const state = makeState() // p1's hand is ['nomad', 'ship']
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const onChooseCard = vi.fn()

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={onChooseCard}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(onChooseCard).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Nomad' }))
    expect(onChooseCard).toHaveBeenCalledWith(cardIdFor('p1', 'nomad'))
  })

  it("does not auto-play a card that isn't yours to choose (already resolved this round)", () => {
    const state = { ...makeState(), pendingPlayerIds: ['p1'] } // p2 already chosen/resolved
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const onChooseCard = vi.fn()

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p2"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={onChooseCard}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(onChooseCard).not.toHaveBeenCalled()
    expect(screen.getByText('Waiting for: Alice')).toBeInTheDocument()
  })
})

describe('RoundView — "Expand board" toggle', () => {
  it('hides the full player roster and achievements panel, and brings them back', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.getByText('Buy back from decline:', { exact: false })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expand board' }))

    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
    expect(screen.queryByText('Buy back from decline:', { exact: false })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse board' }))

    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.getByText('Buy back from decline:', { exact: false })).toBeInTheDocument()
  })
})

describe('RoundView — player detail panel (click a player chip for more info)', () => {
  it("is collapsed until a player's chip is clicked, then shows their full VP breakdown, cards by zone, unit counts, and resources — and collapses again on a second click", () => {
    let state = makeState()
    state = {
      ...state,
      units: [
        { id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: { isMobile: true, terrains: [], canCrossCliffs: false }, traits: [] },
        { id: 'u2', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: { isMobile: true, terrains: [], canCrossCliffs: false }, traits: [] },
      ],
      players: state.players.map((p) => (p.id === 'p1' ? { ...p, resources: { gold: 5, wood: 2, stone: 1 } } : p)),
    }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    const { container } = render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={{ ...EMPTY_ACHIEVEMENT_CONTENT, unitBoardCountVP: { nomad: [1, 3] }, goldPerVictoryPoint: 2 }}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(screen.queryByText(/VP breakdown/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Alice').closest('button')!)

    // p1: 2 Nomads on board -> boardCount curve [1, 3] at count 2 -> 3 VP; 5 gold at 2 gold/point -> 2 VP; total 5.
    expect(screen.getByText('VP breakdown — 5 total')).toBeInTheDocument()
    expect(screen.getByText('Achievements 0, Board count 3, Terrain control 0, Gold 2')).toBeInTheDocument()
    // "Currently played"/"Discard"/"Decline" pair a label text node with a
    // nested icon-row element (rendering "none" when empty), so the full
    // line's text is split across elements — match on the full textContent instead.
    const fullTextP = (text: string) => screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === text)
    expect(fullTextP('Currently played: none')).toBeInTheDocument()
    expect(fullTextP('Discard: none')).toBeInTheDocument()
    expect(fullTextP('Decline: none')).toBeInTheDocument()
    expect(screen.getByText(/^Supply:/)).toBeInTheDocument()
    // "Units on board" renders as an icon+count badge (title = kind name).
    expect(container.querySelector('span[title="Nomad"]')?.textContent).toBe('2')
    // Resources render as icon+amount chips (title = resource name), like the "Units on board" badges above.
    const resourcesRow = screen.getByText('Resources').nextElementSibling as HTMLElement
    expect(resourcesRow.querySelector('span[title="Gold"]')?.textContent).toBe('5')
    expect(resourcesRow.querySelector('span[title="Wood"]')?.textContent).toBe('2')
    expect(resourcesRow.querySelector('span[title="Stone"]')?.textContent).toBe('1')
    // Hand cards render as icons (title = kind name) — one Nomad and one
    // Ship icon in the strip's chip, and again in the detail panel's own
    // "Hand: ..." line — two places.
    const iconTitle = (kind: string) => [...container.querySelectorAll('svg > title')].filter((el) => el.textContent === kind)
    expect(iconTitle('Nomad')).toHaveLength(2)
    expect(iconTitle('Ship')).toHaveLength(2)

    fireEvent.click(screen.getByText('Alice').closest('button')!)
    expect(screen.queryByText(/VP breakdown/)).not.toBeInTheDocument()
  })

  it("clicking a different player's chip switches the detail panel to that player, rather than opening a second one", () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={{ ...EMPTY_ACHIEVEMENT_CONTENT, achievementVictoryPoints: { 'city-mastery': 5 } }}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    fireEvent.click(screen.getByText('Alice').closest('button')!)
    expect(screen.getByText('VP breakdown — 0 total')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Bob').closest('button')!)
    expect(screen.getAllByText(/VP breakdown —/)).toHaveLength(1)
    // p2 claimed city-mastery, worth 5 VP.
    expect(screen.getByText('VP breakdown — 5 total')).toBeInTheDocument()
  })

  it('renders the detail panel directly under the clicked player, not below every player in the strip', () => {
    let state = makeState()
    const p3 = makeEnginePlayer('p3', [])
    state = {
      ...state,
      players: [...state.players, p3],
      turnOrder: [...state.turnOrder, 'p3'],
      pendingPlayerIds: [...state.pendingPlayerIds, 'p3'],
      chosenCardIdByPlayerId: { ...state.chosenCardIdByPlayerId, p3: null },
    }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff'), makePlayerRow('p3', 'Carol', '#00ff00')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // Alice is the first of three players — clicking her chip should insert
    // the detail panel right after her chip, ahead of Bob's and Carol's,
    // rather than appending it once at the bottom of the whole strip.
    const aliceButton = screen.getByText('Alice').closest('button')!
    fireEvent.click(aliceButton)

    const bobButton = screen.getByText('Bob').closest('button')!
    expect(aliceButton.nextElementSibling?.textContent).toContain('VP breakdown')
    expect(bobButton.previousElementSibling?.textContent).toContain('VP breakdown')
  })
})

function buildRealUnitContent(): UnitContent {
  const actionsByKind: Record<string, UnitAction[]> = {}
  const movementByKind: Record<string, UnitMovement> = {}
  const unitSupplyCaps: Record<string, number> = {}
  for (const unit of unitsJson.units) {
    actionsByKind[unit.id] = unit.actions as unknown as UnitAction[]
    movementByKind[unit.id] = {
      isMobile: unit.movement.isMobile,
      terrains: unit.movement.terrains as UnitMovement['terrains'],
      canCrossCliffs: unit.movement.canCrossCliffs,
      moveDistance: unit.movement.moveDistance as UnitMovement['moveDistance'],
      blockedByUnits: unit.movement.blockedByUnits as UnitMovement['blockedByUnits'],
      canEndMoveOnUnitTypes: unit.movement.canEndMoveOnUnitTypes,
    }
    unitSupplyCaps[unit.id] = unit.supply.byPlayerCount['2']
  }
  const terrainLevels: Record<string, number> = {}
  for (const terrain of terrainJson.terrainTypes) terrainLevels[terrain.id] = terrain.level
  const resourceCaps: Partial<Record<keyof Resources, number | null>> = {}
  for (const resource of resourcesJson.resources) resourceCaps[resource.id as keyof Resources] = resource.playerCap
  return { actionsByKind, movementByKind, terrainLevels, resourceCaps, unitSupplyCaps, companionKindsByCardKind: {}, activationsPerTurnByKind: {} }
}

/** Builds an active-actions-phase GameState for `cardKind`, using the real content (see buildRealUnitContent), with p2 excluded so only p1's own units/turn matter — same setup shape as the City/Convert and Ship/Port describe blocks below. */
function beginActionsForUnits(content: UnitContent, board: ReturnType<typeof createEmptyBoard>, units: Unit[], cardKind: string): GameState {
  const lobby = createNewGame({
    gameId: 'g',
    playMode: 'hotseat',
    board,
    players: [
      { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
    ],
    resourceBank: { gold: 100, wood: 100, stone: 100 },
  })
  const active: GameState = {
    ...lobby,
    board,
    units,
    status: 'active',
    turnOrder: ['p1'],
    players: lobby.players.map((p) => (p.id === 'p2' ? { ...p, eliminated: true } : p)),
  }
  const selecting = beginSelectCardsPhase(syncCardZonesWithBoard(active))
  const chosen = applyAction(selecting, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', cardKind) }, content)
  if (!chosen.ok) throw new Error('setup failed: ' + chosen.error)
  return chosen.state
}

const BULK_TEST_PLAYERS: PlayerRow[] = [
  { id: 'p1', game_id: 'g', user_id: 'p1', display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#ef4444', is_active: true, joined_at: '', ready_for_version: 0 },
  { id: 'p2', game_id: 'g', user_id: 'p2', display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#3b82f6', is_active: true, joined_at: '', ready_for_version: 0 },
]

describe('RoundView — bulk actions on idle units (issue #61)', () => {
  it('shows a bulk-action button for a no-target action shared by every idle unit, and resolves them all in one submission when clicked', () => {
    const content = buildRealUnitContent()
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'forest'), { q: 1, r: 0 }, 'forest')
    const nomadA: Unit = { id: 'nomadA', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const nomadB: Unit = { id: 'nomadB', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const state = beginActionsForUnits(content, board, [nomadA, nomadB], 'nomad')

    const onResolveBulkAction = vi.fn()
    render(
      <RoundView
        state={state}
        players={BULK_TEST_PLAYERS}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={onResolveBulkAction}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    const bulkButton = screen.getByRole('button', { name: /Produce Resource — all \(2\)/ })
    expect(within(bulkButton).getByTitle('Wood')).toBeInTheDocument()
    expect(bulkButton.textContent).toContain('+2')
    fireEvent.click(bulkButton)

    expect(onResolveBulkAction).toHaveBeenCalledWith(['nomadA', 'nomadB'], 'produce-resource')
  })

  it("only counts units the action would actually pay out for — a Nomad on Plain (no resourceByTerrain entry) doesn't inflate the count or get bulk-resolved", () => {
    const content = buildRealUnitContent()
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'forest'), { q: 1, r: 0 }, 'plain')
    const nomadForest: Unit = { id: 'nomadForest', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const nomadPlain: Unit = { id: 'nomadPlain', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const state = beginActionsForUnits(content, board, [nomadForest, nomadPlain], 'nomad')

    const onResolveBulkAction = vi.fn()
    render(
      <RoundView
        state={state}
        players={BULK_TEST_PLAYERS}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={onResolveBulkAction}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    const bulkButton = screen.getByRole('button', { name: /Produce Resource — all \(1\)/ })
    expect(within(bulkButton).getByTitle('Wood')).toBeInTheDocument()
    expect(bulkButton.textContent).toContain('+1')
    fireEvent.click(bulkButton)

    expect(onResolveBulkAction).toHaveBeenCalledWith(['nomadForest'], 'produce-resource')
  })

  it('aggregates the outcome across units producing different resources, e.g. a Forest Nomad + a Mountain Nomad shows the combined total', () => {
    const content = buildRealUnitContent()
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'forest'), { q: 1, r: 0 }, 'mountain')
    const nomadForest: Unit = { id: 'nomadForest', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const nomadMountain: Unit = { id: 'nomadMountain', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const state = beginActionsForUnits(content, board, [nomadForest, nomadMountain], 'nomad')

    const onResolveBulkAction = vi.fn()
    render(
      <RoundView
        state={state}
        players={BULK_TEST_PLAYERS}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={onResolveBulkAction}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    const bulkButton = screen.getByRole('button', { name: /Produce Resource — all \(2\)/ })
    expect(within(bulkButton).getByTitle('Wood')).toBeInTheDocument()
    expect(within(bulkButton).getByTitle('Stone')).toBeInTheDocument()
    expect(bulkButton.textContent).toContain('+1')
    fireEvent.click(bulkButton)

    expect(onResolveBulkAction).toHaveBeenCalledWith(['nomadForest', 'nomadMountain'], 'produce-resource')
  })

  it('shows no bulk-action button for an action that needs a target hex (e.g. Transform to Ship), even with multiple idle units sharing it', () => {
    const content = buildRealUnitContent()
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'water'), { q: 1, r: 0 }, 'water')
    const nomadA: Unit = { id: 'nomadA', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const nomadB: Unit = { id: 'nomadB', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    let state = beginActionsForUnits(content, board, [nomadA, nomadB], 'nomad')
    state = { ...state, players: state.players.map((p) => (p.id === 'p1' ? { ...p, resources: { gold: 5, wood: 5, stone: 5 } } : p)) }

    render(
      <RoundView
        state={state}
        players={BULK_TEST_PLAYERS}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // Both Nomads sit on Water — Transform to Ship's targetHex is 'adj' (needs
    // a player-picked hex), so no bulk button should offer it, unlike Produce
    // Resource in the tests above.
    expect(screen.queryByRole('button', { name: /Transform to Ship/ })).not.toBeInTheDocument()
  })

  it("shows no bulk-action button for a self-targeted transform (e.g. Nomad's Transform to City/Temple), even though it needs no target hex (issue #201)", () => {
    const content = buildRealUnitContent()
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 1, r: 0 }, 'plain')
    const nomadA: Unit = { id: 'nomadA', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const nomadB: Unit = { id: 'nomadB', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    let state = beginActionsForUnits(content, board, [nomadA, nomadB], 'nomad')
    state = { ...state, players: state.players.map((p) => (p.id === 'p1' ? { ...p, resources: { gold: 5, wood: 5, stone: 5 } } : p)) }

    render(
      <RoundView
        state={state}
        players={BULK_TEST_PLAYERS}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // Both Nomads sit on Plain with enough resources for either transform —
    // Transform to City/Temple's targetHex is 'self', so actionNeedsTargeting
    // treats it as no-target, but it destroys the unit and permanently turns
    // it into a City/Temple, so it must stay off the "act on everyone" bar.
    expect(screen.queryByRole('button', { name: /Transform to City/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Transform to Temple/ })).not.toBeInTheDocument()
  })
})

describe("RoundView — City's Convert to Merchant/Mountaineer (bug report: \"no follow up selection of which unit to transform\")", () => {
  it('clicking City, then Convert to Merchant, then the adjacent Nomad hex resolves with that Nomad as the target', () => {
    const content = buildRealUnitContent()
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 1, r: 0 }, 'plain')
    const city: Unit = { id: 'city1', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const nomad: Unit = { id: 'nomad1', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }

    const lobby = createNewGame({
      gameId: 'g',
      playMode: 'hotseat',
      board,
      players: [
        { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
      ],
      resourceBank: { gold: 100, wood: 100, stone: 100 },
    })
    // p2 never gets units here — this test only exercises p1's own
    // City-Convert flow — so p2 is excluded up front (not in turnOrder,
    // marked eliminated) rather than left for beginSelectCardsPhase to
    // eliminate naturally: eliminatePlayer now ends the game outright once
    // only one player remains (elimination.ts), which would otherwise
    // complete the game before this test's own actions even run.
    let active: GameState = {
      ...lobby,
      board,
      units: [city, nomad],
      status: 'active',
      turnOrder: ['p1'],
      players: lobby.players.map((p) => (p.id === 'p2' ? { ...p, eliminated: true } : p)),
    }
    active = { ...active, players: active.players.map((p) => (p.id === 'p1' ? { ...p, resources: { gold: 5, wood: 5, stone: 5 } } : p)) }
    const selecting = beginSelectCardsPhase(syncCardZonesWithBoard(active))
    const chosen = applyAction(selecting, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, content)
    if (!chosen.ok) throw new Error('setup failed: ' + chosen.error)

    const players: PlayerRow[] = [
      { id: 'p1', game_id: 'g', user_id: 'p1', display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#ef4444', is_active: true, joined_at: '', ready_for_version: 0 },
      { id: 'p2', game_id: 'g', user_id: 'p2', display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#3b82f6', is_active: true, joined_at: '', ready_for_version: 0 },
    ]

    const onResolveUnit = vi.fn()
    const { container } = render(
      <RoundView
        state={chosen.state}
        players={players}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={onResolveUnit}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // Base hex tiles render before any ghost/menu overlays — the City
    // (placed first) is the first polygon, the Nomad's hex the second.
    // Scoped to the board's own <svg> (identified by its background class)
    // since the player status sidebar now also renders unit-icon <svg>s
    // with their own direct <polygon> children.
    const boardSvg = container.querySelector('svg.bg-neutral-950')!
    const basePolygons = boardSvg.querySelectorAll(':scope > polygon')
    fireEvent.click(basePolygons[0])

    // The option box's textContent now also carries its outcome-preview
    // suffix (e.g. a cost's "-2") right after the bold title span, with no
    // separating text node — startsWith instead of an exact match.
    const convertOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.startsWith('Convert to Merchant'))
    expect(convertOption).toBeTruthy()
    fireEvent.click(convertOption!)

    // Selecting the action must enter targeting mode — the legal (adjacent,
    // own-Nomad) hex highlighted green — not resolve immediately.
    expect(onResolveUnit).not.toHaveBeenCalled()
    expect(container.querySelectorAll('polygon[fill="rgba(34,197,94,0.1)"]')).toHaveLength(1)

    fireEvent.click(boardSvg.querySelectorAll(':scope > polygon')[1])

    expect(onResolveUnit).toHaveBeenCalledWith('city1', 'create-merchant', { q: 1, r: 0 })
  })
})

describe('RoundView — stacked units on one hex (Ship + Port, The Ports Tale)', () => {
  const shipMovement: UnitMovement = { isMobile: true, terrains: ['water'], canCrossCliffs: false, blockedByUnits: 'none' }
  const portMovement: UnitMovement = { isMobile: false, terrains: [], canCrossCliffs: false }
  const content: UnitContent = {
    actionsByKind: {
      ship: [{ id: 'ship-income', name: 'Ship Income', description: '', effect: { actionType: 'income', goldByTerrain: { water: 3 } } }],
      port: [{ id: 'port-income', name: 'Port Income', description: '', effect: { actionType: 'income', goldByTerrain: { water: 5 } } }],
    },
    movementByKind: { ship: shipMovement, port: portMovement },
    terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: { ship: 10, port: 10 },
    companionKindsByCardKind: { ship: ['port'] },
    activationsPerTurnByKind: {},
  }

  function renderStacked() {
    const board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'water')
    const ship: Unit = { id: 'ship1', ownerId: 'p1', kind: 'ship', coord: { q: 0, r: 0 }, movement: shipMovement, traits: [] }
    const port: Unit = { id: 'port1', ownerId: 'p1', kind: 'port', coord: { q: 0, r: 0 }, movement: portMovement, traits: [] }

    const lobby = createNewGame({
      gameId: 'g',
      playMode: 'hotseat',
      board,
      players: [
        { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
      ],
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
    })
    // p2 never gets units here — this test only exercises p1's own
    // Ship/Port flow — so p2 is excluded up front (not in turnOrder,
    // marked eliminated) rather than left for beginSelectCardsPhase to
    // eliminate naturally: eliminatePlayer now ends the game outright once
    // only one player remains (elimination.ts), which would otherwise
    // complete the game before this test's own actions even run.
    const active: GameState = {
      ...lobby,
      board,
      units: [ship, port],
      status: 'active',
      turnOrder: ['p1'],
      players: lobby.players.map((p) => (p.id === 'p2' ? { ...p, eliminated: true } : p)),
    }
    const selecting = beginSelectCardsPhase(syncCardZonesWithBoard(active))
    const chosen = applyAction(selecting, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') }, content)
    if (!chosen.ok) throw new Error('setup failed: ' + chosen.error)

    const players: PlayerRow[] = [
      { id: 'p1', game_id: 'g', user_id: 'p1', display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#ef4444', is_active: true, joined_at: '', ready_for_version: 0 },
      { id: 'p2', game_id: 'g', user_id: 'p2', display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#3b82f6', is_active: true, joined_at: '', ready_for_version: 0 },
    ]

    const onResolveUnit = vi.fn()
    const { container } = render(
      <RoundView
        state={chosen.state}
        players={players}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={onResolveUnit}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )
    return { container, onResolveUnit }
  }

  it('clicking the shared hex opens one grouped menu offering both units\' actions, each labeled by kind', () => {
    const { container } = renderStacked()

    // Scoped to the board's own <svg> (identified by its background class)
    // since the player status sidebar also renders unit-icon <svg>s with
    // their own direct <polygon> children.
    const basePolygon = container.querySelector('svg.bg-neutral-950 > polygon')
    fireEvent.click(basePolygon!)

    const optionTexts = [...container.querySelectorAll('foreignObject div')].map((d) => d.textContent ?? '')
    expect(optionTexts.some((t) => t.includes('Ship') && t.includes('Ship Income'))).toBe(true)
    expect(optionTexts.some((t) => t.includes('Port') && t.includes('Port Income'))).toBe(true)
  })

  it("resolves the Port's own action against the Port, not the Ship, when picked from the grouped menu", () => {
    const { container, onResolveUnit } = renderStacked()

    fireEvent.click(container.querySelector('svg.bg-neutral-950 > polygon')!)
    const portOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.includes('Port Income'))
    expect(portOption).toBeTruthy()
    fireEvent.click(portOption!)

    expect(onResolveUnit).toHaveBeenCalledWith('port1', 'port-income')
  })

  it("resolves the Ship's own action against the Ship, not the Port, when picked from the same grouped menu", () => {
    const { container, onResolveUnit } = renderStacked()

    fireEvent.click(container.querySelector('svg.bg-neutral-950 > polygon')!)
    const shipOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.includes('Ship Income'))
    expect(shipOption).toBeTruthy()
    fireEvent.click(shipOption!)

    expect(onResolveUnit).toHaveBeenCalledWith('ship1', 'ship-income')
  })
})

describe('RoundView — supporting actions (issue #147)', () => {
  function renderSupportScenario() {
    const content = buildRealUnitContent()
    const board = setTile(
      setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 1, r: 0 }, 'forest'),
      { q: -1, r: 0 },
      'mountain',
    )
    // Builder Nomad wants Transform to City (costs 1 wood + 1 stone) but the
    // player has neither — two idle Nomads, one on Forest (produces wood),
    // one on Mountain (produces stone), can cover it between them.
    const builder: Unit = { id: 'builder', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const woodSupport: Unit = { id: 'woodSupport', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const stoneSupport: Unit = { id: 'stoneSupport', ownerId: 'p1', kind: 'nomad', coord: { q: -1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const state = beginActionsForUnits(content, board, [builder, woodSupport, stoneSupport], 'nomad')

    const players: PlayerRow[] = [makePlayerRow('p1', 'Alice', '#ef4444'), makePlayerRow('p2', 'Bob', '#3b82f6')]
    const onResolveUnit = vi.fn()
    const onResolveSupportedAction = vi.fn()
    const utils = render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={onResolveUnit}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={onResolveSupportedAction}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )
    return { ...utils, onResolveUnit, onResolveSupportedAction }
  }

  /** The SupportHint's status line is split across several JSX text nodes (unit kind, action name) — matched by its containing <p>'s full textContent instead of a single-node regex. */
  function findSupportHint(container: HTMLElement) {
    return [...container.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Not enough resources for'))
  }

  /** Every polygon hex, indexed the same way units were placed in renderSupportScenario: builder (0,0), woodSupport (1,0), stoneSupport (-1,0). */
  function boardPolygons(container: HTMLElement) {
    return container.querySelector('svg.bg-neutral-950')!.querySelectorAll(':scope > polygon')
  }

  it('shows an unaffordable-but-supportable action distinctly, and clicking it skips straight to support-unit picking (self-location transform has no separate target step) — no button panel, just a map hint', () => {
    const { container } = renderSupportScenario()

    const polygons = boardPolygons(container)
    // The builder Nomad is the first unit placed, hence the first hex polygon clicked.
    fireEvent.click(polygons[0])

    const transformOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.startsWith('Transform to City'))
    expect(transformOption).toBeTruthy()
    // Rendered with the distinct amber "supportable" treatment — a gold
    // border on the otherwise-normal box, not a full amber fill (issue
    // #224) — and a concise shortfall explainer at the bottom.
    expect(transformOption!.className).toContain('border-amber-500')
    expect(transformOption!.className).not.toContain('border-indigo-400')
    expect(transformOption!.className).not.toContain('bg-amber-950')
    expect(transformOption!.textContent).toContain('Short 1 Wood, 1 Stone')

    fireEvent.click(transformOption!)

    expect(findSupportHint(container)).toBeTruthy()
    // No candidate buttons or Confirm button — support units are picked by
    // clicking them highlighted on the map instead (issue #147 follow-up).
    expect(screen.queryByRole('button', { name: /Produce Resource/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('clicking each highlighted support unit on the map covers the shortfall incrementally, then auto-resolves once fully covered — no confirm step', () => {
    const { container, onResolveSupportedAction, onResolveUnit } = renderSupportScenario()

    const polygons = boardPolygons(container)
    fireEvent.click(polygons[0])
    const transformOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.startsWith('Transform to City'))
    fireEvent.click(transformOption!)

    // Only wood covered — stone still short, nothing submitted yet.
    fireEvent.click(polygons[1]) // woodSupport's hex
    expect(onResolveSupportedAction).not.toHaveBeenCalled()
    expect(findSupportHint(container)).toBeTruthy()

    // Covering stone too completes the shortfall — resolves immediately,
    // with no separate confirm click.
    fireEvent.click(polygons[2]) // stoneSupport's hex

    expect(onResolveUnit).not.toHaveBeenCalled()
    expect(onResolveSupportedAction).toHaveBeenCalledTimes(1)
    const [supportAssignments, primary] = onResolveSupportedAction.mock.calls[0]
    expect(supportAssignments).toEqual(
      expect.arrayContaining([
        { unitId: 'woodSupport', actionId: 'produce-resource' },
        { unitId: 'stoneSupport', actionId: 'produce-resource' },
      ]),
    )
    expect(supportAssignments).toHaveLength(2)
    expect(primary).toEqual({ unitId: 'builder', actionId: 'transform-to-city', target: undefined })
  })

  it('drops the yellow "could act" ring from every unit once support-unit picking starts, leaving only the teal support-candidate ring (issue #150)', () => {
    const { container } = renderSupportScenario()

    const polygons = boardPolygons(container)
    // Before picking an action, all three idle Nomads still show the yellow
    // "could act this turn" ring.
    expect(container.querySelectorAll('circle[stroke="#fbbf24"]')).toHaveLength(3)

    fireEvent.click(polygons[0])
    const transformOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.startsWith('Transform to City'))
    fireEvent.click(transformOption!)

    // Now in 'supporting' mode: the yellow ring should be gone from every
    // unit — including the builder itself and the two support candidates —
    // leaving only their teal supportCandidate ring as the pickable cue.
    expect(container.querySelectorAll('circle[stroke="#fbbf24"]')).toHaveLength(0)
    expect(container.querySelectorAll('circle[stroke="#2dd4bf"]')).toHaveLength(2)
  })

  it('clicking elsewhere on the board cancels the whole in-progress support pick without submitting anything', () => {
    const { container, onResolveSupportedAction, onResolveUnit } = renderSupportScenario()

    const polygons = boardPolygons(container)
    fireEvent.click(polygons[0])
    const transformOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.startsWith('Transform to City'))
    fireEvent.click(transformOption!)

    fireEvent.click(polygons[1]) // woodSupport's hex — partial coverage, still in progress
    expect(findSupportHint(container)).toBeTruthy()

    // Click a non-candidate hex — the builder's own hex isn't a support
    // candidate (findSupportCandidates excludes the acting unit itself).
    fireEvent.click(polygons[0])

    expect(findSupportHint(container)).toBeFalsy()
    expect(onResolveSupportedAction).not.toHaveBeenCalled()
    expect(onResolveUnit).not.toHaveBeenCalled()
  })

  it('does not highlight a candidate that could only produce a resource the player already has enough of (issue #147 follow-up)', () => {
    const content = buildRealUnitContent()
    const board = setTile(
      setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 1, r: 0 }, 'forest'),
      { q: -1, r: 0 },
      'mountain',
    )
    const builder: Unit = { id: 'builder', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const woodSupport: Unit = { id: 'woodSupport', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const stoneSupport: Unit = { id: 'stoneSupport', ownerId: 'p1', kind: 'nomad', coord: { q: -1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    let state = beginActionsForUnits(content, board, [builder, woodSupport, stoneSupport], 'nomad')
    // Transform to City costs 1 wood + 1 stone — the player already has the
    // 1 wood covered, so only stone is still short.
    state = { ...state, players: state.players.map((p) => (p.id === 'p1' ? { ...p, resources: { ...p.resources, wood: 1, stone: 0 } } : p)) }

    const players: PlayerRow[] = [makePlayerRow('p1', 'Alice', '#ef4444'), makePlayerRow('p2', 'Bob', '#3b82f6')]
    const onResolveSupportedAction = vi.fn()
    const { container } = render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={onResolveSupportedAction}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    const polygons = boardPolygons(container)
    fireEvent.click(polygons[0])
    const transformOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.startsWith('Transform to City'))
    fireEvent.click(transformOption!)
    expect(findSupportHint(container)).toBeTruthy()

    // Clicking the wood producer's hex isn't a needed candidate — treated
    // the same as clicking anywhere else not currently useful: cancels.
    fireEvent.click(polygons[1]) // woodSupport's hex
    expect(findSupportHint(container)).toBeFalsy()
    expect(onResolveSupportedAction).not.toHaveBeenCalled()

    // Re-enter support picking and confirm the stone producer alone
    // resolves it immediately, since stone was the only real shortfall.
    fireEvent.click(polygons[0])
    fireEvent.click([...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.startsWith('Transform to City'))!)
    fireEvent.click(polygons[2]) // stoneSupport's hex

    expect(onResolveSupportedAction).toHaveBeenCalledTimes(1)
    const [supportAssignments] = onResolveSupportedAction.mock.calls[0]
    expect(supportAssignments).toEqual([{ unitId: 'stoneSupport', actionId: 'produce-resource' }])
  })
})

describe('RoundView — history review overlay', () => {
  // The Prev/Next/slider bar and the "Review history"/"Show history"
  // buttons themselves live in GamePage.tsx (issue #261 follow-up — the bar
  // now reuses GamePage's own full-width, read-only-banner layout instead
  // of a cramped row squeezed next to a button, and the button moved there
  // with it). RoundView's own job is just: while `showHistory` is on, hide
  // every panel that would let `myPlayerId` act, and overlay whatever
  // `turnReview` events GamePage hands it onto the board it's given (which,
  // for "Show history", is already the real historical board state at that
  // point — see GamePage's `reviewState`/`turnHalos`).
  function renderWithReview(
    turnReview: TurnReview | null,
    showHistory: boolean,
    onExitHistory?: () => void,
    stateOverrides?: Partial<GameState>,
    showCardChoiceRecap = false,
  ) {
    const state = { ...makeState(), ...stateOverrides }
    state.board = setTile(state.board, { q: 0, r: 0 }, 'plain')
    state.units = [
      { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: { isMobile: true, terrains: [], canCrossCliffs: false }, traits: [] },
    ]
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    return render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={turnReview}
        showHistory={showHistory}
        showCardChoiceRecap={showCardChoiceRecap}
        onExitHistory={onExitHistory}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )
  }

  it('overlays a halo ring on a unit with a reviewed event, and shows its resource-delta as an icon+amount badge', () => {
    const turnReview: TurnReview = {
      events: [{ unitId: 'nomad_a', playerId: 'p1', type: 'produced', to: { q: 0, r: 0 }, resourceDelta: { wood: 2 } }],
      resourceDeltaByPlayerId: { p1: { gold: 0, wood: 2, stone: 0 } },
    }
    const { container } = renderWithReview(turnReview, true)

    // 'produced' halo colour (red, see HISTORY_HALO_COLOR in HexBoard.tsx).
    expect(container.querySelectorAll('circle[stroke="#ef4444"]')).toHaveLength(1)
    const label = container.querySelector('foreignObject')
    expect(label).not.toBeNull()
    expect(label!.querySelector('svg title')?.textContent).toBe('Wood')
    expect(label!.textContent).toContain('+2')
  })

  it('does not show halos, labels, or resource deltas when showHistory is off, even with a non-empty review', () => {
    const turnReview: TurnReview = {
      events: [{ unitId: 'nomad_a', playerId: 'p1', type: 'produced', to: { q: 0, r: 0 }, resourceDelta: { wood: 2 } }],
      resourceDeltaByPlayerId: { p1: { gold: 0, wood: 2, stone: 0 } },
    }
    const { container } = renderWithReview(turnReview, false)

    expect(container.querySelectorAll('circle[stroke="#ef4444"]')).toHaveLength(0)
    expect(container.querySelector('foreignObject')).toBeNull()
  })

  it('drops the yellow "could act" ring from own units while reviewing history, even though it is still the action phase underneath', () => {
    const content = buildRealUnitContent()
    const board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain')
    const unit: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const state = beginActionsForUnits(content, board, [unit], 'nomad')
    const players: PlayerRow[] = [makePlayerRow('p1', 'Alice', '#ef4444'), makePlayerRow('p2', 'Bob', '#3b82f6')]
    const turnReview: TurnReview = { events: [], resourceDeltaByPlayerId: {} }

    const doRender = (showHistory: boolean) =>
      render(
        <RoundView
          state={state}
          players={players}
          myPlayerId="p1"
          unitContent={content}
          achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
          taleContent={EMPTY_TALE_CONTENT}
          turnReview={turnReview}
          showHistory={showHistory}
          territoryControlMode="off"
          previousHistoryState={null}
          gameLog={[]}
          onChooseCard={() => {}}
          onResolveUnit={() => {}}
          onResolveBulkAction={() => {}}
          onResolveSupportedAction={() => {}}
          onPassActions={() => {}}
          onMoveToDecline={() => {}}
          onPurchaseCard={() => {}}
          onPassPurchase={() => {}}
        />,
      )

    const before = doRender(false)
    expect(before.container.querySelectorAll('circle[stroke="#fbbf24"]')).toHaveLength(1)
    before.unmount()

    const after = doRender(true)
    expect(after.container.querySelectorAll('circle[stroke="#fbbf24"]')).toHaveLength(0)
  })

  it("shows a resource delta suffix in the player's status once toggled on", () => {
    const turnReview: TurnReview = {
      events: [],
      resourceDeltaByPlayerId: { p1: { gold: 5, wood: -1, stone: 0 } },
    }
    renderWithReview(turnReview, true)
    expect(screen.getByText('(+5)')).toBeInTheDocument()
    expect(screen.getByText('(-1)')).toBeInTheDocument()
  })

  it('exits history review when the board is clicked (issue #285)', () => {
    const onExitHistory = vi.fn()
    const { container } = renderWithReview({ events: [], resourceDeltaByPlayerId: {} }, true, onExitHistory)

    const hex = container.querySelector('polygon[data-coord]')
    expect(hex).not.toBeNull()
    fireEvent.click(hex!)

    expect(onExitHistory).toHaveBeenCalledTimes(1)
  })

  it('does not treat board clicks as exiting history when showHistory is off', () => {
    const onExitHistory = vi.fn()
    const { container } = renderWithReview({ events: [], resourceDeltaByPlayerId: {} }, false, onExitHistory)

    const hex = container.querySelector('polygon[data-coord]')
    expect(hex).not.toBeNull()
    fireEvent.click(hex!)

    expect(onExitHistory).not.toHaveBeenCalled()
  })

  // Whether the recap should appear at all for a given review point (never
  // mid-pick, only at the first stop that shows a completed phase — issue
  // #316, refined by #326) is GamePage's call now — see
  // engine/turnReview.ts's `shouldShowCardChoiceRecap` and its own tests.
  // RoundView's job is just to honour `showCardChoiceRecap` as told.
  it('shows no card-choice recap when showCardChoiceRecap is left at its default (false), even while reviewing history', () => {
    renderWithReview({ events: [], resourceDeltaByPlayerId: {} }, true)

    expect(screen.queryByText('Played cards:')).not.toBeInTheDocument()
    expect(screen.queryByText(/still choosing/)).not.toBeInTheDocument()
  })

  it("shows a summary of every eligible player's card choice, with icons and player-coloured names, when told to (issue #316)", () => {
    renderWithReview(
      { events: [], resourceDeltaByPlayerId: {} },
      true,
      undefined,
      {
        roundPhase: 'actions',
        chosenCardIdByPlayerId: { p1: cardIdFor('p1', 'nomad'), p2: cardIdFor('p2', 'city') },
        pendingPlayerIds: ['p1', 'p2'],
        activePlayerId: 'p1',
      },
      true,
    )

    expect(screen.getByText('Played cards:')).toBeInTheDocument()
    expect(screen.queryByText('Your turn — choose a card to play.')).not.toBeInTheDocument()

    const alice = screen.getByText('Alice:')
    expect(alice.style.color).toBe('rgb(255, 0, 0)')
    const bob = screen.getByText('Bob:')
    expect(bob.style.color).toBe('rgb(0, 0, 255)')

    expect(screen.getByTitle('Nomad')).toBeInTheDocument()
    expect(screen.getByTitle('City')).toBeInTheDocument()
  })

  it('shows the interactive card picker, not the read-only history recap, during live play (issue #314)', () => {
    renderWithReview({ events: [], resourceDeltaByPlayerId: {} }, false)

    expect(screen.getByText('Your turn — choose a card to play.')).toBeInTheDocument()
    expect(screen.queryByText('Played cards:')).not.toBeInTheDocument()
  })

  it("splits the purchase-phase recap into what's been purchased back and what's been declined this round, with every player in a single row (issue #317)", () => {
    const purchasedCardId = cardIdFor('p1', 'mountaineer')
    const declinedCardId = cardIdFor('p2', 'city')
    renderWithReview(
      { events: [], resourceDeltaByPlayerId: {} },
      true,
      undefined,
      {
        roundPhase: 'purchase',
        pendingPlayerIds: ['p2'],
        activePlayerId: 'p2',
        turn: 1,
        actionHistory: [
          { action: { type: 'PURCHASE_CARD', playerId: 'p1', cardId: purchasedCardId }, turn: 1, timestamp: '' },
          { action: { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: declinedCardId }, turn: 1, timestamp: '' },
        ],
        players: [
          { ...makeEnginePlayer('p1', ['nomad', 'ship']), declineCardIds: [] },
          { ...makeEnginePlayer('p2', ['city']), declineCardIds: [declinedCardId] },
        ],
      },
      true,
    )

    expect(screen.getByText('Purchased cards:')).toBeInTheDocument()
    expect(screen.getByText('Declined cards:')).toBeInTheDocument()

    // Both sections lay every player out in one flex-wrap row, not a stacked list.
    const purchasedRow = screen.getByText('Purchased cards:').nextElementSibling as HTMLElement
    expect(purchasedRow.className).toContain('flex-wrap')
    expect(purchasedRow.children).toHaveLength(2)
    const declinedRow = screen.getByText('Declined cards:').nextElementSibling as HTMLElement
    expect(declinedRow.className).toContain('flex-wrap')
    expect(declinedRow.children).toHaveLength(2)

    // p1 bought a Mountaineer back this phase; p2 chose to decline their City this round.
    expect(within(purchasedRow).getByTitle('Mountaineer')).toBeInTheDocument()
    expect(within(declinedRow).getByTitle('City')).toBeInTheDocument()
  })

  it('shows "none" for a player who declined nothing this round, and ignores an earlier round\'s leftover decline pile (issue #317)', () => {
    const oldDeclineCardId = cardIdFor('p1', 'ship')
    renderWithReview(
      { events: [], resourceDeltaByPlayerId: {} },
      true,
      undefined,
      {
        roundPhase: 'purchase',
        pendingPlayerIds: ['p2'],
        activePlayerId: 'p2',
        turn: 2,
        // Logged on an earlier round — still sitting in p1's decline zone (never bought back),
        // but shouldn't be reported as something p1 chose to decline *this* round.
        actionHistory: [{ action: { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: oldDeclineCardId }, turn: 1, timestamp: '' }],
        players: [
          { ...makeEnginePlayer('p1', ['nomad', 'ship']), declineCardIds: [oldDeclineCardId] },
          { ...makeEnginePlayer('p2', ['city']), declineCardIds: [] },
        ],
      },
      true,
    )

    const declinedRow = screen.getByText('Declined cards:').nextElementSibling as HTMLElement
    expect(within(declinedRow).getAllByText('none')).toHaveLength(2)
    expect(within(declinedRow).queryByTitle('Ship')).not.toBeInTheDocument()
  })

  it('still reports a card as declined this round even after it is bought back later in the same purchase phase (issue #317)', () => {
    const cardId = cardIdFor('p2', 'city')
    renderWithReview(
      { events: [], resourceDeltaByPlayerId: {} },
      true,
      undefined,
      {
        roundPhase: 'purchase',
        pendingPlayerIds: ['p2'],
        activePlayerId: 'p2',
        turn: 1,
        actionHistory: [
          { action: { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId }, turn: 1, timestamp: '' },
          { action: { type: 'PURCHASE_CARD', playerId: 'p2', cardId }, turn: 1, timestamp: '' },
        ],
        players: [
          { ...makeEnginePlayer('p1', ['nomad', 'ship']), declineCardIds: [] },
          { ...makeEnginePlayer('p2', ['city']), declineCardIds: [] },
        ],
      },
      true,
    )

    const purchasedRow = screen.getByText('Purchased cards:').nextElementSibling as HTMLElement
    expect(within(purchasedRow).getByTitle('City')).toBeInTheDocument()
    const declinedRow = screen.getByText('Declined cards:').nextElementSibling as HTMLElement
    expect(within(declinedRow).getByTitle('City')).toBeInTheDocument()
  })

  it("still reports what was purchased/declined once finishRound has already chained the replayed state into the next round's selectCards phase (issue #326's second follow-up)", () => {
    const purchasedCardId = cardIdFor('p1', 'mountaineer')
    const declinedCardId = cardIdFor('p2', 'city')
    renderWithReview(
      { events: [], resourceDeltaByPlayerId: {} },
      true,
      undefined,
      {
        // finishRound increments `turn` and moves straight into the next
        // round's selectCards the instant the last purchase/decline action
        // lands (round.ts) — so the collapsed declinePurchase review stop
        // being recapped here genuinely replays with roundPhase 'selectCards'
        // and turn one ahead of the actions being recapped.
        roundPhase: 'selectCards',
        chosenCardIdByPlayerId: { p1: null, p2: null },
        pendingPlayerIds: ['p1', 'p2'],
        activePlayerId: null,
        turn: 2,
        actionHistory: [
          { action: { type: 'PURCHASE_CARD', playerId: 'p1', cardId: purchasedCardId }, turn: 1, timestamp: '' },
          { action: { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: declinedCardId }, turn: 1, timestamp: '' },
        ],
        players: [
          { ...makeEnginePlayer('p1', ['nomad', 'ship']), declineCardIds: [] },
          { ...makeEnginePlayer('p2', ['city']), declineCardIds: [declinedCardId] },
        ],
      },
      true,
    )

    expect(screen.getByText('Purchased cards:')).toBeInTheDocument()
    expect(screen.getByText('Declined cards:')).toBeInTheDocument()
    const purchasedRow = screen.getByText('Purchased cards:').nextElementSibling as HTMLElement
    expect(within(purchasedRow).getByTitle('Mountaineer')).toBeInTheDocument()
    const declinedRow = screen.getByText('Declined cards:').nextElementSibling as HTMLElement
    expect(within(declinedRow).getByTitle('City')).toBeInTheDocument()
  })
})

describe('RoundView — territory control overlay (issue #281)', () => {
  const players = [makePlayerRow('p1', 'Alice', '#ef4444'), makePlayerRow('p2', 'Bob', '#3b82f6')]

  function renderTerritory(
    territoryControlMode: 'off' | 'on' | 'changes',
    opts: { showHistory?: boolean; state?: GameState; previousHistoryState?: GameState | null; achievementContent?: typeof EMPTY_ACHIEVEMENT_CONTENT } = {},
  ) {
    const state = opts.state ?? makeState()
    return render(
      <RoundView
        state={state}
        players={players}
        myPlayerId={null}
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={opts.achievementContent ?? EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={opts.showHistory ?? true}
        territoryControlMode={territoryControlMode}
        previousHistoryState={opts.previousHistoryState ?? null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )
  }

  function stateWithUnitAt(ownerId: string): GameState {
    const state = makeState()
    state.board = setTile(state.board, { q: 0, r: 0 }, 'plain')
    state.units = [{ id: 'u1', ownerId, kind: 'nomad', coord: { q: 0, r: 0 }, movement: { isMobile: true, terrains: [], canCrossCliffs: false }, traits: [] }]
    return state
  }

  it('renders no territory borders in "off" mode, even while reviewing history', () => {
    const { container } = renderTerritory('off', { state: stateWithUnitAt('p1') })
    expect(container.querySelectorAll('line[stroke="#ef4444"]')).toHaveLength(0)
  })

  it('renders no territory borders in any mode outside history review', () => {
    const { container } = renderTerritory('on', { showHistory: false, state: stateWithUnitAt('p1') })
    expect(container.querySelectorAll('line[stroke="#ef4444"]')).toHaveLength(0)
  })

  it('outlines every currently-controlled region in "on" mode, in its owner\'s colour', () => {
    const { container } = renderTerritory('on', { state: stateWithUnitAt('p1') })
    expect(container.querySelectorAll('line[stroke="#ef4444"]').length).toBeGreaterThan(0)
  })

  it('shows nothing in "changes" mode when there is no previous state to diff against', () => {
    const { container } = renderTerritory('changes', { state: stateWithUnitAt('p1'), previousHistoryState: null })
    expect(container.querySelectorAll('line[stroke="#ef4444"]')).toHaveLength(0)
  })

  it('outlines only a region whose owner actually changed in "changes" mode, in its new owner\'s colour', () => {
    const previousHistoryState = stateWithUnitAt('p1')
    const currentState = stateWithUnitAt('p2')
    const { container } = renderTerritory('changes', { state: currentState, previousHistoryState })

    expect(container.querySelectorAll('line[stroke="#3b82f6"]').length).toBeGreaterThan(0) // p2's colour, the new owner
    expect(container.querySelectorAll('line[stroke="#ef4444"]')).toHaveLength(0) // p1 no longer controls it
  })

  it('outlines a region that turned neutral with black-and-white stripes, in "changes" mode', () => {
    const previousHistoryState = stateWithUnitAt('p1')
    const currentState = stateWithUnitAt('p1')
    currentState.units = [] // the region has no units at all any more — no majority owner

    const { container } = renderTerritory('changes', { state: currentState, previousHistoryState })

    const stripedLines = container.querySelectorAll('line[data-striped="true"]')
    expect(stripedLines.length).toBeGreaterThan(0)
    expect(container.querySelectorAll('line[stroke="#ef4444"]')).toHaveLength(0)

    // Every striped line's stroke points at a <pattern> (not a flat colour), and that pattern
    // actually alternates black and white rather than being some other placeholder shape.
    for (const line of stripedLines) {
      const strokeUrl = line.getAttribute('stroke') ?? ''
      expect(strokeUrl).toMatch(/^url\(#.+\)$/)
      const patternId = strokeUrl.slice('url(#'.length, -1)
      const pattern = container.querySelector(`pattern#${CSS.escape(patternId)}`)
      expect(pattern).not.toBeNull()
      const fills = [...(pattern?.querySelectorAll('rect') ?? [])].map((r) => r.getAttribute('fill'))
      expect(fills).toEqual(expect.arrayContaining(['#000000', '#ffffff']))
    }
  })

  it('shows nothing in "changes" mode for a region whose owner did not change', () => {
    const previousHistoryState = stateWithUnitAt('p1')
    const currentState = stateWithUnitAt('p1')
    const { container } = renderTerritory('changes', { state: currentState, previousHistoryState })

    expect(container.querySelectorAll('line[stroke="#ef4444"]')).toHaveLength(0)
  })

  it("scales a changed territory's border width against every territory on the board, not just the ones that changed", () => {
    const achievementContent = { ...EMPTY_ACHIEVEMENT_CONTENT, terrainVictoryPoints: { plain: 1, mountain: 10 } }
    const move = { isMobile: true, terrains: [], canCrossCliffs: false }

    const previousHistoryState = makeState()
    previousHistoryState.board = setTile(setTile(previousHistoryState.board, { q: 0, r: 0 }, 'plain'), { q: 5, r: 0 }, 'mountain')
    previousHistoryState.units = [
      { id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: move, traits: [] },
      { id: 'u2', ownerId: 'p1', kind: 'nomad', coord: { q: 5, r: 0 }, movement: move, traits: [] },
    ]

    const currentState = makeState()
    currentState.board = previousHistoryState.board
    currentState.units = [
      { id: 'u1', ownerId: 'p2', kind: 'nomad', coord: { q: 0, r: 0 }, movement: move, traits: [] }, // changed hands: p1 -> p2, worth 1pt
      { id: 'u2', ownerId: 'p1', kind: 'nomad', coord: { q: 5, r: 0 }, movement: move, traits: [] }, // unchanged, but worth far more (10pt)
    ]

    const { container } = renderTerritory('changes', { state: currentState, previousHistoryState, achievementContent })

    // The changed 1pt plain hex is the only entry in "changes" mode's own
    // territoryControl — scaled only against itself it'd fall back to the
    // fixed mid-range width. It should instead scale against the board's
    // real 1..10 range (set by the untouched 10pt mountain region), landing
    // at the thinnest end.
    const width = Number(container.querySelector('line[stroke="#3b82f6"]')!.getAttribute('stroke-width')) // p2's colour
    const size = 22 // HexBoard's default `size` prop
    expect(width).toBeCloseTo(size * 0.05)
  })
})

describe('RoundView — map indicator for a unit\'s card zone (issue #305)', () => {
  function renderWithUnits(state: GameState) {
    const players: PlayerRow[] = [makePlayerRow('p1', 'Alice', '#ef4444'), makePlayerRow('p2', 'Bob', '#3b82f6')]
    return render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )
  }

  const move = { isMobile: true, terrains: [], canCrossCliffs: false }

  const HAND_PLATE_COLOR = '#fef3c7'
  const SELECTED_PLATE_COLOR = '#fde68a'
  const DISCARD_PLATE_COLOR = '#f2f2ef'

  it("fills the plate a light gold on the map for a unit whose card is in the owner's hand", () => {
    const state = makeState() // p1's hand is ['nomad', 'ship'] (see makeEnginePlayer)
    state.board = setTile(state.board, { q: 0, r: 0 }, 'plain')
    state.units = [{ id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: move, traits: [] }]

    const { container } = renderWithUnits(state)

    expect(container.querySelectorAll(`circle[fill="${HAND_PLATE_COLOR}"]`)).toHaveLength(1)
  })

  it("fills the plate the (darker) selected gold once the actions phase reveals the round's chosen card, even though it's still technically in the 'hand' CardZone until the owner's turn resolves it (issue #311 follow-up)", () => {
    const state = makeState() // p1's hand is ['nomad', 'ship']
    state.board = setTile(state.board, { q: 0, r: 0 }, 'plain')
    state.roundPhase = 'actions'
    state.chosenCardIdByPlayerId = { p1: cardIdFor('p1', 'nomad'), p2: null }
    state.units = [{ id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: move, traits: [] }]

    const { container } = renderWithUnits(state)

    expect(container.querySelectorAll(`circle[fill="${SELECTED_PLATE_COLOR}"]`)).toHaveLength(1)
    expect(container.querySelectorAll(`circle[fill="${HAND_PLATE_COLOR}"]`)).toHaveLength(0)
  })

  it("doesn't reveal the round's chosen card as selected during the secret selectCards phase — same secrecy as PlayerSidebar's own 'Playing' badge", () => {
    const state = makeState() // roundPhase defaults to 'selectCards'
    state.board = setTile(state.board, { q: 0, r: 0 }, 'plain')
    state.chosenCardIdByPlayerId = { p1: cardIdFor('p1', 'nomad'), p2: null }
    state.units = [{ id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: move, traits: [] }]

    const { container } = renderWithUnits(state)

    expect(container.querySelectorAll(`circle[fill="${SELECTED_PLATE_COLOR}"]`)).toHaveLength(0)
    expect(container.querySelectorAll(`circle[fill="${HAND_PLATE_COLOR}"]`)).toHaveLength(1)
  })

  it("shows a previous player's already-resolved pick as discard, not selected, once their turn has passed (their chosen card id is still recorded, but finishActionsTurn already moved the card to discard)", () => {
    const state = makeState()
    state.board = setTile(state.board, { q: 0, r: 0 }, 'plain')
    state.roundPhase = 'actions'
    state.chosenCardIdByPlayerId = { p1: cardIdFor('p1', 'nomad'), p2: null }
    const p1 = state.players.find((p) => p.id === 'p1')!
    p1.handCardIds = p1.handCardIds.filter((id) => id !== cardIdFor('p1', 'nomad'))
    p1.discardCardIds = [cardIdFor('p1', 'nomad')]
    state.units = [{ id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: move, traits: [] }]

    const { container } = renderWithUnits(state)

    expect(container.querySelectorAll(`circle[fill="${DISCARD_PLATE_COLOR}"]`)).toHaveLength(1)
    expect(container.querySelectorAll(`circle[fill="${SELECTED_PLATE_COLOR}"]`)).toHaveLength(0)
  })

  it("greys out the glyph for a unit whose card has been moved to decline, and draws no gold plate", () => {
    const state = makeState()
    state.board = setTile(state.board, { q: 0, r: 0 }, 'plain')
    const p1 = state.players.find((p) => p.id === 'p1')!
    // Move the Nomad card from hand to decline, matching moveCard's effect
    // (see cards.ts) without needing the rest of the decline-phase machinery.
    p1.handCardIds = p1.handCardIds.filter((id) => id !== cardIdFor('p1', 'nomad'))
    p1.declineCardIds = [cardIdFor('p1', 'nomad')]
    state.units = [{ id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: move, traits: [] }]

    const { container } = renderWithUnits(state)

    expect(container.querySelectorAll(`[fill="${HAND_PLATE_COLOR}"]`)).toHaveLength(0)
    expect(container.querySelectorAll('[fill="#9ca3af"]').length).toBeGreaterThan(0)
  })

  it('shows no gold plate and no grey glyph for a unit whose card is in discard', () => {
    const state = makeState()
    state.board = setTile(state.board, { q: 0, r: 0 }, 'plain')
    const p1 = state.players.find((p) => p.id === 'p1')!
    p1.handCardIds = p1.handCardIds.filter((id) => id !== cardIdFor('p1', 'nomad'))
    p1.discardCardIds = [cardIdFor('p1', 'nomad')]
    state.units = [{ id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: move, traits: [] }]

    const { container } = renderWithUnits(state)

    expect(container.querySelectorAll(`[fill="${HAND_PLATE_COLOR}"]`)).toHaveLength(0)
    expect(container.querySelectorAll('[fill="#9ca3af"]')).toHaveLength(0)
  })

  it('threads a custom unitPlateColors prop down to the board instead of the defaults (profile customization, issue #311 follow-up)', () => {
    const state = makeState() // p1's hand is ['nomad', 'ship']
    state.board = setTile(state.board, { q: 0, r: 0 }, 'plain')
    state.units = [{ id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: move, traits: [] }]
    const players: PlayerRow[] = [makePlayerRow('p1', 'Alice', '#ef4444'), makePlayerRow('p2', 'Bob', '#3b82f6')]

    const { container } = render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        unitPlateColors={{ hand: '#123456', selected: '#654321', discard: '#abcdef' }}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(container.querySelectorAll('circle[fill="#123456"]')).toHaveLength(1)
    expect(container.querySelectorAll(`circle[fill="${HAND_PLATE_COLOR}"]`)).toHaveLength(0)
  })
})

describe('RoundView — LogPanel (issue #358)', () => {
  it("resolves a log entry's {player} placeholder to the player's name/colour and shows a minute-resolution timestamp, never the raw guid", () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        isAdmin
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[{ id: 'evt_1', turn: 1, playerId: 'p1', message: '{player} chose to play Nomad', timestamp: '2026-08-28T14:32:00.000Z' }]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    const logEntry = screen.getByText('chose to play Nomad', { exact: false }).closest('p')!
    expect(logEntry.textContent).not.toContain('p1')
    const nameSpan = within(logEntry).getByText('Alice')
    expect(nameSpan.style.color).toBe('rgb(255, 0, 0)')
    // Wall-clock timestamp shown at minute resolution — no seconds.
    expect(within(logEntry).getByText(/^\[\d{1,2}:\d{2}(\s?[AP]M)?\]\s*$/)).toBeTruthy()
  })

  it('hides the log panel entirely for non-admins', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        isAdmin={false}
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        taleContent={EMPTY_TALE_CONTENT}
        turnReview={null}
        showHistory={false}
        territoryControlMode="off"
        previousHistoryState={null}
        gameLog={[{ id: 'evt_1', turn: 1, playerId: 'p1', message: '{player} chose to play Nomad', timestamp: '2026-08-28T14:32:00.000Z' }]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onResolveBulkAction={() => {}}
        onResolveSupportedAction={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(screen.queryByText('chose to play Nomad', { exact: false })).toBeNull()
  })
})
