import { beforeEach, describe, expect, it } from 'vitest'
import { applyAction, applyActionAndFastForwardTiles } from '../applyAction'
import { createEmptyBoard, getTile, setTile } from '../board'
import type { BoardGenerationContent } from '../boardGenerationContent'
import { EMPTY_BOARD_GENERATION_CONTENT } from '../boardGenerationContent'
import { cardIdFor, syncCardZonesWithBoard } from '../cards'
import { createNewGame, startGame } from '../createGame'
import { beginSelectCardsPhase } from '../round'
import type { Coordinate, GameState, Unit } from '../types'
import { EMPTY_UNIT_CONTENT } from '../unitContent'
import type { UnitContent } from '../unitContent'

let placeholderUnitCounter = 0
function nextPlaceholderUnitId(): string {
  placeholderUnitCounter += 1
  return `test_unit_${placeholderUnitCounter}`
}

/**
 * A quick, self-contained way to get an active game for testing round
 * mechanics (CHOOSE_CARD, RESOLVE_UNIT_ACTION, etc.) — places units
 * directly rather than driving through the real board-setup flow (tested
 * on its own in boardSetup.test.ts). This is NOT what startGame() does
 * anymore — see the 'createNewGame / startGame' describe block below for
 * that — it's purely a test fixture for the describe('applyAction', ...)
 * block underneath, which cares about round mechanics, not board setup.
 */
function makeActiveGame(): GameState {
  const lobby = createNewGame({
    gameId: 'game_1',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
    ],
  })

  const startingPositions: Record<string, Coordinate> = { p1: { q: 0, r: 0 }, p2: { q: 5, r: 0 } }
  let board = lobby.board
  const units: Unit[] = []
  for (const player of lobby.players) {
    const coord = startingPositions[player.id]
    board = setTile(board, coord, 'plain')
    units.push(
      {
        id: nextPlaceholderUnitId(),
        ownerId: player.id,
        kind: 'settlement',
        coord,
        movement: { isMobile: false, terrains: [], canCrossCliffs: false },
        traits: ['settlement'],
      },
      {
        id: nextPlaceholderUnitId(),
        ownerId: player.id,
        kind: 'mobile-unit',
        coord,
        movement: { isMobile: true, terrains: ['plain'], canCrossCliffs: false, moveDistance: 1 },
        traits: ['mobile'],
      },
      {
        id: nextPlaceholderUnitId(),
        ownerId: player.id,
        kind: 'ship',
        coord,
        movement: { isMobile: true, terrains: ['water'], canCrossCliffs: false, moveDistance: 1 },
        traits: ['ship'],
      },
    )
  }

  const active: GameState = { ...lobby, board, units, status: 'active' }
  return beginSelectCardsPhase(syncCardZonesWithBoard(active))
}

