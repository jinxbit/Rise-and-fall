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
 * Submits one UNDO_ACTION entry against `state`, live-style (see
 * applyAction's own doc comment for the "live callers route through here,
 * not a raw history splice" convention this mirrors): appends an entry, then
 * re-derives the whole GameState via replayActions, which knows how to fold
 * it in (see resolveHistory, ./historyFold.ts). `genesis` — reconstructed by
 * the caller, same as every other genesis-needing engine entry point (e.g.
 * GamePage.tsx's handleUndo, the undo-action Edge Function) — is needed
 * because, unlike every other action, undoing isn't a step forward from
 * `state`; it's a shorter replay from the start.
 *
 * One call here always reverts exactly the tip's own actionHistory entry —
 * per jinxbit's 2026-09-05 design update (RULE_ENFORCEMENT_PLAN.md
 * §4.2/§4.3), a forced single-option follow-up (a one-card hand's
 * CHOOSE_CARD, a tile placement with only one legal arrangement left) is
 * folded into the SAME entry as whatever triggered it rather than getting
 * one of its own (see applyAction.ts), so there's nothing left to walk back
 * past here (issue #131's original fix, since superseded): undoing that one
 * entry naturally reverts the triggering action and everything it forced in
 * one step.
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
  if (!resolveHistory(state.actionHistory).effective.at(-1)) {
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
