import type { Board, BoardShape, Coordinate, Terrain, Tile } from './types'
import { coordKey } from './types'

export function createEmptyBoard(shape: BoardShape): Board {
  return { shape, tiles: {} }
}

/** `placementId` (see Tile.placementId) is only meaningful when actually placing a tile — see applyTilePlacement in ./boardGeneration.ts; omit it for any other terrain change. */
export function setTile(board: Board, coord: Coordinate, terrain: Terrain, placementId?: string): Board {
  const key = coordKey(coord)
  const existing = board.tiles[key]
  const tile: Tile = {
    id: existing?.id ?? key,
    coord,
    terrain,
    occupantIds: existing?.occupantIds ?? [],
    placementId,
  }
  return {
    ...board,
    tiles: { ...board.tiles, [key]: tile },
  }
}

export function getTile(board: Board, coord: Coordinate): Tile | undefined {
  return board.tiles[coordKey(coord)]
}

/**
 * A stable, deterministic string signature of a board's terrain layout —
 * every hex's coordinate + terrain, sorted so tile insertion order never
 * affects the result. Used to detect duplicate saved maps (see
 * src/lib/mapPoolApi.ts's saveMapToPool) — deliberately terrain-only,
 * ignoring `id`/`occupantIds`/`placementId`, since two boards with
 * identical terrain are the same map for pooling purposes regardless of
 * how they were built or what (if anything) is standing on them.
 */
export function canonicalizeBoard(board: Board): string {
  const tiles = Object.values(board.tiles)
    .map((t) => `${t.coord.q},${t.coord.r},${t.terrain}`)
    .sort()
  return `${board.shape}|${tiles.join(';')}`
}

/** Axial hex neighbor offsets (pointy-top convention). */
const HEX_DIRECTIONS: Coordinate[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]

const SQUARE_DIRECTIONS: Coordinate[] = [
  { q: 1, r: 0 },
  { q: -1, r: 0 },
  { q: 0, r: 1 },
  { q: 0, r: -1 },
]

export function neighborCoords(board: Board, coord: Coordinate): Coordinate[] {
  const directions = board.shape === 'hex' ? HEX_DIRECTIONS : SQUARE_DIRECTIONS
  return directions.map((d) => ({ q: coord.q + d.q, r: coord.r + d.r }))
}

export function neighborTiles(board: Board, coord: Coordinate): Tile[] {
  return neighborCoords(board, coord)
    .map((c) => getTile(board, c))
    .filter((t): t is Tile => t !== undefined)
}

/**
 * Every hex within `maxDistance` steps of `coord` (not including `coord`
 * itself) — for a Tale ability with a farther-than-adjacent range (e.g.
 * The Cathedral Tale's convert/income at distance 2), same neighbor-
 * direction stepping legalConvertTargets/computeIncomeGold otherwise use
 * for distance 1. Doesn't filter by whether a hex actually has a tile —
 * same convention as neighborCoords, whose callers filter via getTile as
 * needed.
 */
export function coordsWithinDistance(board: Board, coord: Coordinate, maxDistance: number): Coordinate[] {
  const visited = new Set([coordKey(coord)])
  const result: Coordinate[] = []
  let frontier: Coordinate[] = [coord]

  for (let step = 0; step < maxDistance; step++) {
    const next: Coordinate[] = []
    for (const from of frontier) {
      for (const neighbor of neighborCoords(board, from)) {
        const key = coordKey(neighbor)
        if (visited.has(key)) continue
        visited.add(key)
        result.push(neighbor)
        next.push(neighbor)
      }
    }
    frontier = next
  }

  return result
}

/**
 * Flood-fills every hex reachable from `start` while staying on the same
 * terrain as `start`'s own tile — e.g. a Ship's whole contiguous "sea area"
 * for its Trade action. Adjacency alone decides the region; cliffs never
 * interrupt it (a cliff is a level difference between *different* terrains,
 * which can't occur between same-terrain neighbors).
 */
export function connectedTerrainRegion(board: Board, start: Coordinate): Coordinate[] {
  const startTile = getTile(board, start)
  if (!startTile) return []
  const terrain = startTile.terrain

  const visited = new Set([coordKey(start)])
  const region: Coordinate[] = [start]
  let frontier: Coordinate[] = [start]

  while (frontier.length > 0) {
    const next: Coordinate[] = []
    for (const from of frontier) {
      for (const neighbor of neighborCoords(board, from)) {
        const key = coordKey(neighbor)
        if (visited.has(key)) continue
        const tile = getTile(board, neighbor)
        if (!tile || tile.terrain !== terrain) continue
        visited.add(key)
        region.push(neighbor)
        next.push(neighbor)
      }
    }
    frontier = next
  }

  return region
}