describe('createNewGame / startGame', () => {
  it('starts in lobby status with no units', () => {
    const lobby = createNewGame({
      gameId: 'game_1',
      playMode: 'live',
      board: createEmptyBoard('hex'),
      players: [{ id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' }],
    })
    expect(lobby.status).toBe('lobby')
    expect(lobby.units).toHaveLength(0)
  })

  it('delegates to the real board-setup procedure (beginBoardSetup)', () => {
    const lobby = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board: createEmptyBoard('hex'),
      players: [
        { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      ],
    })
    const content: BoardGenerationContent = { startingWaterShapeCells: [{ q: 0, r: 0 }, { q: 1, r: 0 }], tiers: [] }

    const state = startGame(lobby, content)

    expect(state.status).toBe('boardSetup')
    // 2 players -> one interlocked pair of the shape seeded onto the board.
    expect(Object.keys(state.board.tiles)).toHaveLength(4)
  })

  it('throws when starting a game that is not in the lobby', () => {
    const lobby = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board: createEmptyBoard('hex'),
      players: [{ id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' }],
    })
    const active: GameState = { ...lobby, status: 'active' }
    expect(() => startGame(active, EMPTY_BOARD_GENERATION_CONTENT)).toThrow()
  })
})

describe('applyAction', () => {
  let state: GameState

  beforeEach(() => {
    state = makeActiveGame()
  })

  it('rejects CHOOSE_CARD for a card not in hand', () => {
    const result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(result.ok).toBe(false)
  })

  it('rejects a player choosing a card twice in the same round', () => {
    const shipCardId = cardIdFor('p1', 'ship')
    const first = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: shipCardId })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = applyAction(first.state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: shipCardId })
    expect(second.ok).toBe(false)
  })

  it('moves to the actions phase once every player has chosen a card', () => {
    const p1Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') })
    expect(p1Choice.ok).toBe(true)
    if (!p1Choice.ok) return
    expect(p1Choice.state.roundPhase).toBe('selectCards')

    const p2Choice = applyAction(p1Choice.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'ship') })
    expect(p2Choice.ok).toBe(true)
    if (!p2Choice.ok) return
    expect(p2Choice.state.roundPhase).toBe('actions')
    expect(p2Choice.state.activePlayerId).toBe('p1')
    expect(p2Choice.state.pendingPlayerIds).toEqual(['p1', 'p2'])
  })

  it('rejects RESOLVE_UNIT_ACTION outside the actions phase', () => {
    const result = applyAction(state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] })
    expect(result.ok).toBe(false)
  })

  it('rejects RESOLVE_UNIT_ACTION out of turn order', () => {
    const p1Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') })
    if (!p1Choice.ok) throw new Error('setup failed')
    const p2Choice = applyAction(p1Choice.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'ship') })
    if (!p2Choice.ok) throw new Error('setup failed')

    const result = applyAction(p2Choice.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] })
    expect(result.ok).toBe(false)
  })

  it('rejects PURCHASE_CARD outside the purchase phase', () => {
    const result = applyAction(state, { type: 'PURCHASE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('purchase phase')
    }
  })

  it('does not mutate the input state', () => {
    const snapshot = JSON.stringify(state)
    applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') })
    expect(JSON.stringify(state)).toBe(snapshot)
  })

  it('rejects actions when the game is not active', () => {
    const lobbyState: GameState = { ...state, status: 'lobby' }
    const result = applyAction(lobbyState, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') })
    expect(result.ok).toBe(false)
  })
})

