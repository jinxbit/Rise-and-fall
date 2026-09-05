import type { GameState } from './types.ts'

/**
 * Rule 1: the decline phase only fires in a round where at least one
 * achievement was newly claimed. `achievementsClaimedThisRound` is reset to
 * 0 at the start of every round (beginSelectCardsPhase) and incremented by
 * updateAchievementClaims after each RESOLVE_UNIT_ACTION, so this can never
 * re-trigger off the same claim twice — each achievement in
 * `claimedByAchievementId` is only ever claimed once for the whole game.
 */
export function isDeclineTriggered(state: GameState): boolean {
  return state.achievementsClaimedThisRound > 0
}
