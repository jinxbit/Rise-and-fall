import { describe, expect, it } from 'vitest'
import { createEmptyBoard, setTile } from '../board'
import { applyUnitActionEffect } from '../unitActions'
import type { UnitAction, UnitContent } from '../unitContent'
import type { Coordinate, GameState, Player, Terrain, Unit } from '../types'

function makePlayer(id: string, overrides: Partial<Player> = {}): Player {
  return {
    id,
    authUserId: null,
    displayName: id,
    color: 'red',
    handCardIds: [],
    currentlyPlayedCardId: null,
    discardCardIds: [],
    supplyCardIds: [],
    declineCardIds: [],
    eliminated: false,
    resources: { gold: 0, wood: 0, stone: 0 },
    ...overrides,
  }
}

let unitCounter = 0
function makeUnit(ownerId: string, kind: string, coord: Coordinate, overrides: Partial<Unit['movement']> = {}): Unit {
  unitCounter += 1
  return {
    id: `unit_${unitCounter}`,
    ownerId,
    kind,
    coord,
    movement: { isMobile: true, terrains: [], canCrossCliffs: false, ...overrides },
    traits: [],
  }
}

function boardOf(cells: Array<[number, number, Terrain]>) {
  let board = createEmptyBoard('hex')
  for (const [q, r, terrain] of cells) board = setTile(board, { q, r }, terrain)
  return board
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: 'g1',
    playMode: 'hotseat',
    status: 'active',
    turn: 1,
    activePlayerId: null,
    roundPhase: 'actions',
    chosenCardIdByPlayerId: {},
    pendingPlayerIds: [],
    resolvedUnitIdsThisTurn: [],
    turnOrder: ['p1', 'p2'],
    board: createEmptyBoard('hex'),
    players: [makePlayer('p1'), makePlayer('p2')],
    units: [],
    cards: {},
    resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
    ...overrides,
  }
}

const emptyContent: UnitContent = {
  actionsByKind: {},
  movementByKind: {},
  terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
  resourceCaps: { gold: null, wood: 5, stone: 5 },
  unitSupplyCaps: {},
}

function goldOf(state: GameState, playerId: string): number {
  return state.players.find((p) => p.id === playerId)!.resources.gold
}