describe('applyAction — resyncs unit movement from unitContent before dispatching', () => {
  // Regression: a reported game had a Merchant whose movement.canCrossCliffs
  // was stamped false at creation time, from before a content rules fix
  // (canCrossCliffs: true) landed — the fix alone never reached that
  // already-placed unit, since Unit.movement is a one-time copy, not a
  // live lookup. Every action now refreshes every unit's movement from the
  // current unitContent first, so an already-placed unit picks up a
  // content-driven rules fix on the very next action, not just new ones.
  it("refreshes an already-placed unit's stale movement profile from current content", () => {
    const state = makeActiveGame()
    const staleUnits = state.units.map((u) => (u.kind === 'ship' ? { ...u, movement: { ...u.movement, canCrossCliffs: false } } : u))
    const staleState: GameState = { ...state, units: staleUnits }
    const freshContent: UnitContent = {
      ...EMPTY_UNIT_CONTENT,
      movementByKind: { ship: { isMobile: true, terrains: ['water'], canCrossCliffs: true, moveDistance: 1 } },
    }

    const result = applyAction(staleState, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') }, freshContent)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ships = result.state.units.filter((u) => u.kind === 'ship')
    expect(ships.length).toBeGreaterThan(0)
    expect(ships.every((u) => u.movement.canCrossCliffs)).toBe(true)
  })

  it('leaves units untouched when unitContent has no movement entry for their kind', () => {
    const state = makeActiveGame()

    const result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') }, EMPTY_UNIT_CONTENT)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.units).toEqual(state.units)
  })
})

describe('applyResolveUnitAction — different units of the same kind may choose different actions', () => {
  const testUnitContent: UnitContent = {
    actionsByKind: {
      city: [
        { id: 'generate-income', name: 'Generate Income', description: '', effect: { actionType: 'income', goldByTerrain: { forest: 3 } } },
        {
          id: 'create-nomad',
          name: 'Create Nomad',
          description: '',
          effect: { actionType: 'create', targetUnit: 'nomad', targetHex: { location: 'adj' }, cost: {} },
        },
      ],
    },
    movementByKind: { nomad: { isMobile: true, terrains: ['plain'], canCrossCliffs: false } },
    terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: {},
    companionKindsByCardKind: {},
  }

  function makeTwoCitiesState(): GameState {
    const board = setTile(setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'forest'), { q: 5, r: 0 }, 'plain'), { q: 6, r: 0 }, 'plain')
    const cityA: Unit = {
      id: 'city_a',
      ownerId: 'p1',
      kind: 'city',
      coord: { q: 0, r: 0 },
      movement: { isMobile: false, terrains: [], canCrossCliffs: false },
      traits: [],
    }
    const cityB: Unit = {
      id: 'city_b',
      ownerId: 'p1',
      kind: 'city',
      coord: { q: 5, r: 0 },
      movement: { isMobile: false, terrains: [], canCrossCliffs: false },
      traits: [],
    }
    const lobby = createNewGame({
      gameId: 'game_2',
      playMode: 'hotseat',
      board,
      players: [
        { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
      ],
      resourceBank: { gold: 100, wood: 100, stone: 100 },
    })
    // p2 never gets a real turn in this fixture — it's not testing multi-
    // player interaction at all, just p1's own action resolution — so p2 is
    // excluded up front (not in turnOrder, marked eliminated) rather than
    // given no cards and left for beginSelectCardsPhase to eliminate: since
    // eliminatePlayer ends the game outright once only one player remains
    // (elimination.ts), letting the engine eliminate p2 here would complete
    // the game before this test's own CHOOSE_CARD/RESOLVE_UNIT_ACTION ever
    // ran.
    const active: GameState = {
      ...lobby,
      board,
      units: [cityA, cityB],
      status: 'active',
      turnOrder: ['p1'],
      players: lobby.players.map((p) => (p.id === 'p2' ? { ...p, eliminated: true } : p)),
    }
    const selecting = beginSelectCardsPhase(syncCardZonesWithBoard(active))
    const chosen = applyAction(selecting, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!chosen.ok) throw new Error('setup failed')
    return chosen.state
  }

  it('resolves a different action per unit in a single RESOLVE_UNIT_ACTION', () => {
    const state = makeTwoCitiesState()
    expect(state.roundPhase).toBe('actions')

    const result = applyAction(
      state,
      {
        type: 'RESOLVE_UNIT_ACTION',
        playerId: 'p1',
        unitActions: [
          { unitId: 'city_a', actionId: 'generate-income' },
          { unitId: 'city_b', actionId: 'create-nomad', target: { q: 6, r: 0 } },
        ],
      },
      testUnitContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // city_a's income ran exactly once (not city_b's too, which has no income effect).
    expect(result.state.players.find((p) => p.id === 'p1')!.resources.gold).toBe(3)
    // city_b's create ran exactly once (not city_a's too, which wasn't given that action).
    expect(result.state.units).toHaveLength(3)
    expect(result.state.units.some((u) => u.kind === 'nomad' && u.coord.q === 6 && u.coord.r === 0)).toBe(true)
  })

  it('leaves a unit with no assigned action untouched', () => {
    const state = makeTwoCitiesState()

    const result = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      testUnitContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.players.find((p) => p.id === 'p1')!.resources.gold).toBe(3)
    expect(result.state.units).toHaveLength(2)
  })
})

