import { neighborCoords } from './board'
import type { Board, Coordinate, Tile, Unit } from './types'
import { coordKey } from './types'

/**
 * Victory-point source 3 (terrain control): the board is partitioned into
 * maximal regions of grid-adjacent hexes that share the same *effective*
 * terrain (see `terrainScoresAs` below). Each region is checked for unit
 * majority — the player with strictly more units on hexes within that
 * region than any other player scores `terrainVictoryPoints[region terrain]`
 * once per hex in the region. A region with no single player in the lead
 * (including an empty region, or a terrain id missing from
 * `terrainVictoryPoints`) scores nothing, for anyone.
 *
 * Units are counted individually per hex — two units from the same owner
 * stacked on one hex count as 2 toward that owner's regional total; the
 * rules don't say otherwise yet.
 *
 * Per ruling, cliff edges do not affect region shape — only terrain type and
 * grid adjacency do (the current `Tile` model has no per-edge cliff data to
 * consult anyway).
 *
 * Deliberately takes `board`/`units`/`terrainVictoryPoints`/`terrainScoresAs`
 * rather than a full `GameState`: terrain-id agnostic (works against both
 * the engine's current placeholder `Terrain` union and the real 5 terrain
 * types from content/terrain.json), and keeps content data as explicit
 * parameters per the engine's pure data-in/data-out convention (see
 * UNIT_KINDS in ./cards.ts). Real board generation doesn't exist yet, so
 * this can't run against an actual game board — it's written and tested
 * against synthetic ones, ready to plug in once it does.
 *
 * @param terrainScoresAs Per ruling, a terrain id can be merged into another
 *   for scoring purposes — e.g. content/terrain.json has Glacier's
 *   `scoresAs: "mountain"`, so Glacier hexes are grouped into (and use the
 *   VP value of) Mountain regions instead of forming their own; they also
 *   don't break a Mountain region's contiguity. A terrain id missing from
 *   this map defaults to itself (no merge).
 */
export function calculateTerrainControlVP(
  board: Board,
  units: Unit[],
  terrainVictoryPoints: Record<string, number>,
  terrainScoresAs: Record<string, string> = {},
): Record<string, number> {
  const vpByPlayerId: Record<string, number> = {}

  for (const region of findTerrainRegions(board, terrainScoresAs)) {
    const majorityOwnerId = findMajorityOwner(region, units)
    if (!majorityOwnerId) continue

    const perHex = terrainVictoryPoints[region.terrain] ?? 0
    vpByPlayerId[majorityOwnerId] = (vpByPlayerId[majorityOwnerId] ?? 0) + perHex * region.tiles.length
  }

  return vpByPlayerId
}

export interface TerrainControlDetail {
  /** Effective terrain id (post-terrainScoresAs merge — e.g. Glacier folds into 'mountain'). */
  terrain: string
  /** Total hexes controlled across every region of this terrain the player holds a majority in. */
  hexCount: number
  vp: number
}

/**
 * The same terrain-control scoring as calculateTerrainControlVP, but
 * itemized per (player, terrain) instead of summed into one number per
 * player — for a player-facing breakdown (e.g. "4 Forest: 12 points")
 * rather than just the bottom line. Multiple separate regions of the same
 * effective terrain the same player controls are combined into one entry
 * (hexCount and vp both summed), matching how calculateTerrainControlVP
 * already sums across regions for that player.
 */
export function calculateTerrainControlDetail(
  board: Board,
  units: Unit[],
  terrainVictoryPoints: Record<string, number>,
  terrainScoresAs: Record<string, string> = {},
): Record<string, TerrainControlDetail[]> {
  const detailByPlayerId: Record<string, Map<string, TerrainControlDetail>> = {}

  for (const region of findTerrainRegions(board, terrainScoresAs)) {
    const majorityOwnerId = findMajorityOwner(region, units)
    if (!majorityOwnerId) continue

    const perHex = terrainVictoryPoints[region.terrain] ?? 0
    const byTerrain = detailByPlayerId[majorityOwnerId] ?? new Map<string, TerrainControlDetail>()
    detailByPlayerId[majorityOwnerId] = byTerrain

    const existing = byTerrain.get(region.terrain)
    if (existing) {
      existing.hexCount += region.tiles.length
      existing.vp += perHex * region.tiles.length
    } else {
      byTerrain.set(region.terrain, { terrain: region.terrain, hexCount: region.tiles.length, vp: perHex * region.tiles.length })
    }
  }

  const result: Record<string, TerrainControlDetail[]> = {}
  for (const [playerId, byTerrain] of Object.entries(detailByPlayerId)) {
    result[playerId] = [...byTerrain.values()]
  }
  return result
}

