import { describe, expect, it } from 'vitest'
import { createEmptyBoard, getTile, setTile } from '../board'
import type { BoardGenerationContent, TileTierContent } from '../boardGenerationContent'
import {
  beginBoardSetup,
  beginBoardSetupWithPresetBoard,
  checkTilePlacementLegality,
  currentTilePlacerId,
  currentUnitPlacerId,
  placeTile,
  placeUnit,
} from '../boardSetup'
import { isLegalTilePlacement, placedShapeCells, touchesEnoughExistingTerrain, wouldEncloseEmptyHexes } from '../boardGeneration'
import { cardIdFor, createPlayerCards } from '../cards'
import type { Board, Card, Coordinate, GameState, Player, Terrain } from '../types'
import type { UnitContent } from '../unitContent'
import terrainJson from '../../content/terrain.json'

function makePlayer(id: string, cards: Card[]): Player {
  return {
    id,
    authUserId: null,
    displayName: id,
    color: 'red',
    handCardIds: [],
    currentlyPlayedCardId: null,
    discardCardIds: [],
    supplyCardIds: cards.map((c) => c.id),
    declineCardIds: [],
    eliminated: false,
    resources: { gold: 0, wood: 0, stone: 0 },
  }
}

function boardOf(cells: Array<[number, number, Terrain]>) {
  let board = createEmptyBoard('hex')
  for (const [q, r, terrain] of cells) board = setTile(board, { q, r }, terrain)
  return board
}