describe('applyResolveUnitAction — unit actions resolve in order, one at a time', () => {
  const nomadContent: UnitContent = {
    actionsByKind: {
      nomad: [
        {
          id: 'produce-resource',
          name: 'Produce Resource',
          description: '',
          effect: { actionType: 'produce', resourceByTerrain: { forest: { wood: 1 } } },
        },
        {
          id: 'transform-to-city',
          name: 'Transform to City',
          description: '',
          effect: { actionType: 'transform', targetUnit: 'city', targetHex: { terrainType: ['plain', 'forest'], location: 'self' }, destroySelf: true, cost: { wood: 1 } },
        },
      ],
    },
    movementByKind: {},
    terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: {},
    companionKindsByCardKind: {},
  }

  function makeTwoNomadsState(): GameState {
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'forest'), { q: 5, r: 0 }, 'plain')
    const nomadA: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: { isMobile: true, terrains: [], canCrossCliffs: false }, traits: [] }
    const nomadB: Unit = { id: 'nomad_b', ownerId: 'p1', kind: 'nomad', coord: { q: 5, r: 0 }, movement: { isMobile: true, terrains: [], canCrossCliffs: false }, traits: [] }
    const lobby = createNewGame({
      gameId: 'game_3',
      playMode: 'hotseat',
      board,
      players: [
        { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
      ],
      resourceBank: { gold: 100, wood: 100, stone: 100 },
    })
    // p2 excluded up front, same reasoning as makeTwoCitiesState above —
    // eliminating them for real (no cards) would end the game outright.
    const active: GameState = {
      ...lobby,
      board,
      units: [nomadA, nomadB],
      status: 'active',
      turnOrder: ['p1'],
      players: lobby.players.map((p) => (p.id === 'p2' ? { ...p, eliminated: true } : p)),
    }
    const selecting = beginSelectCardsPhase(syncCardZonesWithBoard(active))
    const chosen = applyAction(selecting, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') })
    if (!chosen.ok) throw new Error('setup failed')
    return chosen.state
  }

  it("a unit spending a resource sees an EARLIER unit's gain in the same submission", () => {
    const state = makeTwoNomadsState()
    expect(state.players.find((p) => p.id === 'p1')!.resources.wood).toBe(0)

    const result = applyAction(
      state,
      {
        type: 'RESOLVE_UNIT_ACTION',
        playerId: 'p1',
        unitActions: [
          { unitId: 'nomad_a', actionId: 'produce-resource' },
          { unitId: 'nomad_b', actionId: 'transform-to-city' },
        ],
      },
      nomadContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // transform-to-city is destroySelf, so nomad_b's id is gone — a new
    // City stands in its place instead.
    expect(result.state.units.some((u) => u.id === 'nomad_b')).toBe(false)
    expect(result.state.units.some((u) => u.kind === 'city' && u.coord.q === 5 && u.coord.r === 0)).toBe(true)
    expect(result.state.players.find((p) => p.id === 'p1')!.resources.wood).toBe(0)
  })

  it("a unit spending a resource does NOT see a LATER unit's gain — order is exactly what was assigned", () => {
    const state = makeTwoNomadsState()

    const result = applyAction(
      state,
      {
        type: 'RESOLVE_UNIT_ACTION',
        playerId: 'p1',
        unitActions: [
          { unitId: 'nomad_b', actionId: 'transform-to-city' },
          { unitId: 'nomad_a', actionId: 'produce-resource' },
        ],
      },
      nomadContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // nomad_b had no wood yet when its transform ran — stays a nomad.
    expect(result.state.units.find((u) => u.id === 'nomad_b')?.kind).toBe('nomad')
    // nomad_a's production still ran afterward.
    expect(result.state.players.find((p) => p.id === 'p1')!.resources.wood).toBe(1)
  })
})

describe('RESOLVE_UNIT_ACTION resolves immediately; the turn ends via PASS_ACTIONS or automatically once every unit has acted', () => {
  const twoCityContent: UnitContent = {
    actionsByKind: {
      city: [{ id: 'generate-income', name: 'Generate Income', description: '', effect: { actionType: 'income', goldByTerrain: { forest: 3 } } }],
    },
    movementByKind: {},
    terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: {},
    companionKindsByCardKind: {},
  }

  // Both players get a real City unit + card (not just p1, per
  // applyResolveUnitAction's other fixture above) so pendingPlayerIds stays
  // ['p1', 'p2'] throughout rather than p2 being eliminated for having no
  // card to choose — keeps p1 finishing their turn from cascading into
  // finishRound's discard-recycle, which would otherwise obscure the
  // discard-zone assertions below.
  function makeTwoCitiesState(): GameState {
    const board = setTile(setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'forest'), { q: 5, r: 0 }, 'forest'), { q: 10, r: 0 }, 'forest')
    const cityA: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: { isMobile: false, terrains: [], canCrossCliffs: false }, traits: [] }
    const cityB: Unit = { id: 'city_b', ownerId: 'p1', kind: 'city', coord: { q: 5, r: 0 }, movement: { isMobile: false, terrains: [], canCrossCliffs: false }, traits: [] }
    const cityC: Unit = { id: 'city_c', ownerId: 'p2', kind: 'city', coord: { q: 10, r: 0 }, movement: { isMobile: false, terrains: [], canCrossCliffs: false }, traits: [] }
    const lobby = createNewGame({
      gameId: 'game_4',
      playMode: 'hotseat',
      board,
      players: [
        { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
      ],
      resourceBank: { gold: 100, wood: 100, stone: 100 },
    })
    const active: GameState = { ...lobby, board, units: [cityA, cityB, cityC], status: 'active' }
    const selecting = beginSelectCardsPhase(syncCardZonesWithBoard(active))
    let result = applyAction(selecting, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    return result.state
  }

  it('resolving one unit applies its effect immediately but leaves the turn open', () => {
    const state = makeTwoCitiesState()

    const result = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      twoCityContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The effect already applied...
    expect(result.state.players.find((p) => p.id === 'p1')!.resources.gold).toBe(3)
    expect(result.state.resolvedUnitIdsThisTurn).toEqual(['city_a'])
    // ...but the turn itself hasn't ended: still p1's turn, card not yet discarded.
    expect(result.state.roundPhase).toBe('actions')
    expect(result.state.pendingPlayerIds).toEqual(['p1', 'p2'])
    expect(result.state.activePlayerId).toBe('p1')
    const p1 = result.state.players.find((p) => p.id === 'p1')!
    expect(p1.discardCardIds).not.toContain(cardIdFor('p1', 'city'))
  })

  it('rejects re-resolving the same unit twice in the same turn', () => {
    const state = makeTwoCitiesState()
    const first = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      twoCityContent,
    )
    if (!first.ok) throw new Error('setup failed')

    const second = applyAction(
      first.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      twoCityContent,
    )
    expect(second.ok).toBe(false)
    // Gold only credited once, from the first resolve.
    expect(first.state.players.find((p) => p.id === 'p1')!.resources.gold).toBe(3)
  })

  it('rejects a RESOLVE_UNIT_ACTION that resolves nothing at all (empty list, or every unit already acted)', () => {
    const state = makeTwoCitiesState()
    const empty = applyAction(state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, twoCityContent)
    expect(empty.ok).toBe(false)
  })

  it('PASS_ACTIONS ends the turn: moves the card to discard and advances to the next player', () => {
    const state = makeTwoCitiesState()
    const resolved = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      twoCityContent,
    )
    if (!resolved.ok) throw new Error('setup failed')

    const passed = applyAction(resolved.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    expect(passed.ok).toBe(true)
    if (!passed.ok) return
    // city_b was never resolved — Pass leaves it idle rather than erroring.
    expect(passed.state.units).toHaveLength(3)
    const p1 = passed.state.players.find((p) => p.id === 'p1')!
    expect(p1.discardCardIds).toContain(cardIdFor('p1', 'city'))
    expect(passed.state.resolvedUnitIdsThisTurn).toEqual([])
    // p2 is still pending — the round doesn't finish yet.
    expect(passed.state.pendingPlayerIds).toEqual(['p2'])
    expect(passed.state.activePlayerId).toBe('p2')
  })

  it('PASS_ACTIONS adds exactly one actionHistory entry regardless of how many units it leaves idle', () => {
    const state = makeTwoCitiesState()
    const passed = applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    expect(passed.ok).toBe(true)
    if (!passed.ok) return
    expect(passed.state.actionHistory).toHaveLength(state.actionHistory.length + 1)
    expect(passed.state.actionHistory.at(-1)?.action.type).toBe('PASS_ACTIONS')
  })

  it('rejects PASS_ACTIONS out of turn order', () => {
    const state = makeTwoCitiesState()
    const result = applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p2' })
    expect(result.ok).toBe(false)
  })

  it('rejects PASS_ACTIONS outside the actions phase', () => {
    const lobbyState = makeActiveGame()
    const result = applyAction(lobbyState, { type: 'PASS_ACTIONS', playerId: 'p1' })
    expect(result.ok).toBe(false)
  })

  it('resolving the last unassigned unit ends the turn automatically — no PASS_ACTIONS needed', () => {
    const state = makeTwoCitiesState()
    const firstUnit = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      twoCityContent,
    )
    if (!firstUnit.ok) throw new Error('setup failed')
    // Still p1's turn — city_b hasn't acted yet.
    expect(firstUnit.state.pendingPlayerIds).toEqual(['p1', 'p2'])

    const lastUnit = applyAction(
      firstUnit.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_b', actionId: 'generate-income' }] },
      twoCityContent,
    )
    expect(lastUnit.ok).toBe(true)
    if (!lastUnit.ok) return
    // Both of p1's cities' income applied...
    expect(lastUnit.state.players.find((p) => p.id === 'p1')!.resources.gold).toBe(6)
    // ...and the turn ended on its own: card discarded, next player up,
    // resolvedUnitIdsThisTurn reset for p2's fresh turn.
    const p1 = lastUnit.state.players.find((p) => p.id === 'p1')!
    expect(p1.discardCardIds).toContain(cardIdFor('p1', 'city'))
    expect(lastUnit.state.pendingPlayerIds).toEqual(['p2'])
    expect(lastUnit.state.activePlayerId).toBe('p2')
    expect(lastUnit.state.resolvedUnitIdsThisTurn).toEqual([])
    // Still just the one RESOLVE_UNIT_ACTION entry for this last resolve — no separate PASS_ACTIONS was dispatched.
    expect(lastUnit.state.actionHistory).toHaveLength(firstUnit.state.actionHistory.length + 1)
    expect(lastUnit.state.actionHistory.at(-1)?.action.type).toBe('RESOLVE_UNIT_ACTION')
  })

  it("resolving a player's only acting unit ends their turn immediately, finishing the actions phase", () => {
    const state = makeTwoCitiesState()
    let result = applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.pendingPlayerIds).toEqual(['p2'])

    // p2 has just city_c — resolving it is p2's whole turn.
    result = applyAction(
      result.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [{ unitId: 'city_c', actionId: 'generate-income' }] },
      twoCityContent,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.players.find((p) => p.id === 'p2')!.resources.gold).toBe(3)
    // Both players are done — the actions phase itself finished and moved
    // on (discard-zone assertions belong to the dedicated PASS_ACTIONS
    // test above; here both hands were also empty of anything else, so
    // finishRound's empty-hand recycle already moved the discarded card
    // straight back to hand by the time this settles).
    expect(result.state.roundPhase).not.toBe('actions')
  })
})

