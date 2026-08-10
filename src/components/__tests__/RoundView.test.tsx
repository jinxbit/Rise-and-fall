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
    turnOrder: ['p1', 'p2'],
    board: createEmptyBoard('hex'),
    players: [p1, p2],
    units: [],
    cards,
    resourceBank: { gold: 100, wood: 100, stone: 100 },
    unitLimits: {},
    log: [],
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
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(screen.getByText('Hand: Nomad, Ship')).toBeInTheDocument()
    expect(screen.getByText('Hand: City')).toBeInTheDocument()
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
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // A claimed achievement shows who claimed it...
    expect(screen.getByText(/City Mastery.*Bob/)).toBeInTheDocument()
    // ...an unclaimed one says so...
    expect(screen.getByText(/Ship Mastery.*unclaimed/)).toBeInTheDocument()
    // ...and the buyback price reflects the one achievement claimed so far (index 0 of the table).
    expect(screen.getByText('5 gold')).toBeInTheDocument()
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
  return { actionsByKind, movementByKind, terrainLevels, resourceCaps, unitSupplyCaps }
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
    let active: GameState = { ...lobby, board, units: [city, nomad], status: 'active' }
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
    const basePolygons = container.querySelectorAll('svg > polygon')
    fireEvent.click(basePolygons[0])

    const convertOption = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent === 'Convert to Merchant')
    expect(convertOption).toBeTruthy()
    fireEvent.click(convertOption!)

    // Selecting the action must enter targeting mode — a ghost dot over the
    // legal (adjacent, own-Nomad) hex — not resolve immediately.
    expect(onResolveUnit).not.toHaveBeenCalled()
    expect(container.querySelectorAll('circle[fill="#ffffff"]')).toHaveLength(1)

    fireEvent.click(container.querySelectorAll('svg > polygon')[1])

    expect(onResolveUnit).toHaveBeenCalledWith('city1', 'create-merchant', { q: 1, r: 0 })
  })
})