/** Builds a 2-player GameState with real per-player cards (so PLACE_UNIT's card-zone sync is exercisable), status/turnOrder set for board setup, and an otherwise-empty board. */
function makeSetupState(overrides: Partial<GameState> = {}): GameState {
  const turnOrder = ['p1', 'p2']
  const cards: Record<string, Card> = {}
  const players = turnOrder.map((id) => {
    const playerCards = createPlayerCards(id)
    for (const c of playerCards) cards[c.id] = c
    return makePlayer(id, playerCards)
  })

  return {
    gameId: 'g1',
    playMode: 'hotseat',
    status: 'boardSetup',
    turn: 0,
    activePlayerId: null,
    roundPhase: 'selectCards',
    chosenCardIdByPlayerId: {},
    pendingPlayerIds: [],
    resolvedUnitIdsThisTurn: [],
    turnOrder,
    board: createEmptyBoard('hex'),
    players,
    units: [],
    cards,
    resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: { tileTierQueue: [], tilesRemainingInTier: 0, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    idSequence: 0,
    actionHistory: [],
    ...overrides,
  }
}

const domino = [{ q: 0, r: 0 }, { q: 1, r: 0 }]

function tier(terrain: Terrain, placesOn: Terrain[] | null, poolSize: number, shapeCells: Coordinate[] = domino): TileTierContent {
  return { terrain, shapeCells, placesOn, poolSize }
}

const emptyUnitContent: UnitContent = {
  actionsByKind: {},
  movementByKind: {
    city: { isMobile: false, terrains: [], canCrossCliffs: false },
    nomad: { isMobile: true, terrains: ['plain', 'forest', 'mountain'], canCrossCliffs: false, moveDistance: 1 },
    ship: { isMobile: true, terrains: ['water'], canCrossCliffs: false, moveDistance: 'unlimited' },
  },
  terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
  resourceCaps: { gold: null, wood: 5, stone: 5 },
  unitSupplyCaps: {},
}

describe('beginBoardSetup', () => {
  it('seeds the starting water tiles and sets status to boardSetup', () => {
    const content: BoardGenerationContent = { startingWaterShapeCells: domino, tiers: [tier('plain', ['water'], 3)] }
    const base = makeSetupState({ status: 'lobby', boardSetup: null })

    const next = beginBoardSetup(base, content)

    expect(next.status).toBe('boardSetup')
    // 2 players -> one interlocked pair of the domino shape -> 4 hexes total.
    expect(Object.keys(next.board.tiles)).toHaveLength(4)
    expect(next.boardSetup?.tileTierQueue).toEqual(['plain'])
    expect(next.boardSetup?.tilesRemainingInTier).toBe(3)
  })

  it('skips a tier whose pool is 0 right from the start', () => {
    const content: BoardGenerationContent = {
      startingWaterShapeCells: domino,
      tiers: [tier('plain', ['water'], 0), tier('forest', ['plain'], 5)],
    }
    const base = makeSetupState({ status: 'lobby', boardSetup: null })

    const next = beginBoardSetup(base, content)

    expect(next.boardSetup?.tileTierQueue).toEqual(['forest'])
    expect(next.boardSetup?.tilesRemainingInTier).toBe(5)
  })

  it('jumps straight to unit placement if every tier is empty', () => {
    const content: BoardGenerationContent = { startingWaterShapeCells: domino, tiers: [] }
    const base = makeSetupState({ status: 'lobby', boardSetup: null })

    const next = beginBoardSetup(base, content)

    expect(next.boardSetup?.tileTierQueue).toEqual([])
    expect(next.boardSetup?.unitsRemainingByPlayerId).toEqual({ p1: ['city', 'nomad', 'ship'], p2: ['city', 'nomad', 'ship'] })
  })
})

describe('beginBoardSetupWithPresetBoard', () => {
  it('uses the given board as-is and skips straight to unit placement', () => {
    const preset = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'forest']])
    const base = makeSetupState({ status: 'lobby', boardSetup: null, board: createEmptyBoard('hex') })

    const next = beginBoardSetupWithPresetBoard(base, preset)

    expect(next.status).toBe('boardSetup')
    expect(next.board).toBe(preset)
    expect(next.boardSetup?.tileTierQueue).toEqual([])
    expect(next.boardSetup?.unitsRemainingByPlayerId).toEqual({ p1: ['city', 'nomad', 'ship'], p2: ['city', 'nomad', 'ship'] })
    expect(currentTilePlacerId(next)).toBeNull()
    expect(currentUnitPlacerId(next)).toBe('p1')
  })

  it('lets unit placement proceed normally to an active game afterward', () => {
    const preset = boardOf([
      [0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain'],
      [3, 0, 'plain'], [4, 0, 'water'], [5, 0, 'plain'],
    ])
    const base = makeSetupState({ status: 'lobby', boardSetup: null, board: createEmptyBoard('hex') })
    let state = beginBoardSetupWithPresetBoard(base, preset)

    // Turn order alternates p1/p2 each placement (see unitPlacerIndex), so
    // this must interleave the two players' three placements rather than
    // exhausting one player's units before the other's.
    const placements: Array<[string, string, Coordinate]> = [
      ['p1', 'city', { q: 0, r: 0 }],
      ['p2', 'city', { q: 3, r: 0 }],
      ['p1', 'ship', { q: 1, r: 0 }],
      ['p2', 'ship', { q: 4, r: 0 }],
      ['p1', 'nomad', { q: 2, r: 0 }],
      ['p2', 'nomad', { q: 5, r: 0 }],
    ]
    for (const [playerId, kind, coord] of placements) {
      const result = placeUnit(state, playerId, kind, coord, emptyUnitContent)
      if (!result.ok) throw new Error(`setup failed: ${result.error}`)
      state = result.state
    }

    expect(state.status).toBe('active')
    expect(state.boardSetup).toBeNull()
    expect(state.units).toHaveLength(6)
  })
})

