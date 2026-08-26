import { describe, expect, it } from 'vitest'
import { createEmptyBoard, setTile } from '../board'
import { calculateChangedTerritoryHexes, calculateTerrainControlDetail, calculateTerrainControlVP, calculateTerrainControlVPByKind, calculateTerritoryControlByHex } from '../scoring'
import type { Board, Coordinate, Terrain, Unit } from '../types'

function boardOf(cells: Array<[number, number, Terrain]>): Board {
  let board = createEmptyBoard('hex')
  for (const [q, r, terrain] of cells) {
    board = setTile(board, { q, r }, terrain)
  }
  return board
}

let unitCounter = 0
function unitOfKindAt(ownerId: string, coord: Coordinate, kind: string): Unit {
  unitCounter += 1
  return {
    id: `test-unit-${unitCounter}`,
    ownerId,
    kind,
    coord,
    movement: { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }
}

function unitAt(ownerId: string, coord: Coordinate): Unit {
  return unitOfKindAt(ownerId, coord, 'test-kind')
}

describe('calculateTerrainControlVP', () => {
  it('awards the region owner (majority) VP × region hex count', () => {
    // A 3-hex connected water region: (0,0)-(1,0) and (0,0)-(0,1) are both
    // direct axial neighbors, so all three form one region.
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [0, 1, 'water'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 }), unitAt('p2', { q: 0, r: 1 })]

    const vp = calculateTerrainControlVP(board, units, { water: 2 })

    expect(vp).toEqual({ p1: 6 })
  })

  it('scores nothing when no player has a clear majority', () => {
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'mountain'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p2', { q: 1, r: 0 })]

    const vp = calculateTerrainControlVP(board, units, { mountain: 5 })

    expect(vp).toEqual({})
  })

  it('scores nothing for an empty region even with a VP value set', () => {
    const board = boardOf([[0, 0, 'water']])

    const vp = calculateTerrainControlVP(board, [], { water: 3 })

    expect(vp).toEqual({})
  })

  it('does not merge non-adjacent hexes of the same terrain into one region', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [50, 50, 'water'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p2', { q: 50, r: 50 })]

    const vp = calculateTerrainControlVP(board, units, { water: 1 })

    expect(vp).toEqual({ p1: 1, p2: 1 })
  })

  it('does not merge adjacent hexes of different terrain into one region', () => {
    // (2,0) is a direct neighbor of (1,0), but a different terrain, so it
    // must stay its own single-hex region rather than joining the water one.
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [2, 0, 'plain'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 }), unitAt('p2', { q: 2, r: 0 })]

    const vp = calculateTerrainControlVP(board, units, { water: 2, plain: 3 })

    expect(vp).toEqual({ p1: 4, p2: 3 })
  })

  it('treats a terrain id missing from terrainVictoryPoints as worth 0', () => {
    const board = boardOf([[0, 0, 'forest']])
    const units = [unitAt('p1', { q: 0, r: 0 })]

    const vp = calculateTerrainControlVP(board, units, { water: 2 })

    // p1 has a clear majority (sole owner), it's just worth nothing since
    // 'forest' has no entry in terrainVictoryPoints.
    expect(vp).toEqual({ p1: 0 })
  })

  it("counts stacked units individually toward their owner's regional total", () => {
    const board = boardOf([[0, 0, 'plain']])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 0, r: 0 }), unitAt('p2', { q: 0, r: 0 })]

    const vp = calculateTerrainControlVP(board, units, { plain: 4 })

    expect(vp).toEqual({ p1: 4 })
  })

  it('sums VP across multiple regions the same player controls', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [10, 10, 'forest'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 }), unitAt('p1', { q: 10, r: 10 })]

    const vp = calculateTerrainControlVP(board, units, { water: 2, forest: 3 })

    expect(vp).toEqual({ p1: 7 })
  })
})

