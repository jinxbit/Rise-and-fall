import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent.ts'
import type { AchievementContent } from './achievementContent.ts'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent.ts'
import type { BoardGenerationContent } from './boardGenerationContent.ts'
import { resolveHistory } from './historyFold.ts'
import { replayActions } from './replay.ts'
import { EMPTY_TALE_CONTENT } from './taleContent.ts'
import type { TaleContent } from './taleContent.ts'
import type { ActionResult, GameState } from './types.ts'
import { EMPTY_UNIT_CONTENT } from './unitContent.ts'
import type { UnitContent } from './unitContent.ts'

export type { ResolvedHistory } from './historyFold.ts'
export { resolveHistory } from './historyFold.ts'

/**
 * Submits one or more UNDO_ACTION entries against `state`, live-style (see
 * applyAction's own doc comment for the "live callers route through here,
 * not a raw history splice" convention this mirrors): appends an entry, then
 * re-derives the whole GameState via replayActions, which knows how to fold
 * it in (see resolveHistory, ./historyFold.ts). `genesis` — reconstructed by
 * the caller, same as every other genesis-needing engine entry point (e.g.
 * GamePage.tsx's handleUndo, the undo-action Edge Function) — is needed
 * because, unlike every other action, undoing isn't a step forward from
 * `state`; it's a shorter replay from the start.
 *
 * Keeps walking back past however many consecutive entries were themselves
 * `automatic` (LoggedAction.automatic, ./actions.ts — a forced single-option
 * follow-up the state machine took on its own, see applyAction.ts's
 * fast-forward loops): stepping back past just one would land right back on
 * a forced action that the state machine would instantly re-take, making
 * Undo look like a no-op (issue #131). One call here can therefore append
 * more than one UNDO_ACTION entry — still each an ordinary logged entry, so
 * Redo can step forward through them one at a time same as anything else.
 */
export function applyUndoAction(
  genesis: GameState,
  state: GameState,
  playerId: string | null,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): ActionResult {
  let history = state.actionHistory
  let tip = resolveHistory(history).effective.at(-1)
  if (!tip) {
    return { ok: false, error: 'Nothing left to undo.' }
  }
  do {
    history = [...history, { action: { type: 'UNDO_ACTION' as const, playerId }, turn: state.turn, timestamp: new Date().toISOString() }]
    const undoneWasAutomatic = tip.automatic
    tip = resolveHistory(history).effective.at(-1)
    if (!undoneWasAutomatic) break
  } while (tip)
  return { ok: true, state: replayActions(genesis, history, unitContent, achievementContent, boardGenerationContent, taleContent) }
}

/** Submits one REDO_ACTION against `state` — see applyUndoAction above; the redo mirror of it. */
export function applyRedoAction(
  genesis: GameState,
  state: GameState,
  playerId: string | null,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): ActionResult {
  if (!resolveHistory(state.actionHistory).canRedo) {
    return { ok: false, error: 'Nothing left to redo.' }
  }
  const history = [...state.actionHistory, { action: { type: 'REDO_ACTION' as const, playerId }, turn: state.turn, timestamp: new Date().toISOString() }]
  return { ok: true, state: replayActions(genesis, history, unitContent, achievementContent, boardGenerationContent, taleContent) }
}