describe('placeTile', () => {
  const content: BoardGenerationContent = { startingWaterShapeCells: domino, tiers: [tier('plain', ['water'], 3)] }

  it("rejects when it isn't this player's turn", () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'water'], [1, 0, 'water']]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 3, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    const result = placeTile(state, 'p2', { q: 0, r: 0 }, 0, content)

    expect(result.ok).toBe(false)
  })

  it('rejects an illegal placement (target hexes are not the required lower tier)', () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'forest'], [1, 0, 'forest']]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 3, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    const result = placeTile(state, 'p1', { q: 0, r: 0 }, 0, content)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Illegal')
  })

  it('places the tile, converts the covered hexes, and advances to the next player', () => {
    const state = makeSetupState({
      // Two more disjoint water pairs elsewhere, since tilesRemainingInTier
      // (3) claims 2 more tiles are still owed after this one — otherwise
      // rule 4's no-space check (see canPlaceRemainingTiles) would correctly
      // reject this placement for stranding them with nowhere left to go.
      board: boardOf([
        [0, 0, 'water'], [1, 0, 'water'],
        [10, 0, 'water'], [11, 0, 'water'],
        [20, 0, 'water'], [21, 0, 'water'],
      ]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 3, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    const result = placeTile(state, 'p1', { q: 0, r: 0 }, 0, content)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(getTile(result.state.board, { q: 0, r: 0 })?.terrain).toBe('plain')
    expect(getTile(result.state.board, { q: 1, r: 0 })?.terrain).toBe('plain')
    expect(result.state.boardSetup?.tilesRemainingInTier).toBe(2)
    expect(currentTilePlacerId(result.state)).toBe('p2')
  })

  it('cycles turn order across an uneven pool (3 tiles, 2 players)', () => {
    let state = makeSetupState({
      board: boardOf([
        [0, 0, 'water'], [1, 0, 'water'],
        [2, 0, 'water'], [3, 0, 'water'],
        [4, 0, 'water'], [5, 0, 'water'],
      ]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 3, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    expect(currentTilePlacerId(state)).toBe('p1')
    let result = placeTile(state, 'p1', { q: 0, r: 0 }, 0, content)
    if (!result.ok) throw new Error('setup failed')
    state = result.state
    expect(currentTilePlacerId(state)).toBe('p2')

    result = placeTile(state, 'p2', { q: 2, r: 0 }, 0, content)
    if (!result.ok) throw new Error('setup failed')
    state = result.state
    expect(currentTilePlacerId(state)).toBe('p1')

    result = placeTile(state, 'p1', { q: 4, r: 0 }, 0, content)
    if (!result.ok) throw new Error('setup failed')
    state = result.state

    // Pool exhausted after 3 placements -> no more tiles content -> tile placement over.
    expect(state.boardSetup?.tileTierQueue).toEqual([])
    expect(currentTilePlacerId(state)).toBeNull()
  })

  it('advances to the next tier once the current one is exhausted', () => {
    const twoTierContent: BoardGenerationContent = {
      startingWaterShapeCells: domino,
      tiers: [tier('plain', ['water'], 1), tier('forest', ['plain'], 4)],
    }
    const state = makeSetupState({
      board: boardOf([[0, 0, 'water'], [1, 0, 'water']]),
      boardSetup: { tileTierQueue: ['plain', 'forest'], tilesRemainingInTier: 1, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    const result = placeTile(state, 'p1', { q: 0, r: 0 }, 0, twoTierContent)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.boardSetup?.tileTierQueue).toEqual(['forest'])
    expect(result.state.boardSetup?.tilesRemainingInTier).toBe(4)
  })

  it('transitions to unit placement once the last tier is exhausted', () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'water'], [1, 0, 'water']]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 1, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    const result = placeTile(state, 'p1', { q: 0, r: 0 }, 0, content)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.boardSetup?.tileTierQueue).toEqual([])
    expect(result.state.boardSetup?.unitsRemainingByPlayerId).toEqual({ p1: ['city', 'nomad', 'ship'], p2: ['city', 'nomad', 'ship'] })
    expect(currentUnitPlacerId(result.state)).toBe('p1')
  })

  it("rejects a placement that would leave nowhere legal for the tier's remaining tiles to go (rule 4, simplified)", () => {
    const state = makeSetupState({
      // Two isolated water hexes, neither adjacent to the other or to the
      // (0,0)-(1,0) pair — once that pair is claimed, the domino shape has
      // nowhere left to land for the 2nd of 2 required tiles.
      board: boardOf([[0, 0, 'water'], [1, 0, 'water'], [5, 5, 'water'], [8, 8, 'water']]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 2, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    const result = placeTile(state, 'p1', { q: 0, r: 0 }, 0, content)

    expect(result.ok).toBe(false)
    // Nothing leaked through: the board is untouched.
    expect(getTile(state.board, { q: 0, r: 0 })?.terrain).toBe('water')
  })

  it('allows the same placement once a legal spot remains for the rest of the tier', () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'water'], [1, 0, 'water'], [5, 5, 'water'], [6, 5, 'water']]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 2, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    const result = placeTile(state, 'p1', { q: 0, r: 0 }, 0, content)

    expect(result.ok).toBe(true)
  })

  it('rejects a placement that leaves room for only one of two still-owed tiles (not just the next one)', () => {
    const state = makeSetupState({
      // A 3-hex chain (5,5)-(6,5)-(7,5): exactly one domino fits there, not
      // two — placing (5,5)-(6,5) or (6,5)-(7,5) leaves only one isolated
      // hex behind, nowhere for a second tile to land. A shallow "is there
      // room for one more tile" check would wrongly allow this, since a
      // legal domino does exist somewhere right after this placement — the
      // bug it misses is that room runs out one tile short of the two still
      // owed.
      board: boardOf([[0, 0, 'water'], [1, 0, 'water'], [5, 5, 'water'], [6, 5, 'water'], [7, 5, 'water']]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 3, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    const result = placeTile(state, 'p1', { q: 0, r: 0 }, 0, content)

    expect(result.ok).toBe(false)
    expect(getTile(state.board, { q: 0, r: 0 })?.terrain).toBe('water')
  })

  it('is rejected outside the boardSetup status', () => {
    const state = makeSetupState({ status: 'active', board: boardOf([[0, 0, 'water']]) })
    const result = placeTile(state, 'p1', { q: 0, r: 0 }, 0, content)
    expect(result.ok).toBe(false)
  })
})

describe('placeTile — water-expansion-only extra rules (placesOn: null)', () => {
  const waterContent: BoardGenerationContent = { startingWaterShapeCells: domino, tiers: [tier('water', null, 5)] }

  it('rejects a Sea placement that touches fewer than 2 existing Sea tiles', () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'water']]),
      boardSetup: { tileTierQueue: ['water'], tilesRemainingInTier: 5, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    // (1,0)-(2,0): only (1,0) touches the lone existing water hex at (0,0).
    const result = placeTile(state, 'p1', { q: 1, r: 0 }, 0, waterContent)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('at least 2 Sea tiles')
    expect(getTile(state.board, { q: 1, r: 0 })).toBeUndefined()
  })

  it('allows a Sea placement that touches 2 existing Sea tiles and encloses nothing', () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'water'], [1, -1, 'water']]),
      boardSetup: { tileTierQueue: ['water'], tilesRemainingInTier: 5, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    // (1,0)-(2,0): both (0,0) and (1,-1) neighbor (1,0).
    const result = placeTile(state, 'p1', { q: 1, r: 0 }, 0, waterContent)

    expect(result.ok).toBe(true)
  })

  it('rejects a Sea placement that would seal off an empty area with no way out', () => {
    // 5 of (0,0)'s 6 neighbors are already Sea; completing the ring via the
    // 6th, (0,1), would seal (0,0) itself off with nowhere left to escape
    // to — even though it comfortably touches 2+ existing Sea tiles.
    const state = makeSetupState({
      board: boardOf([
        [1, 0, 'water'], [1, -1, 'water'], [0, -1, 'water'], [-1, 0, 'water'], [-1, 1, 'water'],
      ]),
      boardSetup: { tileTierQueue: ['water'], tilesRemainingInTier: 5, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })

    const result = placeTile(state, 'p1', { q: 0, r: 1 }, 0, waterContent)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('seal off')
    expect(getTile(state.board, { q: 0, r: 1 })).toBeUndefined()
  })
})

