import { neighborCoords } from './board'
import type { Board, Tile, Unit } from './types'
import { coordKey } from './types'

/**
 * Victory-point source 3 (terrain control): the board is partitioned into
 * maximal regions of grid-adjacent, same-terrain hexes. Each region is
 * checked for unit majority — the player with strictly more units on hexes
 * within that region than any other player scores
 * `terrainVictoryPoints[region terrain]` once per hex in the region. A
 * region with no single player in the lead (including an empty region, or a
 * terrain id missing from `terrainVictoryPoints`) scores nothing, for
 * anyone.
 *
 * Units are counted individually per hex — two units from the same owner
 * stacked on one hex count as 2 toward that owner's regional total; the
 * rules don't say otherwise yet.
 *
 * Per ruling, cliff edges do not affect region shape — only terrain type and
 * grid adjacency do (the current `Tile` model has no per-edge cliff data to
 * consult anyway).
 *
 * Deliberately takes `board`/`units`/`terrainVictoryPoints` rather than a
 * full `GameState`: terrain-id agnostic (works against both the engine's
 * current placeholder `Terrain` union and the real 5 terrain types from
 * content/terrain.json), and keeps content data as an explicit parameter
 * per the engine's pure data-in/data-out convention (see UNIT_KINDS in
 * ./cards.ts). Real board generation doesn't exist yet, so this can't run
 * against an actual game board — it's written and tested against synthetic
 * ones, ready to plug in once it does.
 */
export function calculateTerrainControlVP(
  board: Board,
  units: Unit[],
  terrainVictoryPoints: Record<string, number>,
): Record<string, number> {
  const vpByPlayerId: Record<string, number> = {}

  for (const region of findTerrainRegions(board)) {
    const majorityOwnerId = findMajorityOwner(region, units)
    if (!majorityOwnerId) continue

    const perHex = terrainVictoryPoints[region.terrain] ?? 0
    vpByPlayerId[majorityOwnerId] = (vpByPlayerId[majorityOwnerId] ?? 0) + perHex * region.tiles.length
  }

  return vpByPlayerId
}

interface TerrainRegion {
  terrain: string
  tiles: Tile[]
}

/** Flood-fills every tile on the board into maximal connected same-terrain regions. */
function findTerrainRegions(board: Board): TerrainRegion[] {
  const visited = new Set<string>()
  const regions: TerrainRegion[] = []

  for (const startTile of Object.values(board.tiles)) {
    const startKey = coordKey(startTile.coord)
    if (visited.has(startKey)) continue

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
        if (!neighborTile || neighborTile.terrain !== startTile.terrain) continue

        visited.add(neighborKey)
        queue.push(neighborTile)
      }
    }

    regions.push({ terrain: startTile.terrain, tiles: regionTiles })
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