describe('applyUnitActionEffect — income', () => {
  const goldByTerrainAction: UnitAction = {
    id: 'generate-income',
    name: 'Generate Income',
    description: '',
    effect: { actionType: 'income', goldByTerrain: { forest: 3, plain: 2 } },
  }

  it('gains gold based on the terrain the unit occupies', () => {
    const board = boardOf([[0, 0, 'forest']])
    const state = makeState({ board, units: [makeUnit('p1', 'city', { q: 0, r: 0 })] })

    const next = applyUnitActionEffect(state, 'p1', 'city', goldByTerrainAction, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(3)
  })

  it('gains nothing on a terrain missing from goldByTerrain', () => {
    const board = boardOf([[0, 0, 'mountain']])
    const state = makeState({ board, units: [makeUnit('p1', 'city', { q: 0, r: 0 })] })

    const next = applyUnitActionEffect(state, 'p1', 'city', goldByTerrainAction, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(0)
  })

  it('does not crash when the unit sits on a coordinate with no tile', () => {
    const state = makeState({ units: [makeUnit('p1', 'city', { q: 9, r: 9 })] })

    const next = applyUnitActionEffect(state, 'p1', 'city', goldByTerrainAction, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(0)
  })

  it('gold per adjacent own unit, excluding a kind', () => {
    // Excludes 'merchant' rather than the acting kind itself ('temple') —
    // a second Temple neighbor would itself be a second acting unit
    // (every unit of the acting kind acts), which would confuse this test.
    const action: UnitAction = {
      id: 'generate-income',
      name: 'Generate Income',
      description: '',
      effect: { actionType: 'income', goldPerAdjacentOwnUnit: 2, excludeUnitTypes: ['merchant'] },
    }
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [0, 1, 'plain'],
      [-1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      units: [
        makeUnit('p1', 'temple', { q: 0, r: 0 }),
        makeUnit('p1', 'nomad', { q: 1, r: 0 }), // own, counted
        makeUnit('p1', 'merchant', { q: 0, r: 1 }), // own, excluded kind
        makeUnit('p2', 'nomad', { q: -1, r: 0 }), // enemy, not counted
      ],
    })

    const next = applyUnitActionEffect(state, 'p1', 'temple', action, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(2)
  })

  it('gold per adjacent unit, own vs enemy at different rates', () => {
    const action: UnitAction = {
      id: 'generate-income',
      name: 'Generate Income',
      description: '',
      effect: { actionType: 'income', goldPerAdjacentUnit: { own: { city: 3 }, enemy: { city: 5 } } },
    }
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'plain'],
      [0, 1, 'plain'],
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'merchant', { q: 0, r: 0 }), makeUnit('p1', 'city', { q: 1, r: 0 }), makeUnit('p2', 'city', { q: 0, r: 1 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'merchant', action, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(3 + 5)
  })

  it("counts a City sharing the Merchant's own hex too, not just truly adjacent ones (bug: Merchant is the only unit that can end a move stacked on a City — canEndMoveOnUnitTypes — but that City was silently excluded since it's not one of `adjacentUnits`)", () => {
    const action: UnitAction = {
      id: 'generate-income',
      name: 'Generate Income',
      description: '',
      effect: { actionType: 'income', goldPerAdjacentUnit: { own: { city: 3 }, enemy: { city: 5 } } },
    }
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [-1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      units: [
        makeUnit('p1', 'merchant', { q: 0, r: 0 }),
        makeUnit('p2', 'city', { q: 0, r: 0 }), // shares the Merchant's own hex
        makeUnit('p2', 'city', { q: 1, r: 0 }), // truly adjacent
        makeUnit('p2', 'city', { q: -1, r: 0 }), // truly adjacent
      ],
    })

    const next = applyUnitActionEffect(state, 'p1', 'merchant', action, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(5 + 5 + 5)
  })

  it('applies independently to every unit of the kind the player owns', () => {
    const board = boardOf([
      [0, 0, 'forest'],
      [5, 5, 'plain'],
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'city', { q: 0, r: 0 }), makeUnit('p1', 'city', { q: 5, r: 5 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'city', goldByTerrainAction, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(3 + 2)
  })
})

describe('applyUnitActionEffect — produce', () => {
  const action: UnitAction = {
    id: 'produce-resource',
    name: 'Produce Resource',
    description: '',
    effect: { actionType: 'produce', resourceByTerrain: { forest: { wood: 1 }, mountain: { stone: 1 } } },
  }

  it('gains the resource for the terrain occupied', () => {
    const board = boardOf([[0, 0, 'forest']])
    const state = makeState({ board, units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, emptyContent)

    expect(next.players.find((p) => p.id === 'p1')!.resources.wood).toBe(1)
  })

  it('gains nothing on a terrain not in resourceByTerrain', () => {
    const board = boardOf([[0, 0, 'water']])
    const state = makeState({ board, units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, emptyContent)

    expect(next.players.find((p) => p.id === 'p1')!.resources).toEqual({ gold: 0, wood: 0, stone: 0 })
  })

  it('respects the player cap (Wood/Stone: 5)', () => {
    const board = boardOf([[0, 0, 'forest']])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, emptyContent)

    expect(next.players.find((p) => p.id === 'p1')!.resources.wood).toBe(5)
  })

  it('respects the bank running out', () => {
    const board = boardOf([[0, 0, 'forest']])
    const state = makeState({ board, resourceBank: { gold: 0, wood: 0, stone: 0 }, units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, emptyContent)

    expect(next.players.find((p) => p.id === 'p1')!.resources.wood).toBe(0)
  })

  it('returns the exact same state when already at the cap — a true no-op, not just a value-identical one (regression: applyResolveUnitAction detects a no-op via state reference equality, so a fully-clamped credit used to still count as "resolved")', () => {
    const board = boardOf([[0, 0, 'forest']])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, emptyContent)

    expect(next).toBe(state)
  })
})

describe('applyUnitActionEffect — trade (Ship)', () => {
  const action: UnitAction = { id: 'trade', name: 'Trade', description: '', effect: { actionType: 'trade', goldPerCity: 5 } }

  it('gains gold per adjacent City regardless of owner (see UnitActions.md open question)', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'plain'],
      [0, 1, 'plain'],
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'ship', { q: 0, r: 0 }), makeUnit('p1', 'city', { q: 1, r: 0 }), makeUnit('p2', 'city', { q: 0, r: 1 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'ship', action, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(10)
  })

  it('counts a City adjacent to any hex in the whole contiguous sea area, not just the hex the Ship sits on', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'], // same sea area as (0,0), reachable by water-to-water BFS
      [2, 0, 'plain'], // adjacent to (1,0) only, not to the Ship's own hex
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'ship', { q: 0, r: 0 }), makeUnit('p2', 'city', { q: 2, r: 0 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'ship', action, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(5)
  })

  it('counts a City across a cliff edge from the sea area', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [0, -1, 'mountain'], // level 3 vs water's level 0: a cliff edge, still counts
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'ship', { q: 0, r: 0 }), makeUnit('p2', 'city', { q: 0, r: -1 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'ship', action, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(5)
  })

  it('does not count a City next to a separate, disconnected sea area', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'plain'], // land gap breaks the water-to-water chain
      [2, 0, 'water'], // a different sea area
      [3, 0, 'plain'],
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'ship', { q: 0, r: 0 }), makeUnit('p2', 'city', { q: 3, r: 0 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'ship', action, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(0)
  })

  it('counts each City once even if it borders multiple hexes of the sea area', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [1, -1, 'plain'], // adjacent to both (0,0) and (1,0)
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'ship', { q: 0, r: 0 }), makeUnit('p2', 'city', { q: 1, r: -1 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'ship', action, {}, emptyContent)

    expect(goldOf(next, 'p1')).toBe(5)
  })
})

describe('applyUnitActionEffect — create', () => {
  const action: UnitAction = {
    id: 'create-nomad',
    name: 'Create Nomad',
    description: '',
    effect: { actionType: 'create', targetUnit: 'nomad', targetHex: { location: 'adj' }, cost: { gold: 2 } },
  }
  const content: UnitContent = {
    ...emptyContent,
    movementByKind: { nomad: { isMobile: true, terrains: ['plain'], canCrossCliffs: false, moveDistance: 1 } },
  }

  it('creates a new unit on a legal empty adjacent hex and pays the cost', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'city', { q: 0, r: 0 })],
    })
    const city = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: { q: 1, r: 0 } }, content)

    expect(next.units.some((u) => u.kind === 'nomad' && u.ownerId === 'p1' && u.coord.q === 1 && u.coord.r === 0)).toBe(true)
    expect(next.players.find((p) => p.id === 'p1')!.resources.gold).toBe(3)
  })

  it('never creates a non-Ship unit on a Water hex, even though the action itself has no terrain restriction', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'water'],
    ])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'city', { q: 0, r: 0 })],
    })
    const city = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: { q: 1, r: 0 } }, content)

    expect(next.units).toHaveLength(1)
    expect(next.players.find((p) => p.id === 'p1')!.resources.gold).toBe(5)
  })

  it('does allow creating a Ship on a Water hex', () => {
    const shipAction: UnitAction = {
      id: 'create-ship',
      name: 'Create Ship',
      description: '',
      effect: { actionType: 'create', targetUnit: 'ship', targetHex: { location: 'adj' }, cost: {} },
    }
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'water'],
    ])
    const state = makeState({ board, units: [makeUnit('p1', 'city', { q: 0, r: 0 })] })
    const city = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'city', shipAction, { [city.id]: { q: 1, r: 0 } }, content)

    expect(next.units.some((u) => u.kind === 'ship' && u.coord.q === 1 && u.coord.r === 0)).toBe(true)
  })

  it('never creates a non-Mountaineer unit on a Glacier hex, even though the action itself has no terrain restriction', () => {
    // Mountain, not Plain, adjacent to Glacier: their terrain levels (3 and
    // 4) are only 1 apart, so this isn't also blocked by the unrelated
    // cliff rule (crossesCliff) — the rejection below is only ever about
    // the Glacier/Mountaineer restriction being tested here.
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'glacier'],
    ])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'city', { q: 0, r: 0 })],
    })
    const city = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: { q: 1, r: 0 } }, content)

    expect(next.units).toHaveLength(1)
    expect(next.players.find((p) => p.id === 'p1')!.resources.gold).toBe(5)
  })

  it('does allow creating a Mountaineer on a Glacier hex', () => {
    const mountaineerAction: UnitAction = {
      id: 'create-mountaineer',
      name: 'Create Mountaineer',
      description: '',
      effect: { actionType: 'create', targetUnit: 'mountaineer', targetHex: { location: 'adj' }, cost: {} },
    }
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'glacier'],
    ])
    const state = makeState({ board, units: [makeUnit('p1', 'city', { q: 0, r: 0 })] })
    const city = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'city', mountaineerAction, { [city.id]: { q: 1, r: 0 } }, content)

    expect(next.units.some((u) => u.kind === 'mountaineer' && u.coord.q === 1 && u.coord.r === 0)).toBe(true)
  })

  it("derives the new unit's id from state.idSequence (not a hidden module counter) and advances it by one", () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    // A nonzero starting idSequence simulates picking up a game already in
    // progress — proves the id comes from state, not a counter that would
    // restart at 0 in a fresh process (see idSequence.ts).
    const state = makeState({
      board,
      idSequence: 41,
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'city', { q: 0, r: 0 })],
    })
    const city = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: { q: 1, r: 0 } }, content)

    expect(next.idSequence).toBe(42)
    expect(next.units.find((u) => u.kind === 'nomad')?.id).toBe('created_unit_42')
  })

  it('does nothing when no target was supplied for the unit', () => {
    const board = boardOf([[0, 0, 'plain']])
    const state = makeState({ board, units: [makeUnit('p1', 'city', { q: 0, r: 0 })] })

    const next = applyUnitActionEffect(state, 'p1', 'city', action, {}, content)

    expect(next.units).toHaveLength(1)
  })

  it('skips a target that is not adjacent', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [5, 5, 'plain'],
    ])
    const state = makeState({ board, units: [makeUnit('p1', 'city', { q: 0, r: 0 })] })
    const city = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: { q: 5, r: 5 } }, content)

    expect(next.units).toHaveLength(1)
  })

  it('skips a target hex that is already occupied', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'city', { q: 0, r: 0 }), makeUnit('p2', 'ship', { q: 1, r: 0 })],
    })
    const city = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: { q: 1, r: 0 } }, content)

    expect(next.units).toHaveLength(2)
  })

  it('skips when the target is across a cliff edge — creation can never cross a cliff', () => {
    const board = boardOf([
      [0, 0, 'water'], // level 0
      [1, 0, 'mountain'], // level 3 — diff 3, a cliff
    ])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'city', { q: 0, r: 0 })],
    })
    const city = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: { q: 1, r: 0 } }, content)

    expect(next.units).toHaveLength(1)
  })

  it('still blocks a cliff even for an acting unit that can normally cross cliffs (Mountaineer)', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'mountain'],
    ])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'mountaineer', { q: 0, r: 0 }, { canCrossCliffs: true })],
    })
    const mountaineer = state.units[0]
    const mountaineerContent: UnitContent = {
      ...content,
      movementByKind: { ...content.movementByKind, mountaineer: { isMobile: true, terrains: [], canCrossCliffs: true } },
    }

    const next = applyUnitActionEffect(state, 'p1', 'mountaineer', action, { [mountaineer.id]: { q: 1, r: 0 } }, mountaineerContent)

    expect(next.units).toHaveLength(1)
  })

  it('skips when the player cannot afford the cost', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 0, wood: 0, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'city', { q: 0, r: 0 })],
    })
    const city = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: { q: 1, r: 0 } }, content)

    expect(next.units).toHaveLength(1)
  })

  it('skips when the player already has the target kind at its supply cap', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'city', { q: 0, r: 0 }), makeUnit('p1', 'nomad', { q: 9, r: 9 })],
    })
    const city = state.units[0]
    const cappedContent: UnitContent = { ...content, unitSupplyCaps: { nomad: 1 } }

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: { q: 1, r: 0 } }, cappedContent)

    expect(next.units).toHaveLength(2)
  })

  it('applies independently to every acting unit — one with a target, one without', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [5, 5, 'plain'],
    ])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 10, wood: 0, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'city', { q: 0, r: 0 }), makeUnit('p1', 'city', { q: 5, r: 5 })],
    })
    const [cityA] = state.units

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [cityA.id]: { q: 1, r: 0 } }, content)

    expect(next.units.filter((u) => u.kind === 'nomad')).toHaveLength(1)
    expect(next.players.find((p) => p.id === 'p1')!.resources.gold).toBe(8)
  })
})

