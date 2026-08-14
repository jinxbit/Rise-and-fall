import { createEmptyBoard, getTile, neighborCoords, setTile } from './board'
import type { Board, Coordinate, Terrain } from './types'
import { coordKey } from './types'

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

/**
 * The hex nearest a shape's own geometric centroid, in the shape's local
 * (unrotated) coordinates — i.e. its offset from `cells[0]` (the {0,0}
 * anchor cell, see terrain.schema.json). Used so that clicking a hex during
 * tile placement (see BoardSetupView.tsx) lands the *middle* of the tile
 * under the cursor rather than its cells[0] corner, which for an
 * asymmetric shape can be a hex or more away from where the player
 * actually clicked. Standard cube-coordinate rounding of the fractional
 * centroid (redblobgames.com/grids/hexagons/#rounding) — for shapes
 * without a true single center hex (an even cell count, or one without
 * six-fold symmetry) this still lands on the cell closest to the middle.
 */
export function shapeCenterCell(cells: Coordinate[]): Coordinate {
  const avgQ = cells.reduce((sum, c) => sum + c.q, 0) / cells.length
  const avgR = cells.reduce((sum, c) => sum + c.r, 0) / cells.length
  const x = avgQ
  const z = avgR
  const y = -x - z

  let rx = Math.round(x)
  let ry = Math.round(y)
  let rz = Math.round(z)
  const xDiff = Math.abs(rx - x)
  const yDiff = Math.abs(ry - y)
  const zDiff = Math.abs(rz - z)
  if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz
  else if (yDiff > zDiff) ry = -rx - rz
  else rz = -rx - ry

  return { q: rx, r: rz }
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

/**
 * Sets every hex in `placedCells` to `terrain`, covering (converting)
 * whatever was there before. Does not check legality — call
 * isLegalTilePlacement first. `placementId`, when given, tags every one of
 * these hexes as belonging to the same physical tile (see
 * Tile.placementId) — omit it for a virtual/hypothetical placement (e.g.
 * rule 4's room-checking simulations in canPlaceRemainingTiles below),
 * since nothing reads placementId outside the real, committed board.
 */
export function applyTilePlacement(board: Board, placedCells: Coordinate[], terrain: Terrain, placementId?: string): Board {
  return placedCells.reduce((nextBoard, cell) => setTile(nextBoard, cell, terrain, placementId), board)
}

// --- extra base-terrain (water expansion) placement rules ---------------------
//
// `placesOn: null` (Water) is the only terrain that can land on untiled
// holes at all (see isLegalTilePlacement above), which is what makes it
// need its own extra rules once there's existing Sea to check against: a
// new Sea tile must touch existing Sea, and can never trap empty hexes
// with nowhere left to go. Both assume `placedCells` is already known to
// satisfy isLegalTilePlacement — they only add these two extra checks, and
// boardSetup.ts's placeTile() only calls them when `placesOn === null`.

/**
 * How many distinct existing *tiles* (physical placements, not hexes — see
 * Tile.placementId) of `terrain` on `board` are adjacent to `placedCells`.
 * Two neighboring hexes from the same earlier placement (e.g. two hexes of
 * one multi-hex Sea tile) count once, not twice — a new tile bordering
 * only one earlier tile's edge, even along several of its hexes, hasn't
 * actually connected to a second tile. A hex with no `placementId` (an
 * already-persisted game from before this field existed, or a test board
 * built directly with setTile()) falls back to its own coordinate as a
 * standalone, single-hex "tile," so those boards still get a sane count
 * instead of every undefined hex wrongly merging into one.
 */
function adjacentExistingTilePlacementCount(board: Board, placedCells: Coordinate[], terrain: Terrain): number {
  const placedKeys = new Set(placedCells.map(coordKey))
  const tileIds = new Set<string>()

  for (const cell of placedCells) {
    for (const neighbor of neighborCoords(board, cell)) {
      const key = coordKey(neighbor)
      if (placedKeys.has(key)) continue
      const tile = getTile(board, neighbor)
      if (tile?.terrain !== terrain) continue
      tileIds.add(tile.placementId ?? key)
    }
  }
  return tileIds.size
}

/** Whether `placedCells` touches at least `minCount` distinct existing *tiles* (not just hexes) of `terrain` already on `board` — e.g. "a new Sea tile must touch at least 2 Sea tiles already present." */
export function touchesEnoughExistingTerrain(board: Board, placedCells: Coordinate[], terrain: Terrain, minCount: number): boolean {
  return adjacentExistingTilePlacementCount(board, placedCells, terrain) >= minCount
}

/**
 * Whether placing `placedCells` would seal off any untiled hex into a
 * pocket with no path out to the unbounded exterior — "you cannot close
 * off a zone containing empty spaces."
 *
 * Determined exactly, not heuristically: within the bounding box of every
 * tiled hex (existing tiles + `placedCells`) expanded by one hex of
 * margin, that margin ring is guaranteed tile-free (nothing can exist
 * outside the box it was computed from), so it's genuinely connected to
 * the true, infinite exterior. Flood-filling untiled hexes inward from
 * that margin finds every hex still open to the outside; any untiled hex
 * inside the box the flood fill never reaches is enclosed.
 */
export function wouldEncloseEmptyHexes(board: Board, placedCells: Coordinate[]): boolean {
  const tiledKeys = new Set(Object.keys(board.tiles))
  for (const cell of placedCells) tiledKeys.add(coordKey(cell))

  const allTiledCoords = [...Object.values(board.tiles).map((t) => t.coord), ...placedCells]
  const minQ = Math.min(...allTiledCoords.map((c) => c.q)) - 1
  const maxQ = Math.max(...allTiledCoords.map((c) => c.q)) + 1
  const minR = Math.min(...allTiledCoords.map((c) => c.r)) - 1
  const maxR = Math.max(...allTiledCoords.map((c) => c.r)) + 1
  const inBox = (c: Coordinate) => c.q >= minQ && c.q <= maxQ && c.r >= minR && c.r <= maxR

  const reachedFromOutside = new Set<string>()
  const stack: Coordinate[] = []
  for (let q = minQ; q <= maxQ; q++) stack.push({ q, r: minR }, { q, r: maxR })
  for (let r = minR; r <= maxR; r++) stack.push({ q: minQ, r }, { q: maxQ, r })

  while (stack.length > 0) {
    const cell = stack.pop()!
    const key = coordKey(cell)
    if (reachedFromOutside.has(key) || tiledKeys.has(key) || !inBox(cell)) continue
    reachedFromOutside.add(key)
    stack.push(...neighborCoords(board, cell))
  }

  for (let q = minQ; q <= maxQ; q++) {
    for (let r = minR; r <= maxR; r++) {
      const key = coordKey({ q, r })
      if (!tiledKeys.has(key) && !reachedFromOutside.has(key)) return true
    }
  }
  return false
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
        const key = cells.map(coordKey).sort().join('|')
        if (seen.has(key)) continue
        seen.add(key)
        placements.push({ cells, anchor, rotationSteps: rotation })
      }
    }
  }
  return placements
}

