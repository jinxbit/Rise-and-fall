/**
 * Rule: a hexside is a cliff if the absolute difference between the two
 * hexes' terrain elevation levels is greater than 1 (e.g. Water(0)-Plain(1)
 * = 1, not a cliff; Water(0)-Mountain(3) = 3, a cliff). Cliffs block
 * movement/adjacency for every unit except those with `canCrossCliffs`
 * (see units.json).
 */
export function isCliffEdge(levelA: number, levelB: number): boolean {
  return Math.abs(levelA - levelB) > 1
}

/**
 * Same rule, resolving terrain ids to levels first via `terrainLevels`
 * (content/terrain.json's `level` field, passed in explicitly per the
 * engine's pure data-in/data-out convention — see UNIT_KINDS in ./cards.ts).
 * A terrain id missing from the map defaults to level 0.
 */
export function isCliffBetweenTerrains(
  terrainA: string,
  terrainB: string,
  terrainLevels: Record<string, number>,
): boolean {
  return isCliffEdge(terrainLevels[terrainA] ?? 0, terrainLevels[terrainB] ?? 0)
}
