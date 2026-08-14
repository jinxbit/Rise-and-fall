import { describe, expect, it } from 'vitest'
import {
  applyTilePlacement,
  canPlaceRemainingTiles,
  findForcedPlacement,
  isLegalTilePlacement,
  placedShapeCells,
  rotateShape,
  seedStartingWaterTiles,
  shapeCenterCell,
  touchesEnoughExistingTerrain,
  wouldEncloseEmptyHexes,
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

describe('shapeCenterCell', () => {
  it("finds the water expansion tile's true center hex — the flower shape is a full hex-plus-its-six-neighbors", () => {
    const flower = terrainJson.terrainTypes.find((t) => t.id === 'water')!.shapeGroups.find((g) => g.id === 'expansion')!.shapes[0].cells
    expect(shapeCenterCell(flower)).toEqual({ q: 0, r: 1 })
  })

  it('is a fixed point of {0,0} for a shape whose only cell is {0,0}', () => {
    expect(shapeCenterCell([{ q: 0, r: 0 }])).toEqual({ q: 0, r: 0 })
  })

  it('lands on the cell closest to the centroid even for a shape with no exact single center (e.g. a 2-cell domino)', () => {
    expect(shapeCenterCell([{ q: 0, r: 0 }, { q: 1, r: 0 }])).toEqual({ q: 1, r: 0 })
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
    expect(canPlaceRemainingTiles(board, domino, null, 5)).toBe(true)
  })

  it('is false when no hex on the board has a qualifying terrain at all', () => {
    const board = boardOf([[0, 0, 'forest']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 1)).toBe(false)
  })

  it('is false when qualifying hexes exist but none of them are adjacent to another', () => {
    // Three isolated water hexes, none neighboring another — a 2-cell
    // domino can never land on two of them at once.
    const board = boardOf([[0, 0, 'water'], [5, 5, 'water'], [-3, 2, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 1)).toBe(false)
  })

  it('is true when a legal placement exists somewhere on the board', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water'], [5, 5, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 1)).toBe(true)
  })

  it('finds a placement that only fits after rotation', () => {
    // (2,2)-(2,3) are adjacent along the {0,1} direction, not the domino's
    // own unrotated {1,0} offset — only a rotated placement can cover both.
    const board = boardOf([[2, 2, 'water'], [2, 3, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 1)).toBe(true)
  })

  it('is true for count > 1 when every remaining tile has independent room', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water'], [5, 5, 'water'], [6, 5, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 2)).toBe(true)
  })

  it('is false for count > 1 when only one spot exists but two tiles are still owed', () => {
    // Only one domino-sized pair of adjacent water hexes on the whole
    // board — room for exactly 1 more tile, not the 2 still required. A
    // shallow "is there room for one more" check would wrongly allow this.
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 1)).toBe(true)
    expect(canPlaceRemainingTiles(board, domino, ['water'], 2)).toBe(false)
  })

  it('accounts for shared hexes between candidate placements when checking later ones', () => {
    // Four water hexes in a row: (0,0)-(1,0)-(2,0)-(3,0). Only one domino
    // fits without reusing a hex another placement already claims — using
    // (0,0)-(1,0) leaves (2,0)-(3,0) open for a second, so both fit, but a
    // third has nowhere left to go.
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water'], [2, 0, 'water'], [3, 0, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 2)).toBe(true)
    expect(canPlaceRemainingTiles(board, domino, ['water'], 3)).toBe(false)
  })

  it('finds a fit a naive "always take the first legal spot found" greedy pass would miss — the reported bug', () => {
    // A 4-hex chain A-B-C-D, but inserted in board order B,A,C,D: a search
    // that always takes the first legal spot it finds starts from B (first
    // inserted) and immediately commits to the middle edge B-C, stranding
    // both A and D with no partner left — even though the *only* other
    // option, pairing A-B and C-D instead, fits both tiles perfectly. A
    // real game hit exactly this shape (see todo.md): a placement the live
    // game had already accepted got rejected on replay/undo because the
    // old greedy check couldn't find the fit it needed.
    const board = boardOf([[1, 0, 'water'], [0, 0, 'water'], [2, 0, 'water'], [3, 0, 'water']])
    expect(canPlaceRemainingTiles(board, domino, ['water'], 2)).toBe(true)
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

describe('touchesEnoughExistingTerrain', () => {
  it('counts a single touching hex as not enough for a minimum of 2', () => {
    const board = boardOf([[0, 0, 'water']])
    // (1,0)-(2,0): only (1,0) neighbors the existing water hex at (0,0).
    const placedCells = [{ q: 1, r: 0 }, { q: 2, r: 0 }]
    expect(touchesEnoughExistingTerrain(board, placedCells, 'water', 1)).toBe(true)
    expect(touchesEnoughExistingTerrain(board, placedCells, 'water', 2)).toBe(false)
  })

  it('counts 2 hexes with no placementId (e.g. an already-persisted game, or a test board built with setTile) as 2 separate tiles, falling back to one per hex', () => {
    // (0,0) and (1,-1) are both neighbors of (1,0). Neither has a
    // placementId (boardOf() builds via setTile directly), so each falls
    // back to being its own standalone "tile" rather than merging.
    const board = boardOf([[0, 0, 'water'], [1, -1, 'water']])
    const placedCells = [{ q: 1, r: 0 }, { q: 2, r: 0 }]
    expect(touchesEnoughExistingTerrain(board, placedCells, 'water', 2)).toBe(true)
  })

  it('counts 2 adjacent hexes from the SAME earlier tile placement as only 1 tile, not 2 — the reported bug', () => {
    // (0,0) and (1,-1) are both neighbors of (1,0), same as the test
    // above, but this time both hexes share one placementId (as they
    // would if a single real tile placement had covered both) — touching
    // 2 of that one tile's hexes still only connects to 1 existing tile.
    let board = boardOf([[0, 0, 'water'], [1, -1, 'water']])
    board = { ...board, tiles: { ...board.tiles, '0,0': { ...board.tiles['0,0'], placementId: 'tile_A' }, '1,-1': { ...board.tiles['1,-1'], placementId: 'tile_A' } } }
    const placedCells = [{ q: 1, r: 0 }, { q: 2, r: 0 }]
    expect(touchesEnoughExistingTerrain(board, placedCells, 'water', 2)).toBe(false)
    expect(touchesEnoughExistingTerrain(board, placedCells, 'water', 1)).toBe(true)
  })

  it('counts 2 hexes from 2 DIFFERENT earlier tile placements as 2 tiles', () => {
    let board = boardOf([[0, 0, 'water'], [1, -1, 'water']])
    board = { ...board, tiles: { ...board.tiles, '0,0': { ...board.tiles['0,0'], placementId: 'tile_A' }, '1,-1': { ...board.tiles['1,-1'], placementId: 'tile_B' } } }
    const placedCells = [{ q: 1, r: 0 }, { q: 2, r: 0 }]
    expect(touchesEnoughExistingTerrain(board, placedCells, 'water', 2)).toBe(true)
  })

  it('only counts a qualifying terrain, not any tile', () => {
    const board = boardOf([[0, 0, 'plain'], [1, -1, 'plain']])
    const placedCells = [{ q: 1, r: 0 }, { q: 2, r: 0 }]
    expect(touchesEnoughExistingTerrain(board, placedCells, 'water', 1)).toBe(false)
  })

  it("doesn't count a neighbor that's itself part of the new placement", () => {
    // Every cell here neighbors another cell in the same placement, but
    // none of them are *existing* board tiles.
    const board = createEmptyBoard('hex')
    const placedCells = [{ q: 0, r: 0 }, { q: 1, r: 0 }]
    expect(touchesEnoughExistingTerrain(board, placedCells, 'water', 1)).toBe(false)
  })
})

describe('wouldEncloseEmptyHexes', () => {
  it('is false when nothing gets sealed off', () => {
    const board = boardOf([[5, 5, 'water']])
    expect(wouldEncloseEmptyHexes(board, [{ q: 6, r: 5 }])).toBe(false)
  })

  it('is true when the placement completes a ring around a single empty hex', () => {
    // 5 of (0,0)'s 6 neighbors are already tiled; placing the 6th
    // (0,1) fully encloses (0,0) itself with nowhere left to escape to.
    const board = boardOf([
      [1, 0, 'water'], [1, -1, 'water'], [0, -1, 'water'], [-1, 0, 'water'], [-1, 1, 'water'],
    ])
    expect(wouldEncloseEmptyHexes(board, [{ q: 0, r: 1 }])).toBe(true)
  })

  it('is false when a ring is left with a gap, still open to the exterior', () => {
    // Only 5 of (0,0)'s 6 neighbors get tiled (4 existing + 1 placed) —
    // the 6th, (0,1), stays open, so (0,0) still escapes through it.
    const board = boardOf([[1, 0, 'water'], [1, -1, 'water'], [0, -1, 'water'], [-1, 0, 'water']])
    expect(wouldEncloseEmptyHexes(board, [{ q: -1, r: 1 }])).toBe(false)
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

  it('tags every covered hex with the given placementId', () => {
    const board = createEmptyBoard('hex')
    const next = applyTilePlacement(board, [{ q: 0, r: 0 }, { q: 1, r: 0 }], 'water', 'tile_A')
    expect(getTile(next, { q: 0, r: 0 })?.placementId).toBe('tile_A')
    expect(getTile(next, { q: 1, r: 0 })?.placementId).toBe('tile_A')
  })

  it('leaves placementId undefined when none is given', () => {
    const board = createEmptyBoard('hex')
    const next = applyTilePlacement(board, [{ q: 0, r: 0 }], 'water')
    expect(getTile(next, { q: 0, r: 0 })?.placementId).toBeUndefined()
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

  it('tags each hourglass with its own distinct placementId, shared by both of its own hexes', () => {
    const board = seedStartingWaterTiles(2, domino)
    const firstTile = [getTile(board, { q: 0, r: 0 }), getTile(board, { q: 1, r: 0 })]
    const secondTile = [getTile(board, { q: 2, r: 1 }), getTile(board, { q: 3, r: 1 })]

    expect(firstTile[0]?.placementId).toBeDefined()
    expect(firstTile[0]?.placementId).toBe(firstTile[1]?.placementId)
    expect(secondTile[0]?.placementId).toBeDefined()
    expect(secondTile[0]?.placementId).toBe(secondTile[1]?.placementId)
    expect(firstTile[0]?.placementId).not.toBe(secondTile[0]?.placementId)
  })

  it('chains 3 shapes for 3 players into a "V": descend by (2,1), then ascend by (3,-1)', () => {
    const board = seedStartingWaterTiles(3, domino)
    const coords = Object.values(board.tiles).map((t) => t.coord)
    expect(coords).toHaveLength(6)
    expect(keySet(coords)).toEqual(
      keySet([
        { q: 0, r: 0 }, { q: 1, r: 0 },
        { q: 2, r: 1 }, { q: 3, r: 1 },
        { q: 5, r: 0 }, { q: 6, r: 0 },
      ]),
    )
  })

  it('places 4 shapes for 4 players in a 2x2 block: right by (3,0), below by (0,3), and both combined', () => {
    const board = seedStartingWaterTiles(4, domino)
    const coords = Object.values(board.tiles).map((t) => t.coord)
    expect(coords).toHaveLength(8)
    // No overlaps between any of the 4 placed shapes.
    expect(keySet(coords).size).toBe(8)
    expect(keySet(coords)).toEqual(
      keySet([
        { q: 0, r: 0 }, { q: 1, r: 0 },
        { q: 3, r: 0 }, { q: 4, r: 0 },
        { q: 0, r: 3 }, { q: 1, r: 3 },
        { q: 3, r: 3 }, { q: 4, r: 3 },
      ]),
    )
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

  it('for 3 and 4 players with the real hourglass shape, every tile touches at least one other — one connected region, not disconnected pieces', () => {
    const hourglass = terrainJson.terrainTypes.find((t) => t.id === 'water')!.shapeGroups.find((g) => g.id === 'initial')!
      .shapes[0].cells

    for (const playerCount of [3, 4]) {
      const board = seedStartingWaterTiles(playerCount, hourglass)
      const placementIds = new Set(Object.values(board.tiles).map((t) => t.placementId))
      expect(placementIds.size).toBe(playerCount)

      // BFS over the water hexes: every tile must be reachable from the first.
      const coords = Object.values(board.tiles).map((t) => t.coord)
      const remaining = new Set(coords.map((c) => `${c.q},${c.r}`))
      const start = coords[0]
      const stack = [start]
      remaining.delete(`${start.q},${start.r}`)
      const dirs = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }]
      while (stack.length > 0) {
        const cur = stack.pop()!
        for (const d of dirs) {
          const key = `${cur.q + d.q},${cur.r + d.r}`
          if (remaining.has(key)) {
            remaining.delete(key)
            stack.push({ q: cur.q + d.q, r: cur.r + d.r })
          }
        }
      }
      expect(remaining.size).toBe(0)
    }
  })

  it('for 4 players with the real hourglass shape, every tile touches at least 2 of the other 3 — a solid 2x2 block', () => {
    const hourglass = terrainJson.terrainTypes.find((t) => t.id === 'water')!.shapeGroups.find((g) => g.id === 'initial')!
      .shapes[0].cells
    const board = seedStartingWaterTiles(4, hourglass)

    const placementIds = [...new Set(Object.values(board.tiles).map((t) => t.placementId))]
    expect(placementIds).toHaveLength(4)

    const cellsByTile = placementIds.map((id) => Object.values(board.tiles).filter((t) => t.placementId === id).map((t) => t.coord))
    const dirs = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }]
    const touches = (a: Coordinate[], b: Coordinate[]) => {
      const bKeys = new Set(b.map((c) => `${c.q},${c.r}`))
      return a.some((c) => dirs.some((d) => bKeys.has(`${c.q + d.q},${c.r + d.r}`)))
    }

    for (let i = 0; i < cellsByTile.length; i++) {
      const touchCount = cellsByTile.filter((_, j) => j !== i && touches(cellsByTile[i], cellsByTile[j])).length
      expect(touchCount).toBeGreaterThanOrEqual(2)
    }
  })
})
