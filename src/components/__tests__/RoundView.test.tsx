import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RoundView } from '../RoundView'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../../engine/achievementContent'
import { applyAction } from '../../engine/applyAction'
import { createEmptyBoard, setTile } from '../../engine/board'
import { cardIdFor, createPlayerCards, syncCardZonesWithBoard } from '../../engine/cards'
import { createNewGame } from '../../engine/createGame'
import { beginSelectCardsPhase } from '../../engine/round'
import type { GameState, Player, Resources, Unit, UnitMovement } from '../../engine/types'
import type { TurnReview } from '../../engine/turnReview'
import { EMPTY_UNIT_CONTENT } from '../../engine/unitContent'
import type { UnitAction, UnitContent } from '../../engine/unitContent'
import type { PlayerRow } from '../../lib/dbTypes'
import unitsJson from '../../content/units.json'
import terrainJson from '../../content/terrain.json'
import resourcesJson from '../../content/resources.json'

function makePlayerRow(id: string, displayName: string, color: string): PlayerRow {
  return { id, game_id: 'g1', user_id: id, display_name: displayName, avatar_url: null, seat_index: 0, color, is_active: true, joined_at: '' }
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
    // ...with the remaining, upcoming prices shown alongside it.
    expect(screen.getByText('— next: 10 → 20 gold')).toBeInTheDocument()
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
    expect(screen.getByText('Gold 5, Wood 2, Stone 1')).toBeInTheDocument()
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
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
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
  return { actionsByKind, movementByKind, terrainLevels, resourceCaps, unitSupplyCaps, companionKindsByCardKind: {} }
}

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
      { id: 'p1', game_id: 'g', user_id: 'p1', display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#ef4444', is_active: true, joined_at: '' },
      { id: 'p2', game_id: 'g', user_id: 'p2', display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#3b82f6', is_active: true, joined_at: '' },
    ]

    const onResolveUnit = vi.fn()
    const { container } = render(
      <RoundView
        state={chosen.state}
        players={players}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={onResolveUnit}
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

    const convertOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent === 'Convert to Merchant')
    expect(convertOption).toBeTruthy()
    fireEvent.click(convertOption!)

    // Selecting the action must enter targeting mode — the legal (adjacent,
    // own-Nomad) hex highlighted green — not resolve immediately.
    expect(onResolveUnit).not.toHaveBeenCalled()
    expect(container.querySelectorAll('polygon[fill="rgba(34,197,94,0.25)"]')).toHaveLength(1)

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
      { id: 'p1', game_id: 'g', user_id: 'p1', display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#ef4444', is_active: true, joined_at: '' },
      { id: 'p2', game_id: 'g', user_id: 'p2', display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#3b82f6', is_active: true, joined_at: '' },
    ]

    const onResolveUnit = vi.fn()
    const { container } = render(
      <RoundView
        state={chosen.state}
        players={players}
        myPlayerId="p1"
        unitContent={content}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        turnReview={null}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={onResolveUnit}
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

    const basePolygon = container.querySelector('svg > polygon')
    fireEvent.click(basePolygon!)

    const optionTexts = [...container.querySelectorAll('foreignObject div')].map((d) => d.textContent ?? '')
    expect(optionTexts.some((t) => t.includes('Ship') && t.includes('Ship Income'))).toBe(true)
    expect(optionTexts.some((t) => t.includes('Port') && t.includes('Port Income'))).toBe(true)
  })

  it("resolves the Port's own action against the Port, not the Ship, when picked from the grouped menu", () => {
    const { container, onResolveUnit } = renderStacked()

    fireEvent.click(container.querySelector('svg > polygon')!)
    const portOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.includes('Port Income'))
    expect(portOption).toBeTruthy()
    fireEvent.click(portOption!)

    expect(onResolveUnit).toHaveBeenCalledWith('port1', 'port-income')
  })

  it("resolves the Ship's own action against the Ship, not the Port, when picked from the same grouped menu", () => {
    const { container, onResolveUnit } = renderStacked()

    fireEvent.click(container.querySelector('svg > polygon')!)
    const shipOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.includes('Ship Income'))
    expect(shipOption).toBeTruthy()
    fireEvent.click(shipOption!)

    expect(onResolveUnit).toHaveBeenCalledWith('ship1', 'ship-income')
  })
})

