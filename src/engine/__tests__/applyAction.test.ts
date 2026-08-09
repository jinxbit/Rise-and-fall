import { beforeEach, describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import type { BoardGenerationContent } from '../boardGenerationContent'
import { EMPTY_BOARD_GENERATION_CONTENT } from '../boardGenerationContent'
import { cardIdFor, syncCardZonesWithBoard } from '../cards'
import { createNewGame, startGame } from '../createGame'
import { beginSelectCardsPhase } from '../round'
import type { Coordinate, GameState, Unit } from '../types'
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
    const result = applyAction(state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', actionIdByUnitId: {} })
    expect(result.ok).toBe(false)
  })

  it('rejects RESOLVE_UNIT_ACTION out of turn order', () => {
    const p1Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') })
    if (!p1Choice.ok) throw new Error('setup failed')
    const p2Choice = applyAction(p1Choice.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'ship') })
    if (!p2Choice.ok) throw new Error('setup failed')

    const result = applyAction(p2Choice.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', actionIdByUnitId: {} })
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
    // p2 has no units at all, so their hand is empty and beginSelectCardsPhase
    // eliminates them immediately (rule: no card to choose) — leaving p1 the
    // only pending player, which is all this test needs.
    const active: GameState = { ...lobby, board, units: [cityA, cityB], status: 'active' }
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
        actionIdByUnitId: { city_a: 'generate-income', city_b: 'create-nomad' },
        targets: { city_b: { q: 6, r: 0 } },
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
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', actionIdByUnitId: { city_a: 'generate-income' } },
      testUnitContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.players.find((p) => p.id === 'p1')!.resources.gold).toBe(3)
    expect(result.state.units).toHaveLength(2)
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
