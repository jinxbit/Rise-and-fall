import { describe, expect, it } from 'vitest'
import {
  applyTilePlacement,
  isLegalTilePlacement,
  placedShapeCells,
  rotateShape,
  seedStartingWaterTiles,
} from '../boardGeneration'
import { createEmptyBoard, getTile, setTile } from '../board'
import type { Board, Coordinate, Terrain } from '../types'
import terrainJson from '../../content/terrain.json'

function boardOf(cells: Array<[number, number, Terrain]>): Board {
  let board = createEmptyBoard('hex')
  for (const [q, r, terrain] of cells) {
    board = setTile(board, { q, r }, terrain)
  }
  return board
}

function keySet(cells: Coordinate[]): Set<string> {
  return new Set(cells.map((c) => `${c.q},${c.r}`))
}

describe('rotateShape', () => {
  it('leaves cells unchanged at 0 steps', () => {
    const cells = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 1, r: -1 }]
    expect(rotateShape(cells, 0)).toEqual(cells)
  })

  it('rotates {1,0} through the six hex directions in order, one step at a time', () => {
    // Matches ./board.ts's HEX_DIRECTIONS order exactly.
    const expected = [
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ]
    for (let step = 0; step < 6; step++) {
      expect(rotateShape([{ q: 1, r: 0 }], step)).toEqual([expected[step]])
    }
  })

  it('returns to the original after a full 6-step cycle', () => {
    const cells = [{ q: 2, r: -1 }, { q: 0, r: 3 }]
    expect(rotateShape(cells, 6)).toEqual(cells)
  })

  it('normalizes negative steps (e.g. -1 === 5)', () => {
    expect(rotateShape([{ q: 1, r: 0 }], -1)).toEqual(rotateShape([{ q: 1, r: 0 }], 5))
  })

  it('keeps a {0,0} anchor cell fixed under rotation, since {0,0} is a fixed point', () => {
    const cells = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }]
    for (let step = 0; step < 6; step++) {
      expect(rotateShape(cells, step)[0]).toEqual({ q: 0, r: 0 })
    }
  })
})

describe('placedShapeCells', () => {
  it('translates by the anchor with no rotation', () => {
    const cells = [{ q: 0, r: 0 }, { q: 1, r: 0 }]
    expect(placedShapeCells(cells, { q: 5, r: -3 }, 0)).toEqual([{ q: 5, r: -3 }, { q: 6, r: -3 }])
  })

  it('rotates then translates', () => {
    const cells = [{ q: 0, r: 0 }, { q: 1, r: 0 }]
    // {1,0} rotated 1 step -> {1,-1}, then translated by {5,-3} -> {6,-4}.
    expect(placedShapeCells(cells, { q: 5, r: -3 }, 1)).toEqual([{ q: 5, r: -3 }, { q: 6, r: -4 }])
  })
})

describe('isLegalTilePlacement', () => {
  it('rejects placing an empty cell list', () => {
    expect(isLegalTilePlacement(createEmptyBoard('hex'), [], null)).toBe(false)
  })

  describe('base terrain (placesOn: null)', () => {
    it('is legal only where every hex is completely untiled', () => {
      const board = boardOf([[0, 0, 'plain']])
      expect(isLegalTilePlacement(board, [{ q: 5, r: 5 }, { q: 6, r: 5 }], null)).toBe(true)
    })

    it('is illegal if any hex already has a tile, even the same base terrain', () => {
      const board = boardOf([[0, 0, 'water']])
      expect(isLegalTilePlacement(board, [{ q: 0, r: 0 }, { q: 1, r: 0 }], null)).toBe(false)
    })
  })

  describe('terrain with placesOn', () => {
    it('is legal where every hex currently matches one of placesOn', () => {
      const board = boardOf([[0, 0, 'water'], [1, 0, 'water']])
      expect(isLegalTilePlacement(board, [{ q: 0, r: 0 }, { q: 1, r: 0 }], ['water'])).toBe(true)
    })

    it('is illegal if any covered hex is a hole (no tile at all)', () => {
      const board = boardOf([[0, 0, 'water']])
      expect(isLegalTilePlacement(board, [{ q: 0, r: 0 }, { q: 1, r: 0 }], ['water'])).toBe(false)
    })

    it('is illegal if the covered hexes mix terrains, even if both are individually valid elsewhere', () => {
      const board = boardOf([[0, 0, 'water'], [1, 0, 'plain']])
      expect(isLegalTilePlacement(board, [{ q: 0, r: 0 }, { q: 1, r: 0 }], ['water'])).toBe(false)
    })

    it('is illegal if a covered hex is the wrong terrain entirely', () => {
      const board = boardOf([[0, 0, 'forest'], [1, 0, 'forest']])
      expect(isLegalTilePlacement(board, [{ q: 0, r: 0 }, { q: 1, r: 0 }], ['water'])).toBe(false)
    })
  })
})

