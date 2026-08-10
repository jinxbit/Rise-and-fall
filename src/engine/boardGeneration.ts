import { createEmptyBoard, getTile, setTile } from './board'
import type { Board, Coordinate, Terrain } from './types'

// --- shape geometry ----------------------------------------------------------

/**
 * Rotates a single axial coordinate 60 degrees around the origin, one step
 * of the six possible orientations. Derived from the standard cube-coordinate
 * rotation (q,r,-q-r) -> (-y,-z,-x); repeating it cycles a cell through
 * exactly the six directions in ./board.ts's HEX_DIRECTIONS order, so it's a
 * well-defined, consistent rotation step regardless of which visual
 * direction (clockwise/counterclockwise) it turns out to be.
 */
function rotateCell60(cell: Coordinate): Coordinate {
  // `|| 0` normalizes a resulting -0 (e.g. -cell.q when cell.q is 0) to a
  // plain 0 — mathematically identical, but avoids a surprising -0 leaking
  // into coordinates and confusing equality checks/debugging output.
  return { q: (cell.q + cell.r) || 0, r: -cell.q || 0 }
}

/**
 * Rotates every cell in a shape by `steps` * 60 degrees around the origin
 * (0,0 is always a fixed point of rotation, so if a shape's own anchor cell
 * is {0,0} — the schema's convention, see terrain.schema.json — it stays
 * {0,0} after rotation too). `steps` is normalized into 0-5.
 */
export function rotateShape(cells: Coordinate[], steps: number): Coordinate[] {
  const normalizedSteps = ((steps % 6) + 6) % 6
  let rotated = cells
  for (let i = 0; i < normalizedSteps; i++) {
    rotated = rotated.map(rotateCell60)
  }
  return rotated
}

/**
 * Resolves a shape's absolute board coordinates for a given placement: the
 * shape's local `cells` (see terrain.schema.json's shape.cells — relative
 * offsets, first cell {0,0}) rotated by `rotationSteps` * 60 degrees, then
 * translated so the shape's own anchor cell lands on `anchor`.
 */
export function placedShapeCells(cells: Coordinate[], anchor: Coordinate, rotationSteps: number): Coordinate[] {
  return rotateShape(cells, rotationSteps).map((c) => ({ q: c.q + anchor.q, r: c.r + anchor.r }))
}

// --- placement legality -------------------------------------------------------

/**
 * Whether a tile (already resolved to absolute `placedCells` via
 * placedShapeCells) may legally be placed on `board`.
 *
 * Per ruling: a terrain with `placesOn: null` (only water, the base
 * terrain) may only be placed onto completely untiled hexes ("holes") —
 * it can't cover anything. A terrain with a `placesOn` terrain list (every
 * other terrain — currently always exactly one entry, e.g. Plain's is
 * `['water']`) may only be placed where *every* hex it covers is currently
 * exactly one of those terrains — never a mix of terrains, and never a
 * hole. Placing a tile always covers hexes uniformly with its own single
 * terrain; partial coverage of a hex isn't a concept this model has.
 */
export function isLegalTilePlacement(board: Board, placedCells: Coordinate[], placesOn: Terrain[] | null): boolean {
  if (placedCells.length === 0) return false

  if (placesOn === null) {
    return placedCells.every((c) => getTile(board, c) === undefined)
  }
  return placedCells.every((c) => {
    const tile = getTile(board, c)
    return tile !== undefined && placesOn.includes(tile.terrain)
  })
}

/** Sets every hex in `placedCells` to `terrain`, covering (converting) whatever was there before. Does not check legality — call isLegalTilePlacement first. */
export function applyTilePlacement(board: Board, placedCells: Coordinate[], terrain: Terrain): Board {
  return placedCells.reduce((nextBoard, cell) => setTile(nextBoard, cell, terrain), board)
}

