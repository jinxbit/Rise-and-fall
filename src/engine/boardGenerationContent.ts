import type { Coordinate, Terrain } from './types'

/**
 * One terrain tier of the interactive tile-placement sub-phase (see
 * src/engine/boardSetup.ts) — everything needed to validate and apply a
 * placement of this tier's tile. Resolved by the caller from
 * content/terrain.json (the engine itself never imports JSON — see
 * UNIT_KINDS in ./cards.ts for the same convention). Water only ever
 * appears here via its `expansion` shapeGroup — the `initial` shapeGroup's
 * starting tiles are seeded automatically (seedStartingWaterTiles in
 * ./boardGeneration.ts) before this interactive phase ever begins.
 */
export interface TileTierContent {
  terrain: Terrain
  /** This tier's one shape's `cells` (every tier currently has exactly one shape — see terrain.json). */
  shapeCells: Coordinate[]
  /** content/terrain.json's `placesOn` for this terrain — null only for water, meaning "must be placed on untiled hexes," never covering anything. */
  placesOn: Terrain[] | null
  /** content/terrain.json's `limits.byPlayerCount` for this tier's shapeGroup, already resolved for this game's player count. */
  poolSize: number
}

/**
 * Everything the boardSetup tile-placement sub-phase needs, in placement
 * order: water (expansion) -> plain -> forest -> mountain -> glacier, per
 * ruling.
 */
export interface BoardGenerationContent {
  /** content/terrain.json's water/`initial` shapeGroup's one shape's `cells` — used only for the automatic starting-tile seeding step, not the interactive phase. */
  startingWaterShapeCells: Coordinate[]
  /** The interactive phase's tiers, in the order they're placed. */
  tiers: TileTierContent[]
}

export const EMPTY_BOARD_GENERATION_CONTENT: BoardGenerationContent = {
  startingWaterShapeCells: [],
  tiers: [],
}