describe('applyUnitActionEffect — transform', () => {
  const content: UnitContent = {
    ...emptyContent,
    movementByKind: {
      nomad: { isMobile: true, terrains: ['plain'], canCrossCliffs: false },
      ship: { isMobile: true, terrains: ['water'], canCrossCliffs: false },
    },
  }

  it("self-location: replaces the unit in place when the terrain qualifies", () => {
    const action: UnitAction = {
      id: 'transform-to-city',
      name: 'Transform to City',
      description: '',
      effect: { actionType: 'transform', targetUnit: 'city', targetHex: { terrainType: ['plain', 'forest'], location: 'self' }, destroySelf: true, cost: { wood: 1 } },
    }
    const board = boardOf([[0, 0, 'plain']])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 0, wood: 1, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })],
    })
    const nomad = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, content)

    expect(next.units).toHaveLength(1)
    expect(next.units[0].kind).toBe('city')
    expect(next.units[0].coord).toEqual({ q: 0, r: 0 })
    expect(next.units.some((u) => u.id === nomad.id)).toBe(false)
    expect(next.players.find((p) => p.id === 'p1')!.resources.wood).toBe(0)
  })

  it('self-location: does nothing when the current terrain does not qualify', () => {
    const action: UnitAction = {
      id: 'transform-to-city',
      name: 'Transform to City',
      description: '',
      effect: { actionType: 'transform', targetUnit: 'city', targetHex: { terrainType: ['plain', 'forest'], location: 'self' }, destroySelf: true, cost: {} },
    }
    const board = boardOf([[0, 0, 'water']])
    const state = makeState({ board, units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, content)

    expect(next.units).toHaveLength(1)
    expect(next.units[0].kind).toBe('nomad')
  })

  it('adjacent-location: transforms onto the target hex, vacating the original', () => {
    const action: UnitAction = {
      id: 'transform-to-ship',
      name: 'Transform to Ship',
      description: '',
      effect: { actionType: 'transform', targetUnit: 'ship', targetHex: { terrainType: ['water'], location: 'adj' }, destroySelf: true, cost: { wood: 1 } },
    }
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'water'],
    ])
    const state = makeState({
      board,
      players: [makePlayer('p1', { resources: { gold: 0, wood: 1, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })],
    })
    const nomad = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomad.id]: { q: 1, r: 0 } }, content)

    expect(next.units).toHaveLength(1)
    expect(next.units[0]).toMatchObject({ kind: 'ship', coord: { q: 1, r: 0 } })
  })

  it('adjacent-location: skips a target hex with the wrong terrain', () => {
    const action: UnitAction = {
      id: 'transform-to-ship',
      name: 'Transform to Ship',
      description: '',
      effect: { actionType: 'transform', targetUnit: 'ship', targetHex: { terrainType: ['water'], location: 'adj' }, destroySelf: true, cost: {} },
    }
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({ board, units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })] })
    const nomad = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomad.id]: { q: 1, r: 0 } }, content)

    expect(next.units[0].kind).toBe('nomad')
  })

  it('adjacent-location: always blocked by a cliff, even for an acting unit that can normally cross cliffs', () => {
    const action: UnitAction = {
      id: 'transform-to-ship',
      name: 'Transform to Ship',
      description: '',
      effect: { actionType: 'transform', targetUnit: 'ship', targetHex: { terrainType: ['water'], location: 'adj' }, destroySelf: true, cost: {} },
    }
    const board = boardOf([
      [0, 0, 'mountain'], // level 3
      [1, 0, 'water'], // level 0 — diff 3, a cliff
    ])
    const crossingContent: UnitContent = { ...content, movementByKind: { ...content.movementByKind, nomad: { ...content.movementByKind.nomad, canCrossCliffs: true } } }
    const state = makeState({ board, units: [makeUnit('p1', 'nomad', { q: 0, r: 0 }, { canCrossCliffs: true })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [state.units[0].id]: { q: 1, r: 0 } }, crossingContent)

    expect(next.units[0].kind).toBe('nomad')
  })

  it("a destroySelf transform (net-zero units.length change) never reuses the removed unit's id for the next created unit", () => {
    const action: UnitAction = {
      id: 'transform-to-ship',
      name: 'Transform to Ship',
      description: '',
      effect: { actionType: 'transform', targetUnit: 'ship', targetHex: { terrainType: ['water'], location: 'adj' }, destroySelf: true, cost: {} },
    }
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'water'],
      [2, 0, 'plain'],
      [3, 0, 'water'],
    ])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 })
    const state = makeState({ board, units: [nomadA] })

    // nomadA -> ship: units.length stays 1 (one removed, one added), which
    // would trip up an id scheme derived from units.length — idSequence
    // must still advance regardless (see idSequence.ts).
    const afterTransform = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomadA.id]: { q: 1, r: 0 } }, content)
    expect(afterTransform.units).toHaveLength(1)
    const shipId = afterTransform.units[0].id

    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 })
    const secondState = { ...afterTransform, units: [...afterTransform.units, nomadB] }
    const afterSecondTransform = applyUnitActionEffect(secondState, 'p1', 'nomad', action, { [nomadB.id]: { q: 3, r: 0 } }, content)

    const secondShip = afterSecondTransform.units.find((u) => u.kind === 'ship' && u.id !== shipId)
    expect(secondShip).toBeDefined()
    expect(secondShip!.id).not.toBe(shipId)
  })

  it('never transforms into a non-Ship unit on Water, even if the action content mistakenly allows the terrain', () => {
    const action: UnitAction = {
      id: 'transform-to-city-on-water',
      name: 'Transform to City (bad content)',
      description: '',
      // A real units.json action would never list 'water' here for a
      // non-Ship targetUnit — this simulates a future content mistake to
      // prove the engine still refuses it (see isCreationAllowedOnTerrain).
      effect: { actionType: 'transform', targetUnit: 'city', targetHex: { terrainType: ['water'], location: 'adj' }, destroySelf: true, cost: {} },
    }
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'water'],
    ])
    const state = makeState({ board, units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })] })
    const nomad = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomad.id]: { q: 1, r: 0 } }, content)

    expect(next.units).toHaveLength(1)
    expect(next.units[0].kind).toBe('nomad')
  })

  it('never transforms into a non-Mountaineer unit on Glacier, even if the action content mistakenly allows the terrain', () => {
    const action: UnitAction = {
      id: 'transform-to-city-on-glacier',
      name: 'Transform to City (bad content)',
      description: '',
      // A real units.json action would never list 'glacier' here for a
      // non-Mountaineer targetUnit — this simulates a future content
      // mistake to prove the engine still refuses it.
      effect: { actionType: 'transform', targetUnit: 'city', targetHex: { terrainType: ['glacier'], location: 'adj' }, destroySelf: true, cost: {} },
    }
    // Mountain, not Plain, adjacent to Glacier — see the analogous create
    // test above for why (isolates this from the unrelated cliff rule).
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'glacier'],
    ])
    const state = makeState({ board, units: [makeUnit('p1', 'nomad', { q: 0, r: 0 })] })
    const nomad = state.units[0]

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomad.id]: { q: 1, r: 0 } }, content)

    expect(next.units).toHaveLength(1)
    expect(next.units[0].kind).toBe('nomad')
  })
})

