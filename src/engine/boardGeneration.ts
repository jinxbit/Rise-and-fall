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
 * Finds one legal placement of `shapeCells` somewhere on `board`, in any of
 * the 6 rotations, or `null` if none exists. Every legal placement's own
 * anchor cell (local `{0,0}` by convention — see rotateShape's doc comment)
 * must itself land on a hex the shape is allowed to cover, so it's enough
 * to try anchoring each cell of each rotation onto each currently-tiled hex
 * with a qualifying terrain — no need to search the (otherwise unbounded)
 * plane of empty coordinates.
 */
function findLegalPlacement(board: Board, shapeCells: Coordinate[], placesOn: Terrain[]): Coordinate[] | null {
  const candidateHexes = Object.values(board.tiles).filter((tile) => placesOn.includes(tile.terrain))

  for (let rotation = 0; rotation < 6; rotation++) {
    const rotatedCells = rotateShape(shapeCells, rotation)
    for (const hex of candidateHexes) {
      for (const localCell of rotatedCells) {
        const anchor: Coordinate = { q: hex.coord.q - localCell.q, r: hex.coord.r - localCell.r }
        const placed = placedShapeCells(shapeCells, anchor, rotation)
        if (isLegalTilePlacement(board, placed, placesOn)) return placed
      }
    }
  }
  return null
}

/**
 * Whether `count` more tiles of this tier (`shapeCells`/`placesOn`, each
 * resolving to `terrain` once placed) could all still be legally placed on
 * `board` — rule 4's no-space check (see boardSetup.ts's placeTile): rather
 * than searching for a minimal set of already-placed tiles to relocate to
 * open up room, a placement that wouldn't leave room for the rest of the
 * tier is rejected outright, and the player has to choose a different
 * placement instead.
 *
 * Checking room for just one more tile isn't enough — a spot that fits one
 * more tile can still leave zero room for the tile after that, and by the
 * time that's discovered the earlier placement is already locked in. So
 * this greedily finds one legal placement, applies it to a working copy of
 * the board, and repeats `count` times; if any iteration finds nowhere left
 * to go, the whole placement is rejected. (This is a greedy approximation,
 * not an exhaustive search of every possible placement order — in
 * principle a different choice of which legal spot to fill first could
 * leave room where this doesn't — but it matches the ruling this
 * implements: "make sure all other tiles of the same terrain type are
 * placeable.")
 *
 * `placesOn: null` (water) always returns true — the board is unbounded, so
 * there's always room somewhere.
 */
export function canPlaceRemainingTiles(
  board: Board,
  shapeCells: Coordinate[],
  placesOn: Terrain[] | null,
  terrain: Terrain,
  count: number,
): boolean {
  if (placesOn === null) return true

  let workingBoard = board
  for (let i = 0; i < count; i++) {
    const placed = findLegalPlacement(workingBoard, shapeCells, placesOn)
    if (placed === null) return false
    workingBoard = applyTilePlacement(workingBoard, placed, terrain)
  }
  return true
}

function cellKey(c: Coordinate): string {
  return `${c.q},${c.r}`
}

interface CandidatePlacement {
  cells: Coordinate[]
  anchor: Coordinate
  rotationSteps: number
}

/** Every distinct legal placement of `shapeCells` on `board` (deduped by covered cell-set — a symmetric shape can reach the same cells via more than one rotation/anchor pair). */
function findAllLegalPlacements(board: Board, shapeCells: Coordinate[], placesOn: Terrain[]): CandidatePlacement[] {
  const candidateHexes = Object.values(board.tiles).filter((tile) => placesOn.includes(tile.terrain))
  const seen = new Set<string>()
  const placements: CandidatePlacement[] = []

  for (let rotation = 0; rotation < 6; rotation++) {
    const rotatedCells = rotateShape(shapeCells, rotation)
    for (const hex of candidateHexes) {
      for (const localCell of rotatedCells) {
        const anchor: Coordinate = { q: hex.coord.q - localCell.q, r: hex.coord.r - localCell.r }
        const cells = placedShapeCells(shapeCells, anchor, rotation)
        if (!isLegalTilePlacement(board, cells, placesOn)) continue
        const key = cells.map(cellKey).sort().join('|')
        if (seen.has(key)) continue
        seen.add(key)
        placements.push({ cells, anchor, rotationSteps: rotation })
      }
    }
  }
  return placements
}

/**
 * Finds up to `limit` distinct ways to choose `count` pairwise-disjoint
 * placements out of `placements` (each combo is a set — order doesn't
 * matter). Stops as soon as `limit` combos are found, since
 * findForcedPlacement only needs to tell "exactly one" apart from "more
 * than one," not enumerate every combo.
 */
function findDisjointCombos(placements: CandidatePlacement[], count: number, limit: number): CandidatePlacement[][] {
  const results: CandidatePlacement[][] = []
  const chosen: CandidatePlacement[] = []

  function backtrack(startIndex: number, usedCells: Set<string>): void {
    if (results.length >= limit) return
    if (chosen.length === count) {
      results.push([...chosen])
      return
    }
    for (let i = startIndex; i < placements.length && results.length < limit; i++) {
      const placement = placements[i]
      if (placement.cells.some((c) => usedCells.has(cellKey(c)))) continue
      const nextUsed = new Set(usedCells)
      for (const c of placement.cells) nextUsed.add(cellKey(c))
      chosen.push(placement)
      backtrack(i + 1, nextUsed)
      chosen.pop()
    }
  }

  backtrack(0, new Set())
  return results
}

/**
 * A legal placement guaranteed to be part of it if and only if there is
 * exactly one way left to place all `count` of this tier's remaining tiles
 * (as a set — which physical tile goes where doesn't matter, only which
 * hexes end up covered) — i.e. the "decision" isn't really a decision
 * anymore, since every other option has already been ruled out. Returns
 * `null` when zero or multiple such combos exist, or for `placesOn: null`
 * (water), which is never forced since the board is unbounded.
 *
 * Once a combo of `count` disjoint placements is the *only* one, fixing
 * any single member of it and re-deriving the forced combo for the
 * remaining `count - 1` always reproduces the rest of that same combo (a
 * second combo for the remainder would combine with the fixed member to
 * form a second full combo, contradicting uniqueness) — so it's safe to
 * apply the returned placement and re-run this check for what's left,
 * same as boardSetup.ts's applyAction cascade does.
 *
 * Capped at 60 distinct legal placements before attempting the combo
 * search: a shape with that much room to work with almost never turns out
 * to be forced anyway (many independent placements exist), so this bound
 * just skips the expensive search in the case it wouldn't have paid off,
 * without changing the outcome for any board small enough to plausibly be
 * forced.
 */
export function findForcedPlacement(
  board: Board,
  shapeCells: Coordinate[],
  placesOn: Terrain[] | null,
  count: number,
): { anchor: Coordinate; rotationSteps: number } | null {
  if (placesOn === null || count <= 0) return null

  const placements = findAllLegalPlacements(board, shapeCells, placesOn)
  if (placements.length > 60) return null

  const combos = findDisjointCombos(placements, count, 2)
  if (combos.length !== 1) return null

  const [chosen] = combos[0]
  return { anchor: chosen.anchor, rotationSteps: chosen.rotationSteps }
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