describe('applyTilePlacement', () => {
  it('sets every covered hex to the new terrain', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water']])
    const next = applyTilePlacement(board, [{ q: 0, r: 0 }, { q: 1, r: 0 }], 'plain')
    expect(getTile(next, { q: 0, r: 0 })?.terrain).toBe('plain')
    expect(getTile(next, { q: 1, r: 0 })?.terrain).toBe('plain')
  })

  it('leaves hexes outside the placement untouched', () => {
    const board = boardOf([[0, 0, 'water'], [5, 5, 'forest']])
    const next = applyTilePlacement(board, [{ q: 0, r: 0 }], 'plain')
    expect(getTile(next, { q: 5, r: 5 })?.terrain).toBe('forest')
  })

  it('preserves an existing tile id and occupants when covering it', () => {
    let board = boardOf([[0, 0, 'water']])
    board = { ...board, tiles: { ...board.tiles, '0,0': { ...board.tiles['0,0'], occupantIds: ['unit_1'] } } }
    const next = applyTilePlacement(board, [{ q: 0, r: 0 }], 'plain')
    expect(getTile(next, { q: 0, r: 0 })?.occupantIds).toEqual(['unit_1'])
  })
})

describe('seedStartingWaterTiles', () => {
  // A small synthetic 2-hex shape (not the real hourglass) so the exact
  // resulting coordinates are easy to hand-verify.
  const domino = [{ q: 0, r: 0 }, { q: 1, r: 0 }]

  it('places one shape for a single player, unrotated at the origin anchor', () => {
    const board = seedStartingWaterTiles(1, domino)
    expect(keySet(Object.values(board.tiles).map((t) => t.coord))).toEqual(keySet([{ q: 0, r: 0 }, { q: 1, r: 0 }]))
  })

  it('places 2 non-overlapping shapes for 2 players, the second offset by (2,1)', () => {
    const board = seedStartingWaterTiles(2, domino)
    const coords = Object.values(board.tiles).map((t) => t.coord)
    expect(coords).toHaveLength(4)
    expect(keySet(coords)).toEqual(
      keySet([
        { q: 0, r: 0 }, { q: 1, r: 0 },
        { q: 2, r: 1 }, { q: 3, r: 1 },
      ]),
    )
    expect(Object.values(board.tiles).every((t) => t.terrain === 'water')).toBe(true)
  })

  it('chains 3 shapes for 3 players via the same (2,1) offset applied cumulatively', () => {
    const board = seedStartingWaterTiles(3, domino)
    const coords = Object.values(board.tiles).map((t) => t.coord)
    expect(coords).toHaveLength(6)
    expect(keySet(coords)).toEqual(
      keySet([
        { q: 0, r: 0 }, { q: 1, r: 0 },
        { q: 2, r: 1 }, { q: 3, r: 1 },
        { q: 4, r: 2 }, { q: 5, r: 2 },
      ]),
    )
  })

  it('places 2 separate pairs (not one chain of 4) for 4 players', () => {
    const board = seedStartingWaterTiles(4, domino)
    const coords = Object.values(board.tiles).map((t) => t.coord)
    expect(coords).toHaveLength(8)
    // No overlaps between any of the 4 placed shapes.
    expect(keySet(coords).size).toBe(8)
  })

  it("against the real content/terrain.json hourglass shape: 8 hexes per player, no overlaps", () => {
    const hourglass = terrainJson.terrainTypes.find((t) => t.id === 'water')!.shapeGroups.find((g) => g.id === 'initial')!
      .shapes[0].cells

    for (const playerCount of [2, 3, 4]) {
      const board = seedStartingWaterTiles(playerCount, hourglass)
      const coords = Object.values(board.tiles).map((t) => t.coord)
      expect(coords).toHaveLength(playerCount * 8)
      expect(keySet(coords).size).toBe(playerCount * 8)
      expect(Object.values(board.tiles).every((t) => t.terrain === 'water')).toBe(true)
    }
  })
})