/** Bounds the backtracking searches below so a pathological board can't hang a placement check indefinitely — see canPlaceRemainingTiles's doc comment. */
const COMBO_SEARCH_STEP_BUDGET = 200_000

/**
 * Finds up to `limit` distinct ways to choose `count` pairwise-disjoint
 * placements out of `placements` (each combo is a set — order doesn't
 * matter). Stops as soon as `limit` combos are found, or once the search
 * has spent `stepBudget` steps without finding enough — a bounded,
 * best-effort search, not a guaranteed-exhaustive one.
 */
function findDisjointCombos(
  placements: CandidatePlacement[],
  count: number,
  limit: number,
  stepBudget: number = COMBO_SEARCH_STEP_BUDGET,
): CandidatePlacement[][] {
  const results: CandidatePlacement[][] = []
  const chosen: CandidatePlacement[] = []
  let steps = 0

  function backtrack(startIndex: number, usedCells: Set<string>): void {
    if (results.length >= limit || steps >= stepBudget) return
    steps++
    if (chosen.length === count) {
      results.push([...chosen])
      return
    }
    for (let i = startIndex; i < placements.length && results.length < limit && steps < stepBudget; i++) {
      const placement = placements[i]
      if (placement.cells.some((c) => usedCells.has(coordKey(c)))) continue
      const nextUsed = new Set(usedCells)
      for (const c of placement.cells) nextUsed.add(coordKey(c))
      chosen.push(placement)
      backtrack(i + 1, nextUsed)
      chosen.pop()
    }
  }

  backtrack(0, new Set())
  return results
}

