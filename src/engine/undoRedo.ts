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
 * Submits one UNDO_ACTION against `state`, live-style (see applyAction's own
 * doc comment for the "live callers route through here, not a raw history
 * splice" convention this mirrors): appends the entry, then re-derives the
 * whole GameState via replayActions, which knows how to fold it in (see
 * resolveHistory, ./historyFold.ts). `genesis` — reconstructed by the
 * caller, same as every other genesis-needing engine entry point (e.g.
 * GamePage.tsx's handleUndo) — is needed because, unlike every other
 * action, undoing isn't a step forward from `state`; it's a shorter replay
 * from the start.
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
  if (resolveHistory(state.actionHistory).effective.length === 0) {
    return { ok: false, error: 'Nothing left to undo.' }
  }
  const history = [...state.actionHistory, { action: { type: 'UNDO_ACTION' as const, playerId }, turn: state.turn, timestamp: new Date().toISOString() }]
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
