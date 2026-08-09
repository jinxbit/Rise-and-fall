/**
 * Rule: the gold cost to buy a card back from decline during the purchase
 * phase rises as achievements are claimed over the course of the game.
 *
 * @param achievementsClaimedSoFar Total achievements claimed across all
 *   players so far (same counter as content/achievements.json's
 *   `gameLength`). Before any have been claimed, cost is 0 — the rules
 *   don't price that case, so it's treated as free.
 * @param costTable content/achievements.json's `purchaseCost.byAchievementCount`:
 *   costTable[i] is the price once i+1 achievements have been claimed in
 *   total (1-indexed, same convention as `victoryPoints.byBoardCount` in
 *   units.json). A count past the table's length uses the last entry.
 */
export function calculatePurchaseCost(achievementsClaimedSoFar: number, costTable: number[]): number {
  if (achievementsClaimedSoFar <= 0 || costTable.length === 0) return 0
  return costTable[Math.min(achievementsClaimedSoFar, costTable.length) - 1]
}