describe('applyUnitActionEffect — convert (Temple)', () => {
  const action: UnitAction = {
    id: 'convert-enemy-unit',
    name: 'Convert Enemy Unit',
    description: '',
    effect: { actionType: 'convert', targetHex: { location: 'adj' }, targetOwner: 'enemy', targetMobileOnly: true, cost: {} },
  }
  const content: UnitContent = {
    ...emptyContent,
    movementByKind: {
      nomad: { isMobile: true, terrains: [], canCrossCliffs: false },
      temple: { isMobile: false, terrains: [], canCrossCliffs: false },
    },
  }

  it('converts an adjacent enemy mobile unit', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({ board, units: [makeUnit('p1', 'temple', { q: 0, r: 0 }), makeUnit('p2', 'nomad', { q: 1, r: 0 })] })
    const [temple, enemyUnit] = state.units

    const next = applyUnitActionEffect(state, 'p1', 'temple', action, { [temple.id]: enemyUnit.coord }, content)

    expect(next.units.find((u) => u.id === enemyUnit.id)!.ownerId).toBe('p1')
  })

  it("does not convert an adjacent enemy unit once the capturer's own supply of that kind is full (bug: capturing an enemy unit never checked the capturer's supply at all, since it has no resultUnit override to change kind)", () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [9, 9, 'plain'],
    ])
    const state = makeState({
      board,
      units: [
        makeUnit('p1', 'temple', { q: 0, r: 0 }),
        makeUnit('p2', 'nomad', { q: 1, r: 0 }),
        // p1 already has a Nomad elsewhere, filling their cap of 1.
        makeUnit('p1', 'nomad', { q: 9, r: 9 }),
      ],
    })
    const [temple, enemyUnit] = state.units
    const cappedContent: UnitContent = { ...content, unitSupplyCaps: { nomad: 1 } }

    const next = applyUnitActionEffect(state, 'p1', 'temple', action, { [temple.id]: enemyUnit.coord }, cappedContent)

    expect(next.units.find((u) => u.id === enemyUnit.id)!.ownerId).toBe('p2')
  })

  it('does not convert an adjacent own unit', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({ board, units: [makeUnit('p1', 'temple', { q: 0, r: 0 }), makeUnit('p1', 'nomad', { q: 1, r: 0 })] })
    const [temple, ownUnit] = state.units

    const next = applyUnitActionEffect(state, 'p1', 'temple', action, { [temple.id]: ownUnit.coord }, content)

    expect(next.units.find((u) => u.kind === 'nomad')!.ownerId).toBe('p1')
  })

  it('does not convert an immobile enemy unit when targetMobileOnly is set', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({ board, units: [makeUnit('p1', 'temple', { q: 0, r: 0 }), makeUnit('p2', 'temple', { q: 1, r: 0 })] })
    const [temple, enemyTemple] = state.units

    const next = applyUnitActionEffect(state, 'p1', 'temple', action, { [temple.id]: enemyTemple.coord }, content)

    expect(next.units.find((u) => u.id === enemyTemple.id)!.ownerId).toBe('p2')
  })

  describe('costByTargetKind — cost varies by the target unit\'s own kind', () => {
    const actionWithVaryingCost: UnitAction = {
      id: 'convert-enemy-unit',
      name: 'Convert Enemy Unit',
      description: '',
      effect: {
        actionType: 'convert',
        targetHex: { location: 'adj' },
        targetOwner: 'enemy',
        targetMobileOnly: true,
        cost: { gold: 999 }, // fallback, should never be used — every mobile kind below has its own entry
        costByTargetKind: { nomad: { gold: 2 }, mountaineer: { gold: 3 }, merchant: { gold: 5 }, ship: { gold: 5 } },
      },
    }
    const content: UnitContent = {
      ...emptyContent,
      movementByKind: {
        nomad: { isMobile: true, terrains: [], canCrossCliffs: false },
        ship: { isMobile: true, terrains: ['water'], canCrossCliffs: false },
        temple: { isMobile: false, terrains: [], canCrossCliffs: false },
      },
    }

    it('charges the cost keyed by the target\'s kind, not the flat fallback cost', () => {
      const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
      const state = makeState({
        board,
        players: [makePlayer('p1', { resources: { gold: 2, wood: 0, stone: 0 } }), makePlayer('p2')],
        units: [makeUnit('p1', 'temple', { q: 0, r: 0 }), makeUnit('p2', 'nomad', { q: 1, r: 0 })],
      })
      const [temple, enemyUnit] = state.units

      const next = applyUnitActionEffect(state, 'p1', 'temple', actionWithVaryingCost, { [temple.id]: enemyUnit.coord }, content)

      expect(next.units.find((u) => u.id === enemyUnit.id)!.ownerId).toBe('p1')
      expect(next.players.find((p) => p.id === 'p1')!.resources.gold).toBe(0)
    })

    it('rejects when the player can afford the flat cost but not this specific target\'s cost', () => {
      const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
      const state = makeState({
        board,
        players: [makePlayer('p1', { resources: { gold: 4, wood: 0, stone: 0 } }), makePlayer('p2')],
        units: [makeUnit('p1', 'temple', { q: 0, r: 0 }), makeUnit('p2', 'ship', { q: 1, r: 0 })],
      })
      const [temple, enemyShip] = state.units

      // 4 gold isn't enough for a Ship (costs 5).
      const next = applyUnitActionEffect(state, 'p1', 'temple', actionWithVaryingCost, { [temple.id]: enemyShip.coord }, content)

      expect(next.units.find((u) => u.id === enemyShip.id)!.ownerId).toBe('p2')
      expect(next.players.find((p) => p.id === 'p1')!.resources.gold).toBe(4)
    })
  })
})