/**
 * Whether `shapeCells` (a tier's one shape, in its own local coordinates,
 * unrotated) could still be legally placed *somewhere* on `board`, in any
 * of the 6 rotations — rule 4's simplified no-space check (see
 * boardSetup.ts's placeTile): rather than searching for a minimal set of
 * already-placed tiles to relocate to open up room, a placement that would
 * leave zero legal spots anywhere for the tier's own remaining tiles is
 * rejected outright, and the player has to choose a different placement
 * instead.
 *
 * Every legal placement's own anchor cell (local `{0,0}` by convention —
 * see rotateShape's doc comment) must itself land on a hex the shape is
 * allowed to cover, so it's enough to try anchoring each cell of each
 * rotation onto each currently-tiled hex with a qualifying terrain — no
 * need to search the (otherwise unbounded) plane of empty coordinates.
 * `placesOn: null` (water) is the one case with no such hexes to anchor
 * against at all, but the board is unbounded, so there's always room
 * somewhere and this returns true immediately without searching.
 */
export function hasAnyLegalPlacement(board: Board, shapeCells: Coordinate[], placesOn: Terrain[] | null): boolean {
  if (placesOn === null) return true

  const candidateHexes = Object.values(board.tiles).filter((tile) => placesOn.includes(tile.terrain))

  for (let rotation = 0; rotation < 6; rotation++) {
    const rotatedCells = rotateShape(shapeCells, rotation)
    for (const hex of candidateHexes) {
      for (const localCell of rotatedCells) {
        const anchor: Coordinate = { q: hex.coord.q - localCell.q, r: hex.coord.r - localCell.r }
        const placed = placedShapeCells(shapeCells, anchor, rotation)
        if (isLegalTilePlacement(board, placed, placesOn)) return true
      }
    }
  }
  return false
}

// --- starting water tiles ------------------------------------------------------

/**
 * Per ruling: the second of a pair of starting water "hourglass" tiles
 * interlocks with the first along the first tile's own
 * {q:2,r:0}/{q:1,r:1}/{q:1,r:2} edge, offset by (dq:2, dr:1) from the
 * first tile's anchor — i.e. one row lower, not the same height.
 */
const STARTING_WATER_PAIR_OFFSET: Coordinate = { q: 2, r: 1 }

/**
 * ASSUMPTION, not specified by the rules given so far: for a 4-player game
 * ("two times the two players" — two independent pairs, not one chain of
 * 4), how far apart the two pairs should be placed is undecided. Chosen
 * here to be comfortably non-overlapping/non-adjacent; revisit once real
 * board-generation playtesting says otherwise.
 */
const STARTING_WATER_SECOND_PAIR_OFFSET: Coordinate = { q: 12, r: 0 }

/**
 * Seeds an empty hex board with the starting water "hourglass" tiles: one
 * per player, per ruling. 2 players -> one interlocked pair. 3 players ->
 * a chain of 3, each consecutive pair interlocked the same way as the
 * 2-player case (the same offset applied cumulatively). 4 players -> two
 * separate interlocked pairs (not one chain of 4).
 *
 * `hourglassCells` is content/terrain.json's water/`initial` shapeGroup's
 * one shape's `cells` (the engine stays content-agnostic — see UNIT_KINDS
 * in ./cards.ts for the same convention — so the caller resolves it from
 * JSON and passes it in).
 */
export function seedStartingWaterTiles(playerCount: number, hourglassCells: Coordinate[]): Board {
  let board = createEmptyBoard('hex')

  const anchors: Coordinate[] = []
  if (playerCount === 4) {
    anchors.push(
      { q: 0, r: 0 },
      { q: STARTING_WATER_PAIR_OFFSET.q, r: STARTING_WATER_PAIR_OFFSET.r },
      { q: STARTING_WATER_SECOND_PAIR_OFFSET.q, r: STARTING_WATER_SECOND_PAIR_OFFSET.r },
      {
        q: STARTING_WATER_SECOND_PAIR_OFFSET.q + STARTING_WATER_PAIR_OFFSET.q,
        r: STARTING_WATER_SECOND_PAIR_OFFSET.r + STARTING_WATER_PAIR_OFFSET.r,
      },
    )
  } else {
    for (let i = 0; i < playerCount; i++) {
      anchors.push({ q: STARTING_WATER_PAIR_OFFSET.q * i, r: STARTING_WATER_PAIR_OFFSET.r * i })
    }
  }

  for (const anchor of anchors) {
    const cells = placedShapeCells(hourglassCells, anchor, 0)
    board = applyTilePlacement(board, cells, 'water')
  }
  return board
}