describe('checkTilePlacementLegality', () => {
  // Previewing legality (e.g. for the board-setup UI's placement ghost)
  // must agree with what placeTile() itself would actually do — these
  // mirror placeTile()'s own describe blocks above, checking the preview
  // catches the exact same things instead of drifting out of sync with it.
  const content: BoardGenerationContent = { startingWaterShapeCells: domino, tiers: [tier('plain', ['water'], 3)] }

  it('returns null for a legal placement', () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'water'], [1, 0, 'water']]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 1, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })
    expect(checkTilePlacementLegality(state, { q: 0, r: 0 }, 0, content)).toBeNull()
  })

  it('flags an illegal covering placement', () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'forest'], [1, 0, 'forest']]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 1, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })
    expect(checkTilePlacementLegality(state, { q: 0, r: 0 }, 0, content)).toContain('Illegal')
  })

  it("flags a placement that would leave nowhere legal for the tier's remaining tiles (rule 4)", () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'water'], [1, 0, 'water'], [5, 5, 'water'], [8, 8, 'water']]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 2, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })
    expect(checkTilePlacementLegality(state, { q: 0, r: 0 }, 0, content)).toContain('no legal spot')
  })

  it('flags a Sea placement touching fewer than 2 existing Sea tiles — the reported bug (ghost shown legal/green when it was not)', () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'water']]),
      boardSetup: { tileTierQueue: ['water'], tilesRemainingInTier: 5, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })
    const waterContent: BoardGenerationContent = { startingWaterShapeCells: domino, tiers: [tier('water', null, 5)] }
    expect(checkTilePlacementLegality(state, { q: 1, r: 0 }, 0, waterContent)).toContain('at least 2 Sea tiles')
  })

  it('flags a Sea placement that would seal off an empty area', () => {
    const state = makeSetupState({
      board: boardOf([
        [1, 0, 'water'], [1, -1, 'water'], [0, -1, 'water'], [-1, 0, 'water'], [-1, 1, 'water'],
      ]),
      boardSetup: { tileTierQueue: ['water'], tilesRemainingInTier: 5, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })
    const waterContent: BoardGenerationContent = { startingWaterShapeCells: domino, tiers: [tier('water', null, 5)] }
    expect(checkTilePlacementLegality(state, { q: 0, r: 1 }, 0, waterContent)).toContain('seal off')
  })

  it("doesn't depend on whose turn it is — only whether the placement itself would be legal", () => {
    const state = makeSetupState({
      board: boardOf([[0, 0, 'water'], [1, 0, 'water']]),
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 1, tilePlacerIndex: 1, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })
    // It's p2's turn (tilePlacerIndex 1), but the preview still evaluates
    // the placement itself, since the UI needs this before a player acts.
    expect(checkTilePlacementLegality(state, { q: 0, r: 0 }, 0, content)).toBeNull()
  })
})