describe("applyUnitActionEffect — convert, 'own' (City upgrading an adjacent Nomad)", () => {
  // Per ruling: a City doesn't conjure a Merchant/Mountaineer from
  // nothing — it converts (upgrades) an adjacent Nomad it already
  // controls into one, at the same gold cost as the old (wrong)
  // create-from-nothing version.
  const action: UnitAction = {
    id: 'create-merchant',
    name: 'Convert to Merchant',
    description: '',
    effect: {
      actionType: 'convert',
      targetHex: { location: 'adj' },
      targetOwner: 'own',
      targetMobileOnly: false,
      requiredTargetKind: 'nomad',
      resultUnit: 'merchant',
      cost: { gold: 2 },
    },
  }
  const content: UnitContent = {
    ...emptyContent,
    movementByKind: {
      city: { isMobile: false, terrains: [], canCrossCliffs: false },
      nomad: { isMobile: true, terrains: ['plain', 'forest', 'mountain'], canCrossCliffs: false },
      merchant: { isMobile: true, terrains: ['water', 'plain', 'forest', 'mountain'], canCrossCliffs: false, moveDistance: 4 },
    },
  }

  it('converts an adjacent own Nomad into the target kind in place, paying the cost, without touching the acting City', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'city', { q: 0, r: 0 }), makeUnit('p1', 'nomad', { q: 1, r: 0 })],
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } })],
    })
    const [city, nomad] = state.units

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: nomad.coord }, content)

    expect(next.units).toHaveLength(2)
    expect(next.units.find((u) => u.id === city.id)?.kind).toBe('city')
    const converted = next.units.find((u) => u.id === nomad.id)!
    expect(converted.kind).toBe('merchant')
    expect(converted.coord).toEqual({ q: 1, r: 0 })
    expect(converted.movement).toEqual(content.movementByKind.merchant)
    expect(goldOf(next, 'p1')).toBe(3)
  })

  it('does not convert an adjacent own unit that is not the required kind', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'city', { q: 0, r: 0 }), makeUnit('p1', 'merchant', { q: 1, r: 0 })],
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } })],
    })
    const [city, merchant] = state.units

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: merchant.coord }, content)

    expect(next.units.find((u) => u.id === merchant.id)?.kind).toBe('merchant')
    expect(goldOf(next, 'p1')).toBe(5)
  })

  it('does not convert an adjacent enemy Nomad', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'city', { q: 0, r: 0 }), makeUnit('p2', 'nomad', { q: 1, r: 0 })],
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } }), makePlayer('p2')],
    })
    const [city, enemyNomad] = state.units

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: enemyNomad.coord }, content)

    const stillEnemy = next.units.find((u) => u.id === enemyNomad.id)!
    expect(stillEnemy.kind).toBe('nomad')
    expect(stillEnemy.ownerId).toBe('p2')
  })

  it('is a no-op when the player cannot afford the cost', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'city', { q: 0, r: 0 }), makeUnit('p1', 'nomad', { q: 1, r: 0 })],
      players: [makePlayer('p1', { resources: { gold: 0, wood: 0, stone: 0 } })],
    })
    const [city, nomad] = state.units

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: nomad.coord }, content)

    expect(next.units.find((u) => u.id === nomad.id)?.kind).toBe('nomad')
  })

  it('is a no-op once the target kind is at its supply cap', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const state = makeState({
      board,
      units: [makeUnit('p1', 'city', { q: 0, r: 0 }), makeUnit('p1', 'nomad', { q: 1, r: 0 })],
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } })],
    })
    const [city, nomad] = state.units
    const cappedContent: UnitContent = { ...content, unitSupplyCaps: { merchant: 0 } }

    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: nomad.coord }, cappedContent)

    expect(next.units.find((u) => u.id === nomad.id)?.kind).toBe('nomad')
  })
})

