import { describe, expect, it } from 'vitest'
import {
  applyTilePlacement,
  canPlaceRemainingTiles,
  findForcedPlacement,
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

describe('canPlaceRemainingTiles', () => {
  const domino = [{ q: 0, r: 0 }, { q: 1, r: 0 }]

  it('is always true for placesOn: null (water) — the board is unbounded, so there is always room somewhere', () => {
    const board = boardOf([[0, 0, 'plain']])
    expect(canPlaceRemainingTiles(board, domino, null, 'water', 5)).toBe(true)
  })

  it('is false when no hex on the board has a qualifying terrain at all', () => {
    const board = boardOf([[0, 0, 'forest']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 'plain', 1)).toBe(false)
  })

  it('is false when qualifying hexes exist but none of them are adjacent to another', () => {
    // Three isolated water hexes, none neighboring another — a 2-cell
    // domino can never land on two of them at once.
    const board = boardOf([[0, 0, 'water'], [5, 5, 'water'], [-3, 2, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 'plain', 1)).toBe(false)
  })

  it('is true when a legal placement exists somewhere on the board', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water'], [5, 5, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 'plain', 1)).toBe(true)
  })

  it('finds a placement that only fits after rotation', () => {
    // (2,2)-(2,3) are adjacent along the {0,1} direction, not the domino's
    // own unrotated {1,0} offset — only a rotated placement can cover both.
    const board = boardOf([[2, 2, 'water'], [2, 3, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 'plain', 1)).toBe(true)
  })

  it('is true for count > 1 when every remaining tile has independent room', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water'], [5, 5, 'water'], [6, 5, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 'plain', 2)).toBe(true)
  })

  it('is false for count > 1 when only one spot exists but two tiles are still owed', () => {
    // Only one domino-sized pair of adjacent water hexes on the whole
    // board — room for exactly 1 more tile, not the 2 still required. A
    // shallow "is there room for one more" check would wrongly allow this.
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 'plain', 1)).toBe(true)
    expect(canPlaceRemainingTiles(board, domino, ['water'], 'plain', 2)).toBe(false)
  })

  it('accounts for the terrain conversion of earlier virtual placements when checking later ones', () => {
    // Four water hexes in a row: (0,0)-(1,0)-(2,0)-(3,0). Only one domino
    // fits without reusing a hex the first placement already converted to
    // 'plain' — greedily placing (0,0)-(1,0) first still leaves
    // (2,0)-(3,0) open for the second, so both fit.
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water'], [2, 0, 'water'], [3, 0, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 'plain', 2)).toBe(true)
    expect(canPlaceRemainingTiles(board, domino, ['water'], 'plain', 3)).toBe(false)
  })
})

describe('findForcedPlacement', () => {
  const domino = [{ q: 0, r: 0 }, { q: 1, r: 0 }]

  it('is null for placesOn: null (water) — never forced, the board is unbounded', () => {
    const board = boardOf([[0, 0, 'plain']])
    expect(findForcedPlacement(board, domino, null, 3)).toBeNull()
  })

  it('is null when more than one legal spot exists for a single remaining tile', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water'], [5, 5, 'water'], [6, 5, 'water']])
    expect(findForcedPlacement(board, domino, ['water'], 1)).toBeNull()
  })

  it('finds the one legal spot when exactly one exists for a single remaining tile', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water']])
    const forced = findForcedPlacement(board, domino, ['water'], 1)
    expect(forced).not.toBeNull()
    if (!forced) return
    const cells = placedShapeCells(domino, forced.anchor, forced.rotationSteps)
    expect(new Set(cells.map((c) => `${c.q},${c.r}`))).toEqual(new Set(['0,0', '1,0']))
  })

  it('is null when more than one combo of 2 disjoint placements exists', () => {
    // Three fully independent pairs but only 2 tiles are owed — which 2 of
    // the 3 get used isn't determined.
    const board = boardOf([
      [0, 0, 'water'], [1, 0, 'water'],
      [5, 5, 'water'], [6, 5, 'water'],
      [10, 5, 'water'], [11, 5, 'water'],
    ])
    expect(findForcedPlacement(board, domino, ['water'], 2)).toBeNull()
  })

  it('finds the forced placement when a shared-cell chain leaves only one disjoint combo for 2 remaining tiles', () => {
    // (5,5)-(6,5)-(7,5)-(8,5): the only two disjoint dominoes are
    // (5,5)-(6,5) and (7,5)-(8,5) — (6,5)-(7,5) overlaps both, so it can
    // never be part of a valid pair. Exactly one way to place both.
    const board = boardOf([[5, 5, 'water'], [6, 5, 'water'], [7, 5, 'water'], [8, 5, 'water']])
    const forced = findForcedPlacement(board, domino, ['water'], 2)
    expect(forced).not.toBeNull()
    if (!forced) return
    const cells = placedShapeCells(domino, forced.anchor, forced.rotationSteps)
    const key = cells.map((c) => `${c.q},${c.r}`).sort().join('|')
    expect(['5,5|6,5', '7,5|8,5']).toContain(key)
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