describe('RESOLVE_UNIT_ACTION rejects an action whose cost/target preconditions were not met (bug: an unaffordable Transform silently consumed the unit\'s turn)', () => {
  const nomadContent: UnitContent = {
    actionsByKind: {
      nomad: [
        {
          id: 'transform-to-city',
          name: 'Transform to City',
          description: '',
          effect: {
            actionType: 'transform',
            targetUnit: 'city',
            targetHex: { terrainType: ['plain'], location: 'self' },
            destroySelf: true,
            cost: { wood: 5 },
          },
        },
        { id: 'generate-income', name: 'Generate Income', description: '', effect: { actionType: 'income', goldByTerrain: { forest: 3 } } },
        { id: 'produce-resource', name: 'Produce Resource', description: '', effect: { actionType: 'produce', resourceByTerrain: { forest: { wood: 1 } } } },
      ],
    },
    movementByKind: {},
    terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: {},
    companionKindsByCardKind: {},
  }

  function makeSingleNomadState(): GameState {
    const board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain')
    const nomad: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: { isMobile: true, terrains: [], canCrossCliffs: false }, traits: [] }
    const lobby = createNewGame({
      gameId: 'game_5',
      playMode: 'hotseat',
      board,
      players: [
        { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
      ],
      resourceBank: { gold: 100, wood: 100, stone: 100 },
    })
    // p2 excluded up front, same reasoning as makeTwoCitiesState above —
    // eliminating them for real (no cards) would end the game outright.
    const active: GameState = {
      ...lobby,
      board,
      units: [nomad],
      status: 'active',
      turnOrder: ['p1'],
      players: lobby.players.map((p) => (p.id === 'p2' ? { ...p, eliminated: true } : p)),
    }
    const selecting = beginSelectCardsPhase(syncCardZonesWithBoard(active))
    const chosen = applyAction(selecting, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') })
    if (!chosen.ok) throw new Error('setup failed')
    return chosen.state
  }

  it('rejects the whole dispatch when the unit cannot afford the cost — no unit is created, the unit stays free to act', () => {
    const state = makeSingleNomadState()
    expect(state.players.find((p) => p.id === 'p1')!.resources.wood).toBe(0)

    const result = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'nomad_a', actionId: 'transform-to-city' }] },
      nomadContent,
    )

    expect(result.ok).toBe(false)
    // Nothing about the input state leaked through: no City appeared, and
    // the actionHistory/resolvedUnitIdsThisTurn this bug report complained
    // about staying untouched.
    expect(state.units).toHaveLength(1)
    expect(state.units[0].kind).toBe('nomad')
    expect(state.resolvedUnitIdsThisTurn).toEqual([])
  })

  it('the same Transform succeeds once the unit can actually afford it', () => {
    const state = makeSingleNomadState()
    const funded: GameState = {
      ...state,
      players: state.players.map((p) => (p.id === 'p1' ? { ...p, resources: { ...p.resources, wood: 5 } } : p)),
    }

    const result = applyAction(
      funded,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'nomad_a', actionId: 'transform-to-city' }] },
      nomadContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.units.some((u) => u.kind === 'city' && u.coord.q === 0 && u.coord.r === 0)).toBe(true)
    // nomad_a was p1's only acting unit, so resolving it ends the turn on
    // its own — resolvedUnitIdsThisTurn is already reset for the next
    // player, exactly like the "resolving the last unassigned unit ends the
    // turn automatically" case above; the one new actionHistory entry is
    // what shows this resolved successfully rather than being rejected.
    expect(result.state.actionHistory.at(-1)?.action.type).toBe('RESOLVE_UNIT_ACTION')
    expect(result.state.actionHistory).toHaveLength(state.actionHistory.length + 1)
  })

  it("rejects income whose payout would be zero (bug: a Nomad on Plain could \"Generate Income\" — goldByTerrain only has forest — and still consume its turn for 0 gold)", () => {
    const state = makeSingleNomadState()

    const result = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'nomad_a', actionId: 'generate-income' }] },
      nomadContent,
    )

    expect(result.ok).toBe(false)
    // Nothing about the input state leaked through: the unit is still free to act.
    expect(state.units).toHaveLength(1)
    expect(state.resolvedUnitIdsThisTurn).toEqual([])
  })

  it('the same income succeeds once the terrain actually pays out', () => {
    const state = makeSingleNomadState()
    const onForest: GameState = { ...state, board: setTile(state.board, { q: 0, r: 0 }, 'forest') }

    const result = applyAction(
      onForest,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'nomad_a', actionId: 'generate-income' }] },
      nomadContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.players.find((p) => p.id === 'p1')!.resources.gold).toBe(3)
    // Same "only acting unit" auto-end-turn case as above.
    expect(result.state.actionHistory.at(-1)?.action.type).toBe('RESOLVE_UNIT_ACTION')
    expect(result.state.actionHistory).toHaveLength(state.actionHistory.length + 1)
  })

  it('rejects produce once the player is already at that resource\'s cap (bug: Produce Resource stayed available and consumed the turn for 0 Wood once already at the Wood cap)', () => {
    const state = makeSingleNomadState()
    const onForestAtCap: GameState = {
      ...state,
      board: setTile(state.board, { q: 0, r: 0 }, 'forest'),
      players: state.players.map((p) => (p.id === 'p1' ? { ...p, resources: { ...p.resources, wood: 5 } } : p)),
    }

    const result = applyAction(
      onForestAtCap,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'nomad_a', actionId: 'produce-resource' }] },
      nomadContent,
    )

    expect(result.ok).toBe(false)
    expect(onForestAtCap.units).toHaveLength(1)
    expect(onForestAtCap.resolvedUnitIdsThisTurn).toEqual([])
  })

  it('the same produce succeeds once below the cap', () => {
    const state = makeSingleNomadState()
    const onForest: GameState = { ...state, board: setTile(state.board, { q: 0, r: 0 }, 'forest') }

    const result = applyAction(
      onForest,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'nomad_a', actionId: 'produce-resource' }] },
      nomadContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.players.find((p) => p.id === 'p1')!.resources.wood).toBe(1)
    expect(result.state.actionHistory.at(-1)?.action.type).toBe('RESOLVE_UNIT_ACTION')
    expect(result.state.actionHistory).toHaveLength(state.actionHistory.length + 1)
  })
})