describe('applyUnitActionEffect — trade-resource (Merchant)', () => {
  // Per ruling: a real 1-for-5 conversion. Buy/Sell/Wood/Stone are 4
  // separate actions (resource + mode fixed per action, not a per-unit
  // choice) — each applies uniformly to every Merchant the player owns.
  const sellWood: UnitAction = {
    id: 'sell-wood',
    name: 'Sell Wood',
    description: '',
    effect: { actionType: 'trade-resource', resource: 'wood', mode: 'sell', resourceAmount: 1, goldPerResource: 5 },
  }
  const buyStone: UnitAction = {
    id: 'buy-stone',
    name: 'Buy Stone',
    description: '',
    effect: { actionType: 'trade-resource', resource: 'stone', mode: 'buy', resourceAmount: 1, goldPerResource: 5 },
  }

  it('sells: converts the resource into gold', () => {
    const state = makeState({
      players: [makePlayer('p1', { resources: { gold: 0, wood: 1, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'merchant', { q: 0, r: 0 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'merchant', sellWood, {}, emptyContent)

    expect(next.players.find((p) => p.id === 'p1')!.resources).toEqual({ gold: 5, wood: 0, stone: 0 })
  })

  it('buys: converts gold into the resource', () => {
    const state = makeState({
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'merchant', { q: 0, r: 0 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'merchant', buyStone, {}, emptyContent)

    expect(next.players.find((p) => p.id === 'p1')!.resources).toEqual({ gold: 0, wood: 0, stone: 1 })
  })

  it('sell skips a unit whose player lacks the resource to sell', () => {
    const state = makeState({ units: [makeUnit('p1', 'merchant', { q: 0, r: 0 })] })

    const next = applyUnitActionEffect(state, 'p1', 'merchant', sellWood, {}, emptyContent)

    expect(next.players.find((p) => p.id === 'p1')!.resources).toEqual({ gold: 0, wood: 0, stone: 0 })
  })

  it('buy skips a unit whose player cannot afford the gold', () => {
    const state = makeState({ units: [makeUnit('p1', 'merchant', { q: 0, r: 0 })] })

    const next = applyUnitActionEffect(state, 'p1', 'merchant', buyStone, {}, emptyContent)

    expect(next.players.find((p) => p.id === 'p1')!.resources).toEqual({ gold: 0, wood: 0, stone: 0 })
  })

  it('applies independently to every Merchant the player owns', () => {
    const state = makeState({
      players: [makePlayer('p1', { resources: { gold: 0, wood: 2, stone: 0 } }), makePlayer('p2')],
      units: [makeUnit('p1', 'merchant', { q: 0, r: 0 }), makeUnit('p1', 'merchant', { q: 5, r: 5 })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'merchant', sellWood, {}, emptyContent)

    expect(next.players.find((p) => p.id === 'p1')!.resources).toEqual({ gold: 10, wood: 0, stone: 0 })
  })
})

describe('applyUnitActionEffect — move', () => {
  // Movement is a normal action like any other, chosen from the kind's
  // actions list — no exceptions. Each acting unit moves to its own target
  // hex, same as create/transform/convert's per-unit targets.
  const action: UnitAction = { id: 'move', name: 'Move', description: '', effect: { actionType: 'move' } }

  it('moves a unit to its own legal target destination', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const mover = makeUnit('p1', 'nomad', { q: 0, r: 0 }, { terrains: ['plain'], moveDistance: 1, blockedByUnits: 'all' })
    const state = makeState({ board, units: [mover] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [mover.id]: { q: 1, r: 0 } }, emptyContent)

    expect(next.units.find((u) => u.id === mover.id)?.coord).toEqual({ q: 1, r: 0 })
  })

  it('applies independently to every unit of the kind, each moving to its own target', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [5, 5, 'plain'],
      [6, 5, 'plain'],
    ])
    const first = makeUnit('p1', 'nomad', { q: 0, r: 0 }, { terrains: ['plain'], moveDistance: 1, blockedByUnits: 'all' })
    const second = makeUnit('p1', 'nomad', { q: 5, r: 5 }, { terrains: ['plain'], moveDistance: 1, blockedByUnits: 'all' })
    const state = makeState({ board, units: [first, second] })

    const next = applyUnitActionEffect(
      state,
      'p1',
      'nomad',
      action,
      { [first.id]: { q: 1, r: 0 }, [second.id]: { q: 6, r: 5 } },
      emptyContent,
    )

    expect(next.units.find((u) => u.id === first.id)?.coord).toEqual({ q: 1, r: 0 })
    expect(next.units.find((u) => u.id === second.id)?.coord).toEqual({ q: 6, r: 5 })
  })

  it('is a no-op for a unit with no target supplied — others still act', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [5, 5, 'plain'],
      [6, 5, 'plain'],
    ])
    const noTarget = makeUnit('p1', 'nomad', { q: 0, r: 0 }, { terrains: ['plain'], moveDistance: 1, blockedByUnits: 'all' })
    const withTarget = makeUnit('p1', 'nomad', { q: 5, r: 5 }, { terrains: ['plain'], moveDistance: 1, blockedByUnits: 'all' })
    const state = makeState({ board, units: [noTarget, withTarget] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [withTarget.id]: { q: 6, r: 5 } }, emptyContent)

    expect(next.units.find((u) => u.id === noTarget.id)?.coord).toEqual({ q: 0, r: 0 })
    expect(next.units.find((u) => u.id === withTarget.id)?.coord).toEqual({ q: 6, r: 5 })
  })

  it('is a no-op for an illegal destination', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'water'],
    ])
    const mover = makeUnit('p1', 'nomad', { q: 0, r: 0 }, { terrains: ['plain'], moveDistance: 1, blockedByUnits: 'all' })
    const state = makeState({ board, units: [mover] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [mover.id]: { q: 1, r: 0 } }, emptyContent)

    expect(next.units.find((u) => u.id === mover.id)?.coord).toEqual({ q: 0, r: 0 })
  })
})