describe('calculateTerrainControlVP with terrainScoresAs (Glacier -> Mountain)', () => {
  const scoresAs = { glacier: 'mountain' }

  it('merges a glacier hex into an adjacent mountain region instead of breaking it', () => {
    // (0,0) mountain - (1,0) glacier - (2,0) mountain: without the merge,
    // the glacier hex would split this into two 1-hex mountain regions.
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'glacier'],
      [2, 0, 'mountain'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 }), unitAt('p1', { q: 2, r: 0 })]

    const vp = calculateTerrainControlVP(board, units, { mountain: 2 }, scoresAs)

    expect(vp).toEqual({ p1: 6 })
  })

  it('does not score a glacier-only region on its own — it scores as mountain', () => {
    const board = boardOf([
      [0, 0, 'glacier'],
      [1, 0, 'glacier'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 })]

    // Only 'mountain' has a VP value; a naive "glacier" lookup would score 0.
    const vp = calculateTerrainControlVP(board, units, { mountain: 3, glacier: 999 }, scoresAs)

    expect(vp).toEqual({ p1: 6 })
  })

  it('counts glacier and mountain units together toward the merged region majority', () => {
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'glacier'],
    ])
    // p1 has 1 unit on the mountain hex, p2 has 1 on the glacier hex — tied
    // across the merged region, so nobody has a majority.
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p2', { q: 1, r: 0 })]

    const vp = calculateTerrainControlVP(board, units, { mountain: 5 }, scoresAs)

    expect(vp).toEqual({})
  })

  it('without terrainScoresAs, glacier and mountain stay separate regions (default identity)', () => {
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'glacier'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 })]

    const vp = calculateTerrainControlVP(board, units, { mountain: 2, glacier: 4 })

    expect(vp).toEqual({ p1: 6 })
  })
})

describe('calculateTerrainControlDetail', () => {
  it('itemizes the same result calculateTerrainControlVP sums, one entry per (player, terrain)', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [0, 1, 'water'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 }), unitAt('p2', { q: 0, r: 1 })]

    const detail = calculateTerrainControlDetail(board, units, { water: 2 })

    expect(detail).toEqual({ p1: [{ terrain: 'water', hexCount: 3, vp: 6 }] })
  })

  it('combines separate regions of the same effective terrain into one entry (hexCount and vp both summed)', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [10, 10, 'forest'],
      [11, 10, 'forest'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 }), unitAt('p1', { q: 10, r: 10 }), unitAt('p1', { q: 11, r: 10 })]

    const detail = calculateTerrainControlDetail(board, units, { water: 2, forest: 3 })

    expect(detail.p1).toEqual(
      expect.arrayContaining([
        { terrain: 'water', hexCount: 2, vp: 4 },
        { terrain: 'forest', hexCount: 2, vp: 6 },
      ]),
    )
    expect(detail.p1).toHaveLength(2)
  })

  it('omits a player entirely when they hold no terrain majority anywhere', () => {
    const board = boardOf([[0, 0, 'mountain']])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p2', { q: 0, r: 0 })]

    // Tied on the one region — nobody has a majority.
    expect(calculateTerrainControlDetail(board, units, { mountain: 5 })).toEqual({})
  })

  it('merges a glacier region into the mountain entry it scores as, same as calculateTerrainControlVP', () => {
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'glacier'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 })]

    const detail = calculateTerrainControlDetail(board, units, { mountain: 2 }, { glacier: 'mountain' })

    expect(detail).toEqual({ p1: [{ terrain: 'mountain', hexCount: 2, vp: 4 }] })
  })
})

/** Order-independent equality — calculateTerritoryControlByHex's result order follows region-then-tile iteration order, not something callers should depend on. */
function sortedByCoord(hexes: { coord: Coordinate; ownerId: string; terrain: string; regionSize: number }[]) {
  return [...hexes].sort((a, b) => a.coord.q - b.coord.q || a.coord.r - b.coord.r)
}