describe('placeUnit', () => {
  function unitPlacementState(overrides: Partial<GameState> = {}): GameState {
    return makeSetupState({
      board: boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'glacier']]),
      boardSetup: {
        tileTierQueue: [],
        tilesRemainingInTier: 0,
        tilePlacerIndex: 0,
        unitsRemainingByPlayerId: { p1: ['city', 'nomad', 'ship'], p2: ['city', 'nomad', 'ship'] },
        unitPlacerIndex: 0,
      },
      ...overrides,
    })
  }

  it("rejects when it isn't this player's turn", () => {
    const state = unitPlacementState()
    const result = placeUnit(state, 'p2', 'city', { q: 0, r: 0 }, emptyUnitContent)
    expect(result.ok).toBe(false)
  })

  it('rejects a unit kind the player has already placed / never had', () => {
    const state = unitPlacementState()
    const result = placeUnit(state, 'p1', 'temple', { q: 0, r: 0 }, emptyUnitContent)
    expect(result.ok).toBe(false)
  })

  it('rejects Ship placed off Water', () => {
    const state = unitPlacementState()
    const result = placeUnit(state, 'p1', 'ship', { q: 0, r: 0 }, emptyUnitContent)
    expect(result.ok).toBe(false)
  })

  it('rejects City/Nomad placed on Glacier', () => {
    const state = unitPlacementState()
    const cityResult = placeUnit(state, 'p1', 'city', { q: 2, r: 0 }, emptyUnitContent)
    expect(cityResult.ok).toBe(false)
  })

  it('rejects City/Nomad placed on Water (only Ship may start on Water)', () => {
    const state = unitPlacementState()
    const cityResult = placeUnit(state, 'p1', 'city', { q: 1, r: 0 }, emptyUnitContent)
    expect(cityResult.ok).toBe(false)

    const nomadResult = placeUnit(state, 'p1', 'nomad', { q: 1, r: 0 }, emptyUnitContent)
    expect(nomadResult.ok).toBe(false)
  })

  it('rejects placing on an already-occupied hex', () => {
    let state = unitPlacementState()
    const first = placeUnit(state, 'p1', 'city', { q: 0, r: 0 }, emptyUnitContent)
    if (!first.ok) throw new Error('setup failed')
    state = first.state

    const second = placeUnit(state, 'p2', 'city', { q: 0, r: 0 }, emptyUnitContent)
    expect(second.ok).toBe(false)
  })

  it('places City on Plain, syncs its card into hand, and advances to the next player', () => {
    const state = unitPlacementState()
    const result = placeUnit(state, 'p1', 'city', { q: 0, r: 0 }, emptyUnitContent)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const unit = result.state.units.find((u) => u.ownerId === 'p1' && u.kind === 'city')
    expect(unit?.coord).toEqual({ q: 0, r: 0 })
    expect(unit?.movement.isMobile).toBe(false)

    const p1 = result.state.players.find((p) => p.id === 'p1')!
    expect(p1.handCardIds).toContain(cardIdFor('p1', 'city'))
    expect(p1.supplyCardIds).not.toContain(cardIdFor('p1', 'city'))

    expect(result.state.boardSetup?.unitsRemainingByPlayerId.p1).toEqual(['nomad', 'ship'])
    expect(currentUnitPlacerId(result.state)).toBe('p2')
  })

  it('places Ship on Water', () => {
    const state = unitPlacementState()
    const result = placeUnit(state, 'p1', 'ship', { q: 1, r: 0 }, emptyUnitContent)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.units.find((u) => u.kind === 'ship')?.coord).toEqual({ q: 1, r: 0 })
  })

  it('transitions to active status and begins round 1 once every player has placed all three units', () => {
    let state = unitPlacementState({
      boardSetup: {
        tileTierQueue: [],
        tilesRemainingInTier: 0,
        tilePlacerIndex: 0,
        unitsRemainingByPlayerId: { p1: ['ship'], p2: [] },
        unitPlacerIndex: 0,
      },
    })

    const result = placeUnit(state, 'p1', 'ship', { q: 1, r: 0 }, emptyUnitContent)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe('active')
    expect(result.state.boardSetup).toBeNull()
    expect(result.state.roundPhase).toBe('selectCards')
  })

  it('is rejected while tiles are still being placed', () => {
    const state = unitPlacementState({
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 2, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })
    const result = placeUnit(state, 'p1', 'city', { q: 0, r: 0 }, emptyUnitContent)
    expect(result.ok).toBe(false)
  })
})

