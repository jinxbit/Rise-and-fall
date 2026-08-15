import type { LoggedAction } from './actions'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import type { AchievementContent } from './achievementContent'
import { applyAction } from './applyAction'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import { EMPTY_TALE_CONTENT } from './taleContent'
import type { TaleContent } from './taleContent'
import type { GameState } from './types'
import { EMPTY_UNIT_CONTENT } from './unitContent'
import type { UnitContent } from './unitContent'
import { calculateVPBreakdown } from './victoryPoints'

export interface ScoreSnapshot {
  /** GameState.turn (the round number) at the moment this snapshot was taken. */
  turn: number
  totalByPlayerId: Record<string, number>
}

function snapshotOf(state: GameState, achievementContent: AchievementContent, taleContent: TaleContent): ScoreSnapshot {
  const breakdown = calculateVPBreakdown(state, achievementContent, taleContent)
  const totalByPlayerId: Record<string, number> = {}
  for (const player of state.players) totalByPlayerId[player.id] = breakdown[player.id]?.total ?? 0
  return { turn: state.turn, totalByPlayerId }
}

/**
 * The "total score over time" series behind the end-of-game chart
 * (EndGameView.tsx): replays `actionHistory` from `genesis` (the same
 * event-sourcing ./replay.ts uses) and takes one VP snapshot every time a
 * round finishes (GameState.turn advancing), plus a final snapshot of
 * wherever replay actually ends up — which matters when the game completes
 * mid-round (e.g. the winning achievement is claimed before the round's
 * last player has acted), so the series doesn't silently omit the true
 * final score. Nothing here is stored: like turnReview.ts/gameLog.ts, it's
 * cheap enough to re-derive from genesis + actionHistory on demand instead
 * of needing its own persisted per-round scoring table.
 */
export function calculateScoreHistory(
  genesis: GameState,
  actionHistory: LoggedAction[],
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): ScoreSnapshot[] {
  let state = genesis
  let lastSnapshotState = state
  const snapshots: ScoreSnapshot[] = [snapshotOf(state, achievementContent, taleContent)]

  for (const entry of actionHistory) {
    const result = applyAction(state, entry.action, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!result.ok) break
    state = result.state
    if (state.turn !== lastSnapshotState.turn) {
      snapshots.push(snapshotOf(state, achievementContent, taleContent))
      lastSnapshotState = state
    }
  }

  if (state !== lastSnapshotState) snapshots.push(snapshotOf(state, achievementContent, taleContent))
  return snapshots
}
