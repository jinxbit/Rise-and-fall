import type { AchievementContent } from './achievementContent'
import { appendLog } from './log'
import type { GameState } from './types'

function countUnitsOfKind(state: GameState, playerId: string, kind: string): number {
  return state.units.filter((u) => u.ownerId === playerId && u.kind === kind).length
}

/**
 * Detects newly-claimed achievements: for each achievement not yet claimed,
 * checks whether any non-eliminated player currently holds their full
 * per-player supply of the tied unit kind (`unitSupplyCaps` — the same
 * values as content/units.json's `supply.byPlayerCount`, reused here rather
 * than duplicated into AchievementContent, same as unit actions already do
 * via UnitContent). The first to qualify claims it, permanently —
 * achievements are never revoked, even if that player later drops below the
 * cap or is eliminated (src/engine/elimination.ts). If more than one player
 * qualifies in the same check (simultaneous), turn order breaks the tie —
 * an assumption, since the rules don't specify who's "first" in that case.
 *
 * Call this after anything that can change a player's unit count for a kind
 * — currently only RESOLVE_UNIT_ACTION (create/convert/a destroySelf
 * transform can each change who owns how many of a kind), via
 * applyResolveUnitAction in ./applyAction.ts.
 */
export function updateAchievementClaims(
  state: GameState,
  content: AchievementContent,
  unitSupplyCaps: Record<string, number>,
): GameState {
  let nextState = state

  for (const [achievementId, kind] of Object.entries(content.unitKindByAchievementId)) {
    if (nextState.claimedByAchievementId[achievementId]) continue
    const cap = unitSupplyCaps[kind]
    if (cap === undefined) continue

    const claimant = nextState.turnOrder
      .map((id) => nextState.players.find((p) => p.id === id))
      .find((p) => p && !p.eliminated && countUnitsOfKind(nextState, p.id, kind) >= cap)
    if (!claimant) continue

    nextState = {
      ...nextState,
      claimedByAchievementId: { ...nextState.claimedByAchievementId, [achievementId]: claimant.id },
      achievementsClaimedThisRound: nextState.achievementsClaimedThisRound + 1,
    }
    nextState = {
      ...nextState,
      log: appendLog(nextState, claimant.id, `Player ${claimant.id} claimed the ${kind} mastery achievement`),
    }
  }

  return nextState
}