describe('RoundView — history review toggle', () => {
  function renderWithReview(turnReview: TurnReview | null, showHistory: boolean, onToggleHistory: () => void = () => {}) {
    const state = makeState()
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
        turnReview={turnReview}
        showHistory={showHistory}
        onToggleHistory={onToggleHistory}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )
  }

  it('disables the history button only when a review could not be computed at all — not merely because nothing happened (bug: whoever acted last in a round found the button disabled the moment the next round\'s choose-card phase began, since their own last action was the reviewed window\'s empty endpoint)', () => {
    const { rerender } = renderWithReview(null, false)
    expect(screen.getByRole('button', { name: 'Show history' })).toBeDisabled() // no review at all (e.g. genesis mismatch)

    rerender(
      <RoundView
        state={makeState()}
        players={[makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        turnReview={{ events: [], resourceDeltaByPlayerId: {} }}
        showHistory={false}
        onToggleHistory={() => {}}
        gameLog={[]}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )
    // A real, empty review (nothing happened since I last acted) is still
    // clickable — that's an honest "nothing to show," not "review broken."
    expect(screen.getByRole('button', { name: 'Show history' })).not.toBeDisabled()
  })

  it('shows a "nothing since your last turn" hint once toggled on with an empty review, instead of silently doing nothing', () => {
    renderWithReview({ events: [], resourceDeltaByPlayerId: {} }, true)
    expect(screen.getByText('Nothing since your last turn.')).toBeInTheDocument()
  })

  it('calls onToggleHistory when clicked, and shows "Hide history" once toggled on', () => {
    const onToggleHistory = vi.fn()
    const turnReview: TurnReview = {
      events: [{ unitId: 'nomad_a', playerId: 'p1', type: 'produced', to: { q: 0, r: 0 }, resourceDelta: { wood: 2 } }],
      resourceDeltaByPlayerId: { p1: { gold: 0, wood: 2, stone: 0 } },
    }
    renderWithReview(turnReview, false, onToggleHistory)
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    expect(onToggleHistory).toHaveBeenCalledOnce()

    renderWithReview(turnReview, true, onToggleHistory)
    expect(screen.getByRole('button', { name: 'Hide history' })).toBeInTheDocument()
  })

  it('overlays a halo ring on a unit with a reviewed event, and shows its resource-delta label', () => {
    const turnReview: TurnReview = {
      events: [{ unitId: 'nomad_a', playerId: 'p1', type: 'produced', to: { q: 0, r: 0 }, resourceDelta: { wood: 2 } }],
      resourceDeltaByPlayerId: { p1: { gold: 0, wood: 2, stone: 0 } },
    }
    const { container } = renderWithReview(turnReview, true)

    // 'produced' halo colour (red, see HISTORY_HALO_COLOR in HexBoard.tsx).
    expect(container.querySelectorAll('circle[stroke="#ef4444"]')).toHaveLength(1)
    expect(screen.getByText('+2 Wood')).toBeInTheDocument()
  })

  it('does not show halos, labels, or resource deltas when showHistory is off, even with a non-empty review', () => {
    const turnReview: TurnReview = {
      events: [{ unitId: 'nomad_a', playerId: 'p1', type: 'produced', to: { q: 0, r: 0 }, resourceDelta: { wood: 2 } }],
      resourceDeltaByPlayerId: { p1: { gold: 0, wood: 2, stone: 0 } },
    }
    const { container } = renderWithReview(turnReview, false)

    expect(container.querySelectorAll('circle[stroke="#ef4444"]')).toHaveLength(0)
    expect(screen.queryByText('+2 Wood')).not.toBeInTheDocument()
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
})
