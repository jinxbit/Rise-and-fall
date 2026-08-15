import type { VPBreakdown } from '../engine/victoryPoints'

export interface ScoreCategory {
  key: keyof Omit<VPBreakdown, 'total'>
  label: string
}

/** Fixed display order/wording for the four (five, with a Tale active) scoring categories — shared between EndGameView's category comparison table and ScoreCategoryChart so the two stay in sync. */
export const SCORE_CATEGORIES: ScoreCategory[] = [
  { key: 'gold', label: 'Gold' },
  { key: 'terrainControl', label: 'Terrain' },
  { key: 'boardCount', label: 'Units' },
  { key: 'achievements', label: 'Achievements' },
  { key: 'controllableStructures', label: 'Structures' },
]

/** SCORE_CATEGORIES filtered down to whatever at least one of `playerIds` actually scored — dropping an all-zero category (most commonly "Structures", outside a Tale that has any) rather than showing an empty row/cluster for it. */
export function scoredCategories(breakdownByPlayerId: Record<string, VPBreakdown>, playerIds: string[]): ScoreCategory[] {
  return SCORE_CATEGORIES.filter((c) => playerIds.some((id) => (breakdownByPlayerId[id]?.[c.key] ?? 0) > 0))
}