export interface TerritoryControlHex {
  coord: Coordinate
  ownerId: string
  /** Effective terrain of the region this hex belongs to (post-terrainScoresAs merge) — lets a renderer split two adjacent same-owner regions of different terrain apart instead of blending them into one shape (see HexBoard's territoryControl prop). */
  terrain: string
}

/**
 * The same terrain-region majority-owner rule as calculateTerrainControlVP,
 * exposed per-hex instead of summed into VP — for the victory screen's final
 * board (see EndGameView.tsx), which highlights who controls which territory
 * regardless of what that terrain happens to be worth. Deliberately takes no
 * `terrainVictoryPoints` table: a region a player controls is still "theirs"
 * to show on the map even if its terrain scores 0 (or isn't in the table at
 * all), unlike the VP calculation, which drops those regions entirely.
 * Regions with no majority owner (including empty ones) are simply absent
 * from the result — every present entry has a real controlling player.
 */
export function calculateTerritoryControlByHex(
  board: Board,
  units: Unit[],
  terrainScoresAs: Record<string, string> = {},
): TerritoryControlHex[] {
  const result: TerritoryControlHex[] = []

  for (const region of findTerrainRegions(board, terrainScoresAs)) {
    const majorityOwnerId = findMajorityOwner(region, units)
    if (!majorityOwnerId) continue

    for (const tile of region.tiles) {
      result.push({ coord: tile.coord, ownerId: majorityOwnerId, terrain: region.terrain })
    }
  }

  return result
}

interface TerrainRegion {
  terrain: string
  tiles: Tile[]
}

function effectiveTerrain(terrain: string, terrainScoresAs: Record<string, string>): string {
  return terrainScoresAs[terrain] ?? terrain
}

/** Flood-fills every tile on the board into maximal connected same-effective-terrain regions. */
function findTerrainRegions(board: Board, terrainScoresAs: Record<string, string>): TerrainRegion[] {
  const visited = new Set<string>()
  const regions: TerrainRegion[] = []

  for (const startTile of Object.values(board.tiles)) {
    const startKey = coordKey(startTile.coord)
    if (visited.has(startKey)) continue

    const regionTerrain = effectiveTerrain(startTile.terrain, terrainScoresAs)
    const regionTiles: Tile[] = []
    const queue: Tile[] = [startTile]
    visited.add(startKey)

    while (queue.length > 0) {
      const current = queue.shift() as Tile
      regionTiles.push(current)

      for (const neighborCoord of neighborCoords(board, current.coord)) {
        const neighborKey = coordKey(neighborCoord)
        if (visited.has(neighborKey)) continue

        const neighborTile = board.tiles[neighborKey]
        if (!neighborTile || effectiveTerrain(neighborTile.terrain, terrainScoresAs) !== regionTerrain) continue

        visited.add(neighborKey)
        queue.push(neighborTile)
      }
    }

    regions.push({ terrain: regionTerrain, tiles: regionTiles })
  }

  return regions
}

/** The unit-count leader among hexes in `region`, or null if there's a tie for the lead (including nobody there). */
function findMajorityOwner(region: TerrainRegion, units: Unit[]): string | null {
  const coordKeysInRegion = new Set(region.tiles.map((t) => coordKey(t.coord)))
  const countsByOwner: Record<string, number> = {}

  for (const unit of units) {
    if (!coordKeysInRegion.has(coordKey(unit.coord))) continue
    countsByOwner[unit.ownerId] = (countsByOwner[unit.ownerId] ?? 0) + 1
  }

  let leaderId: string | null = null
  let leaderCount = 0
  let tiedForLead = false

  for (const [ownerId, count] of Object.entries(countsByOwner)) {
    if (count > leaderCount) {
      leaderId = ownerId
      leaderCount = count
      tiedForLead = false
    } else if (count === leaderCount) {
      tiedForLead = true
    }
  }

  return tiedForLead || leaderId === null ? null : leaderId
}
