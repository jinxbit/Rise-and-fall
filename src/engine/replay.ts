import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent.ts'
import type { AchievementContent } from './achievementContent.ts'
import { applyAction } from './applyAction.ts'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent.ts'
import type { BoardGenerationContent } from './boardGenerationContent.ts'
import type { LoggedAction } from './actions.ts'
import { EMPTY_TALE_CONTENT } from './taleContent.ts'
import type { TaleContent } from './taleContent.ts'
import type { GameState } from './types.ts'
import { resolveHistory } from './historyFold.ts'
import { EMPTY_UNIT_CONTENT } from './unitContent.ts'
import type { UnitContent } from './unitContent.ts'

/**
 * Event-sourcing verification: replays a logged action history against a
 * genesis state (createNewGame() + startGame(), before any player action —
 * see GameState.actionHistory's doc comment for why genesis itself isn't a
 * logged entry) and returns the resulting GameState. Since applyAction() is
 * a pure, deterministic reducer, replaying the same actions against the
 * same genesis and content always reconstructs the exact same state —
 * that's what "the game has its full action history and a final state"
 * means in practice: the final state is always derivable from genesis +
 * history, and the stored GameState is just a cached shortcut so nothing
 * has to replay from scratch on every read.
 *
 * Throws if any logged action is rejected by applyAction() — a genesis/
 * content mismatch or a corrupted history, either of which means the
 * replayed state can no longer be trusted to match the original.
 *
 * Every entry here was already validated once, when it was originally
 * submitted and accepted into actionHistory — reconstructing that same
 * state doesn't need to re-run that validation (in particular PLACE_TILE's
 * bounded combinatorial room-search, by far the most expensive check this
 * engine has), so this always replays `trustedReplay: true` (see
 * applyAction's own doc comment in ./applyAction.ts).
 *
 * `history` may contain UNDO_ACTION/REDO_ACTION entries (design change,
 * issue #412 — see UndoAction's doc comment in ./actions.ts) interleaved
 * with substantive ones: resolveHistory (./historyFold.ts) folds those into
 * the substantive prefix currently "in effect", which is what actually gets
 * replayed below — undo/redo entries themselves are never fed to
 * applyAction(), since rewinding isn't a forward step. `SET_ADMIN_MODE`
 * entries ride along unconditionally instead (issue #545): they're excluded
 * from the undo/redo pointer itself (see walkHistory's doc comment,
 * ./historyFold.ts) but still always appear in `.effective`, in their
 * original relative order, so both the toggle's own effect and any forced
 * follow-up cascade folded into it (RULE_ENFORCEMENT_PLAN.md §4.2/§4.3)
 * replay exactly like any other action's would. The returned state's
 * `actionHistory` is always exactly the raw `history` passed in (not just
 * whatever the effective replay happened to accumulate), so a caller
 * appending a further action, or another undo/redo, keeps extending the
 * same append-only log.
 */
export function replayActions(
  genesis: GameState,
  history: LoggedAction[],
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): GameState {
  let state = genesis
  for (const entry of resolveHistory(history).effective) {
    const result = applyAction(state, entry.action, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!result.ok) {
      throw new Error(`Replay failed at action ${JSON.stringify(entry.action)}: ${result.error}`)
    }
    state = result.state
  }
  return { ...state, actionHistory: history }
}

/**
 * Advances a state that was replayed up to `base.actionHistory` by the
 * entries in `append`, for the delta read path (gameApi.ts's
 * `getGameStateRedacted`, and ../inFlightOverlay.ts's story about why a
 * client rebuilds state at all).
 *
 * Two things this gets right that a naive `append.forEach(applyAction)` does
 * not, both load-bearing:
 *
 * 1. **Undo and redo are logged actions, not a splice** (see ./undoRedo.ts and
 *    ./historyFold.ts). `resolveHistory` folds them, so an append carrying an
 *    `UNDO_ACTION` changes which *earlier* actions are effective — it cannot be
 *    applied incrementally on top of a state that already includes them.
 *    Applying the raw log in order instead of the effective log is exactly how
 *    this fails, and it fails loudly ("Not in the purchase phase") rather than
 *    subtly. So: incremental only when the append is undo-free, and a full
 *    rebuild from `genesis` otherwise. Undo is rare, so the cheap path is the
 *    normal one.
 * 2. **The log comes from the wire, not from the replay.** `applyAction`
 *    stamps `new Date().toISOString()` on each entry it logs, so entries the
 *    client reconstructs would carry its own clock instead of the server's.
 *    The resulting `actionHistory` is therefore `base.actionHistory` plus
 *    `append` verbatim — the server's entries, timestamps and all — rather
 *    than whatever the local replay happened to log. Without this, every
 *    client's log would drift from the server's by exactly the time it took to
 *    deliver the response.
 */
export function extendReplay(
  genesis: GameState,
  base: GameState,
  append: LoggedAction[],
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): GameState {
  const actionHistory = [...base.actionHistory, ...append]
  const foldRequired = append.some((entry) => entry.action.type === 'UNDO_ACTION' || entry.action.type === 'REDO_ACTION')
  if (foldRequired) {
    const rebuilt = replayActions(genesis, actionHistory, unitContent, achievementContent, boardGenerationContent, taleContent)
    return { ...rebuilt, actionHistory }
  }
  let state = base
  for (const entry of append) {
    const result = applyAction(state, entry.action, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!result.ok) throw new Error(`Delta replay failed at ${JSON.stringify(entry.action)}: ${result.error}`)
    state = result.state
  }
  return { ...state, actionHistory }
}