describe('calculateTerritoryControlByHex', () => {
  it('assigns every hex in a region to its majority owner, regardless of terrain VP value', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [0, 1, 'water'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 }), unitAt('p2', { q: 0, r: 1 })]

    // No terrainVictoryPoints table at all — territory control doesn't
    // depend on whether the terrain actually scores anything.
    const result = calculateTerritoryControlByHex(board, units)

    expect(sortedByCoord(result)).toEqual([
      { coord: { q: 0, r: 0 }, ownerId: 'p1', terrain: 'water', regionSize: 3 },
      { coord: { q: 0, r: 1 }, ownerId: 'p1', terrain: 'water', regionSize: 3 },
      { coord: { q: 1, r: 0 }, ownerId: 'p1', terrain: 'water', regionSize: 3 },
    ])
  })

  it('omits hexes from a region with no majority owner (including empty ones)', () => {
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'mountain'],
      [5, 5, 'water'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p2', { q: 1, r: 0 })]

    expect(calculateTerritoryControlByHex(board, units)).toEqual([])
  })

  it('merges a glacier region into its scores-as mountain region, same as calculateTerrainControlVP', () => {
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'glacier'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 })]

    const result = calculateTerritoryControlByHex(board, units, { glacier: 'mountain' })

    expect(sortedByCoord(result)).toEqual([
      { coord: { q: 0, r: 0 }, ownerId: 'p1', terrain: 'mountain', regionSize: 2 },
      { coord: { q: 1, r: 0 }, ownerId: 'p1', terrain: 'mountain', regionSize: 2 },
    ])
  })

  it('keeps two adjacent regions of different terrain as separate entries even when the same player controls both', () => {
    const board = boardOf([
      [0, 0, 'forest'],
      [1, 0, 'plain'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 })]

    const result = calculateTerritoryControlByHex(board, units)

    expect(sortedByCoord(result)).toEqual([
      { coord: { q: 0, r: 0 }, ownerId: 'p1', terrain: 'forest', regionSize: 1 },
      { coord: { q: 1, r: 0 }, ownerId: 'p1', terrain: 'plain', regionSize: 1 },
    ])
  })

  it("reports each hex's full region size, not just 1, for a multi-hex region — lets a caller derive the region's total VP value (regionSize × terrainVictoryPoints[terrain]) to weigh how much a territory actually scored", () => {
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'mountain'],
      [2, 0, 'mountain'],
    ])
    const units = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 }), unitAt('p1', { q: 2, r: 0 })]

    const result = calculateTerritoryControlByHex(board, units)

    expect(result.every((hex) => hex.regionSize === 3)).toBe(true)
  })
})

/** Order-independent equality — same rationale as sortedByCoord above. */
function sortedChangedByCoord(hexes: { coord: Coordinate; ownerId: string | null; terrain: string; regionSize: number }[]) {
  return [...hexes].sort((a, b) => a.coord.q - b.coord.q || a.coord.r - b.coord.r)
}

describe('calculateChangedTerritoryHexes', () => {
  it('reports nothing when ownership is unchanged', () => {
    const board = boardOf([[0, 0, 'plain']])
    const before = [unitAt('p1', { q: 0, r: 0 })]
    const after = [unitAt('p1', { q: 0, r: 0 })]

    expect(calculateChangedTerritoryHexes(board, before, after)).toEqual([])
  })

  it('reports a region flipping from one owner to another', () => {
    const board = boardOf([[0, 0, 'plain']])
    const before = [unitAt('p1', { q: 0, r: 0 })]
    const after = [unitAt('p2', { q: 0, r: 0 })]

    expect(calculateChangedTerritoryHexes(board, before, after)).toEqual([{ coord: { q: 0, r: 0 }, ownerId: 'p2', terrain: 'plain', regionSize: 1 }])
  })

  it('reports a newly-owned region that had no majority owner before', () => {
    const board = boardOf([[0, 0, 'plain']])
    const before: Unit[] = []
    const after = [unitAt('p1', { q: 0, r: 0 })]

    expect(calculateChangedTerritoryHexes(board, before, after)).toEqual([{ coord: { q: 0, r: 0 }, ownerId: 'p1', terrain: 'plain', regionSize: 1 }])
  })

  it("reports a region that lost its owner with ownerId: null — for the caller to render striped ('turned neutral')", () => {
    const board = boardOf([[0, 0, 'plain']])
    const before = [unitAt('p1', { q: 0, r: 0 })]
    const after: Unit[] = []

    expect(calculateChangedTerritoryHexes(board, before, after)).toEqual([{ coord: { q: 0, r: 0 }, ownerId: null, terrain: 'plain', regionSize: 1 }])
  })

  it('reports a region that lost its majority owner to a tie as ownerId: null too', () => {
    const board = boardOf([[0, 0, 'plain']])
    const before = [unitAt('p1', { q: 0, r: 0 })]
    const after = [unitAt('p1', { q: 0, r: 0 }), unitAt('p2', { q: 0, r: 0 })]

    expect(calculateChangedTerritoryHexes(board, before, after)).toEqual([{ coord: { q: 0, r: 0 }, ownerId: null, terrain: 'plain', regionSize: 1 }])
  })

  it('only reports the hexes whose region actually changed, leaving unchanged regions out entirely', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [5, 5, 'water'],
    ])
    const before = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 5, r: 5 })]
    const after = [unitAt('p1', { q: 0, r: 0 }), unitAt('p2', { q: 5, r: 5 })]

    expect(calculateChangedTerritoryHexes(board, before, after)).toEqual([{ coord: { q: 5, r: 5 }, ownerId: 'p2', terrain: 'water', regionSize: 1 }])
  })

  it('reports every hex of a multi-hex region that changed hands, each with the full region size', () => {
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'mountain'],
    ])
    const before = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 })]
    const after = [unitAt('p2', { q: 0, r: 0 }), unitAt('p2', { q: 1, r: 0 })]

    expect(sortedChangedByCoord(calculateChangedTerritoryHexes(board, before, after))).toEqual([
      { coord: { q: 0, r: 0 }, ownerId: 'p2', terrain: 'mountain', regionSize: 2 },
      { coord: { q: 1, r: 0 }, ownerId: 'p2', terrain: 'mountain', regionSize: 2 },
    ])
  })

  it('respects terrainScoresAs when comparing regions across the merge (glacier -> mountain)', () => {
    const board = boardOf([
      [0, 0, 'mountain'],
      [1, 0, 'glacier'],
    ])
    const before = [unitAt('p1', { q: 0, r: 0 }), unitAt('p1', { q: 1, r: 0 })]
    const after = [unitAt('p2', { q: 0, r: 0 }), unitAt('p2', { q: 1, r: 0 })]

    expect(sortedChangedByCoord(calculateChangedTerritoryHexes(board, before, after, { glacier: 'mountain' }))).toEqual([
      { coord: { q: 0, r: 0 }, ownerId: 'p2', terrain: 'mountain', regionSize: 2 },
      { coord: { q: 1, r: 0 }, ownerId: 'p2', terrain: 'mountain', regionSize: 2 },
    ])
  })
})