/** Brute-force search (small board, test-only) for any placement of `shapeCells` that satisfies isLegalTilePlacement plus the water-expansion-only rules (touches >=2 existing Sea, doesn't enclose empty hexes). */
function findAnyValidWaterExpansionPlacement(board: Board, shapeCells: Coordinate[]): { anchor: Coordinate; rotationSteps: number } {
  for (let q = -5; q <= 20; q++) {
    for (let r = -5; r <= 20; r++) {
      for (let rotationSteps = 0; rotationSteps < 6; rotationSteps++) {
        const cells = placedShapeCells(shapeCells, { q, r }, rotationSteps)
        if (!isLegalTilePlacement(board, cells, null)) continue
        if (!touchesEnoughExistingTerrain(board, cells, 'water', 2)) continue
        if (wouldEncloseEmptyHexes(board, cells)) continue
        return { anchor: { q, r }, rotationSteps }
      }
    }
  }
  throw new Error('No valid water-expansion placement found in search range')
}

describe('against real content/terrain.json', () => {
  it('runs a small real board-setup sequence end to end without errors', () => {
    const water = terrainJson.terrainTypes.find((t) => t.id === 'water')!
    const plain = terrainJson.terrainTypes.find((t) => t.id === 'plain')!
    const startingWaterShapeCells = water.shapeGroups.find((g) => g.id === 'initial')!.shapes[0].cells
    const waterExpansionCells = water.shapeGroups.find((g) => g.id === 'expansion')!.shapes[0].cells
    const plainCells = plain.shapeGroups[0].shapes[0].cells

    const content: BoardGenerationContent = {
      startingWaterShapeCells,
      tiers: [
        { terrain: 'water', shapeCells: waterExpansionCells, placesOn: null, poolSize: 2 },
        { terrain: 'plain', shapeCells: plainCells, placesOn: ['water'], poolSize: 2 },
      ],
    }

    const base = makeSetupState({ status: 'lobby', boardSetup: null })
    let state = beginBoardSetup(base, content)
    expect(state.boardSetup?.tileTierQueue).toEqual(['water', 'plain'])

    // Water-expansion tiles must touch existing Sea (see WATER_EXPANSION_MIN_TOUCHING)
    // and can't seal off empty hexes, so search near the seeded hourglasses
    // instead of placing far away like before those rules existed.
    let placement = findAnyValidWaterExpansionPlacement(state.board, waterExpansionCells)
    let result = placeTile(state, 'p1', placement.anchor, placement.rotationSteps, content)
    if (!result.ok) throw new Error(`setup failed: ${result.error}`)
    state = result.state

    placement = findAnyValidWaterExpansionPlacement(state.board, waterExpansionCells)
    result = placeTile(state, 'p2', placement.anchor, placement.rotationSteps, content)
    if (!result.ok) throw new Error(`setup failed: ${result.error}`)
    state = result.state

    expect(state.boardSetup?.tileTierQueue).toEqual(['plain'])
  })
})
