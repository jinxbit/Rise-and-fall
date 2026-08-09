import { describe, expect, it } from 'vitest'
import { createEmptyBoard, setTile } from '../board'
import { calculateTerrainControlVP } from '../scoring'
import type { Board, Coordinate, Terrain, Unit } from '../types'

function boardOf(cells: Array<[number, number, Terrain]>): Board {
  let board = createEmptyBoard('hex')
  for (const [q, r, terrain] of cells) {
    board = setTile(board, { q, r }, terrain)
  }
  return board
}

let unitCounter = 0
function unitAt(ownerId: string, coord: Coordinate): Unit {
  unitCounter += 1
  return {
    id: `test-unit-${unitCounter}`,
    ownerId,
    kind: 'test-kind',
    coord,
    movement: { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }
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
