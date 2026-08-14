import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import type { AchievementContent } from './achievementContent'
import { applyAction } from './applyAction'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import type { LoggedAction } from './actions'
import { EMPTY_TALE_CONTENT } from './taleContent'
import type { TaleContent } from './taleContent'
import type { GameState } from './types'
import { EMPTY_UNIT_CONTENT } from './unitContent'
import type { UnitContent } from './unitContent'

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
  for (const entry of history) {
    const result = applyAction(state, entry.action, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!result.ok) {
      throw new Error(`Replay failed at action ${JSON.stringify(entry.action)}: ${result.error}`)
    }
    state = result.state
  }
  return state
}