describe('applyAction — PLACE_TILE/PLACE_UNIT dispatch during boardSetup', () => {
  function makeBoardSetupState(): GameState {
    const lobby = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board: setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'water'), { q: 1, r: 0 }, 'water'),
      players: [
        { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      ],
    })
    return {
      ...lobby,
      status: 'boardSetup',
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 1, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    }
  }

  const boardGenerationContent: BoardGenerationContent = {
    startingWaterShapeCells: [],
    tiers: [{ terrain: 'plain', shapeCells: [{ q: 0, r: 0 }, { q: 1, r: 0 }], placesOn: ['water'], poolSize: 1 }],
  }

  it('routes PLACE_TILE through even though status is not "active"', () => {
    const state = makeBoardSetupState()
    const result = applyAction(
      state,
      { type: 'PLACE_TILE', playerId: 'p1', anchor: { q: 0, r: 0 }, rotationSteps: 0 },
      undefined,
      undefined,
      boardGenerationContent,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.boardSetup?.tileTierQueue).toEqual([])
  })

  it('rejects a normal round action (CHOOSE_CARD) during boardSetup status', () => {
    const state = makeBoardSetupState()
    const result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('not active')
  })
})

describe('applyActionAndFastForwardTiles', () => {
  const domino = [{ q: 0, r: 0 }, { q: 1, r: 0 }]

  function makeForcedChainState(): GameState {
    const lobby = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board: [
        [0, 0], [1, 0],
        [5, 5], [6, 5], [7, 5], [8, 5],
      ].reduce((b, [q, r]) => setTile(b, { q, r }, 'water'), createEmptyBoard('hex')),
      players: [
        { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      ],
    })
    return {
      ...lobby,
      status: 'boardSetup',
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 3, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    }
  }

  const boardGenerationContent: BoardGenerationContent = {
    startingWaterShapeCells: [],
    tiers: [{ terrain: 'plain', shapeCells: domino, placesOn: ['water'], poolSize: 3 }],
  }

  it('auto-places the rest of a tier once only one way remains, cycling turn order for the skipped decisions', () => {
    const state = makeForcedChainState()

    // p1 manually places the (0,0)-(1,0) domino. That leaves the (5,5)-
    // (6,5)-(7,5)-(8,5) chain with exactly one way to place the 2 tiles
    // still owed (see findForcedPlacement's tests) — no real decision left,
    // so both should auto-place instead of waiting on p2 and p1 again.
    const result = applyActionAndFastForwardTiles(
      state,
      { type: 'PLACE_TILE', playerId: 'p1', anchor: { q: 0, r: 0 }, rotationSteps: 0 },
      undefined,
      undefined,
      boardGenerationContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    for (const [q, r] of [[0, 0], [1, 0], [5, 5], [6, 5], [7, 5], [8, 5]]) {
      expect(getTile(result.state.board, { q, r })?.terrain).toBe('plain')
    }

    // Tier's pool (3) is fully spent -> tile placement is over.
    expect(result.state.boardSetup?.tileTierQueue).toEqual([])

    // 3 PLACE_TILE entries: the manual one plus the 2 fast-forwarded ones,
    // attributed in turn order (p1 manual, then p2, then p1 again).
    const placeTileActions = result.state.actionHistory.filter((entry) => entry.action.type === 'PLACE_TILE')
    expect(placeTileActions).toHaveLength(3)
    expect(placeTileActions.map((entry) => entry.action.playerId)).toEqual(['p1', 'p2', 'p1'])
  })

  it("doesn't fast-forward while more than one legal arrangement remains", () => {
    const lobby = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board: [
        [0, 0], [1, 0],
        [5, 5], [6, 5],
        [10, 5], [11, 5],
        [15, 5], [16, 5],
      ].reduce((b, [q, r]) => setTile(b, { q, r }, 'water'), createEmptyBoard('hex')),
      players: [
        { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      ],
    })
    const state: GameState = {
      ...lobby,
      status: 'boardSetup',
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 3, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    }
    const content: BoardGenerationContent = { startingWaterShapeCells: [], tiers: [{ terrain: 'plain', shapeCells: domino, placesOn: ['water'], poolSize: 3 }] }

    // Three fully independent, interchangeable pairs remain after p1's
    // placement, but only 2 tiles are still owed — which 2 of the 3 pairs
    // get used isn't determined, so nothing should auto-place.
    const result = applyActionAndFastForwardTiles(
      state,
      { type: 'PLACE_TILE', playerId: 'p1', anchor: { q: 0, r: 0 }, rotationSteps: 0 },
      undefined,
      undefined,
      content,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.boardSetup?.tilesRemainingInTier).toBe(2)
    expect(result.state.actionHistory.filter((entry) => entry.action.type === 'PLACE_TILE')).toHaveLength(1)
  })
})
