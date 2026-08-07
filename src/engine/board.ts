import type { Board, BoardShape, Coordinate, Terrain, Tile } from './types'
import { coordKey } from './types'

export function createEmptyBoard(shape: BoardShape): Board {
  return { shape, tiles: {} }
}

export function setTile(board: Board, coord: Coordinate, terrain: Terrain): Board {
  const key = coordKey(coord)
  const existing = board.tiles[key]
  const tile: Tile = {
    id: existing?.id ?? key,
    coord,
    terrain,
    occupantIds: existing?.occupantIds ?? [],
  }
  return {
    ...board,
    tiles: { ...board.tiles, [key]: tile },
  }
}

export function getTile(board: Board, coord: Coordinate): Tile | undefined {
  return board.tiles[coordKey(coord)]
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
