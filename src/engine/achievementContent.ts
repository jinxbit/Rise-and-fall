/**
 * Everything applyAction/finishRound need to resolve achievement claims,
 * purchase cost, and the game-end/win check — resolved by the caller from
 * content/achievements.json, content/units.json, and content/terrain.json
 * (the engine itself never imports JSON — see UNIT_KINDS in ./cards.ts for
 * the same convention as UnitContent in ./unitContent.ts).
 */
export interface AchievementContent {
  /** content/achievements.json's achievements[].unitId, keyed by achievement id. */
  unitKindByAchievementId: Record<string, string>
  /** content/achievements.json's achievements[].victoryPoints, keyed by achievement id. */
  achievementVictoryPoints: Record<string, number>
  /** content/achievements.json's purchaseCost.byAchievementCount. */
  purchaseCostTable: number[]
  /**
   * content/achievements.json's gameLength (the players' chosen target,
   * between gameLength.min/max) — total achievements claimed across all
   * players that ends the game. Infinity if omitted, so a game with no
   * achievement content supplied never auto-ends.
   */
  gameLength: number
  /** content/units.json's victoryPoints.byBoardCount, keyed by unit kind id. */
  unitBoardCountVP: Record<string, number[]>
  /** content/terrain.json's victoryPoints, keyed by terrain id. */
  terrainVictoryPoints: Record<string, number>
  /** content/terrain.json's scoresAs, keyed by terrain id. */
  terrainScoresAs: Record<string, string>
  /**
   * content/achievements.json's goldVictoryPoints.goldPerPoint — how much
   * held gold is worth 1 victory point (rounded down), the fourth VP
   * source alongside achievements/board-count/terrain-control. `null`
   * means gold doesn't count toward VP at all (no content supplied).
   */
  goldPerVictoryPoint: number | null
}

export const EMPTY_ACHIEVEMENT_CONTENT: AchievementContent = {
  unitKindByAchievementId: {},
  achievementVictoryPoints: {},
  purchaseCostTable: [],
  gameLength: Infinity,
  unitBoardCountVP: {},
  terrainVictoryPoints: {},
  terrainScoresAs: {},
  goldPerVictoryPoint: null,
}