/**
 * Whether `count` more tiles of this tier (`shapeCells`/`placesOn`) could
 * all still be legally placed on `board` — rule 4's no-space check (see
 * boardSetup.ts's placeTile): rather than searching for a minimal set of
 * already-placed tiles to relocate to open up room, a placement that
 * wouldn't leave room for the rest of the tier is rejected outright, and
 * the player has to choose a different placement instead.
 *
 * Backtracks for an actual combination of `count` pairwise-disjoint
 * placements (findDisjointCombos, the same search findForcedPlacement
 * below uses) instead of a naive "always take the first legal spot found"
 * greedy pass. A greedy pass can pick a placement that forecloses every
 * valid way to fit the rest, even when a different first choice would've
 * worked — confirmed against a real reported game where 8 more tiles
 * genuinely fit (a full backtracking search found a fit in 10 steps), but
 * the old greedy version couldn't find any arrangement at all and
 * wrongly rejected an already-accepted placement on replay/undo (see
 * todo.md).
 *
 * Bounded by a step budget (see findDisjointCombos) so a pathological
 * board can't hang the check indefinitely — if the budget runs out
 * without finding a fit, this conservatively reports "no room," matching
 * rule 4's existing bias toward rejecting when unsure rather than risking
 * a stranded future tile.
 *
 * `placesOn: null` (water) always returns true — the board is unbounded, so
 * there's always room somewhere.
 */
export function canPlaceRemainingTiles(board: Board, shapeCells: Coordinate[], placesOn: Terrain[] | null, count: number): boolean {
  if (placesOn === null || count <= 0) return true

  const placements = findAllLegalPlacements(board, shapeCells, placesOn)
  return findDisjointCombos(placements, count, 1).length > 0
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
 * first tile's anchor — i.e. one row lower, not the same height ("descend").
 */
const STARTING_WATER_DESCEND_OFFSET: Coordinate = { q: 2, r: 1 }

/**
 * The hourglass shape is point-symmetric (180-degree rotation about its own
 * center maps it onto itself), so besides the descend offset above, its
 * mirror direction interlocks a next tile exactly as tightly — one row
 * higher instead of lower ("ascend"). Brute-forcing every small offset
 * confirms these are the two tightest-interlocking, non-overlapping
 * directions (both touch along 5 hex-edge pairs, the max found).
 */
const STARTING_WATER_ASCEND_OFFSET: Coordinate = { q: 3, r: -1 }

/**
 * Seeds an empty hex board with the starting water "hourglass" tiles: one
 * per player, per ruling, chained by alternating the descend/ascend offsets
 * above (each new tile interlocks with the previous one, never with a
 * shared anchor — two tiles branching off the same anchor in the descend
 * and ascend directions always overlap each other). 2 players -> one
 * descending pair. 3 players -> descend then ascend, a "V". 4 players ->
 * descend, ascend, descend, a "W" — one connected zigzag chain, not two
 * disconnected pairs.
 *
 * `hourglassCells` is content/terrain.json's water/`initial` shapeGroup's
 * one shape's `cells` (the engine stays content-agnostic — see UNIT_KINDS
 * in ./cards.ts for the same convention — so the caller resolves it from
 * JSON and passes it in).
 */
export function seedStartingWaterTiles(playerCount: number, hourglassCells: Coordinate[]): Board {
  let board = createEmptyBoard('hex')

  const anchors: Coordinate[] = [{ q: 0, r: 0 }]
  for (let i = 1; i < playerCount; i++) {
    const offset = i % 2 === 1 ? STARTING_WATER_DESCEND_OFFSET : STARTING_WATER_ASCEND_OFFSET
    const previous = anchors[i - 1]
    anchors.push({ q: previous.q + offset.q, r: previous.r + offset.r })
  }

  // Each anchor is its own physical hourglass tile (see Tile.placementId) —
  // seeding starts from a fresh empty board, so a simple per-anchor index is
  // enough to keep every one of them distinct from every other.
  anchors.forEach((anchor, i) => {
    const cells = placedShapeCells(hourglassCells, anchor, 0)
    board = applyTilePlacement(board, cells, 'water', `seed_${i}`)
  })
  return board
}