describe('calculateTerrainControlVPByKind', () => {
  it("splits a region's VP evenly across the majority owner's units, summed per kind", () => {
    // 3-hex water region worth 2 VP/hex = 6 VP total, controlled by p1 with
    // 2 nomads and 1 ship (3 friendly units) -> nomad gets 2/3, ship gets 1/3.
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [0, 1, 'water'],
    ])
    const units = [unitOfKindAt('p1', { q: 0, r: 0 }, 'nomad'), unitOfKindAt('p1', { q: 1, r: 0 }, 'nomad'), unitOfKindAt('p1', { q: 0, r: 1 }, 'ship')]

    const vp = calculateTerrainControlVPByKind(board, units, { water: 2 })

    expect(vp).toEqual({ p1: { nomad: 4, ship: 2 } })
  })

  it('sums a kind across multiple regions the same player controls', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [10, 10, 'forest'],
    ])
    const units = [unitOfKindAt('p1', { q: 0, r: 0 }, 'nomad'), unitOfKindAt('p1', { q: 10, r: 10 }, 'nomad')]

    const vp = calculateTerrainControlVPByKind(board, units, { water: 2, forest: 3 })

    expect(vp).toEqual({ p1: { nomad: 5 } })
  })

  it('scores nothing for a region with no majority owner', () => {
    const board = boardOf([[0, 0, 'mountain']])
    const units = [unitOfKindAt('p1', { q: 0, r: 0 }, 'nomad'), unitOfKindAt('p2', { q: 0, r: 0 }, 'ship')]

    const vp = calculateTerrainControlVPByKind(board, units, { mountain: 5 })

    expect(vp).toEqual({})
  })

  it('scores nothing for a terrain missing from terrainVictoryPoints', () => {
    const board = boardOf([[0, 0, 'forest']])
    const units = [unitOfKindAt('p1', { q: 0, r: 0 }, 'nomad')]

    const vp = calculateTerrainControlVPByKind(board, units, { water: 2 })

    expect(vp).toEqual({})
  })

  it("ignores the majority owner's units elsewhere on the board when splitting a region's VP", () => {
    const board = boardOf([
      [0, 0, 'water'],
      [5, 5, 'plain'],
    ])
    const units = [unitOfKindAt('p1', { q: 0, r: 0 }, 'nomad'), unitOfKindAt('p1', { q: 5, r: 5 }, 'ship')]

    const vp = calculateTerrainControlVPByKind(board, units, { water: 4 })

    // p1's ship is outside the water region entirely, so the region's whole 4 VP goes to nomad alone.
    expect(vp).toEqual({ p1: { nomad: 4 } })
  })
})
