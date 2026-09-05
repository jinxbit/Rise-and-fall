import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import type { AchievementContent } from './achievementContent'
import type { Action, LoggedAction } from './actions'
import { applyAction, applyActionAndFastForwardTiles } from './applyAction'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import { resolveHistory } from './historyFold'
import { replayActions } from './replay'
import { EMPTY_TALE_CONTENT } from './taleContent'
import type { TaleContent } from './taleContent'
import type { ActionResult, GameState } from './types'
import { EMPTY_UNIT_CONTENT } from './unitContent'
import type { UnitContent } from './unitContent'

/**
 * Engine-side support for RULE_ENFORCEMENT_PLAN.md §4.4's pointer-based
 * undo/redo: `actionHistory` stays append-only and nothing is ever deleted
 * from it (still true here — this module never mutates or shortens the
 * array a caller passes in), and a separate `historyPointer` int (owned and
 * persisted by the caller — a DB column from phase 4 onward, see §6 — not a
 * GameState field) marks "current" as an index into that history rather
 * than always meaning "the tip". This file has no network/DB dependency of
 * its own; it's the pure engine logic that phase 6's Edge Functions will
 * call once `historyPointer` actually has somewhere to live.
 */

/**
 * The GameState as of `pointer` (0 = genesis, `history.length` = the tip) —
 * just replayActions() over the history prefix up to the pointer, per
 * §4.4's "undo/redo just move the pointer": stepping back is nothing more
 * than replaying fewer entries, exactly like GamePage.tsx's existing
 * (client-local, pre-enforcement) handleUndo already does, only here the
 * pointer isn't required to sit at the array's end.
 */
export function stateAtPointer(
  genesis: GameState,
  history: LoggedAction[],
  pointer: number,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): GameState {
  return replayActions(genesis, history.slice(0, pointer), unitContent, achievementContent, boardGenerationContent, taleContent)
}

/**
 * Clamps a requested pointer move to `[0, history.length]` — the only rule
 * moving the pointer itself needs (§4.4: "undo/redo just move the pointer
 * ... no payload; no per-action legality check applies to moving the
 * pointer itself"). Undo is `clampPointer(historyLength, pointer - 1)`,
 * redo is `clampPointer(historyLength, pointer + 1)`; a review UI jumping
 * straight to an arbitrary index uses this the same way.
 */
export function clampPointer(historyLength: number, requestedPointer: number): number {
  return Math.max(0, Math.min(historyLength, requestedPointer))
}

/**
 * Result of attempting to submit a new action while `pointer` may sit
 * behind the tip. `archivedTail` is the run of previously-logged entries
 * that got pruned to make room for it — empty whenever `result.ok` is
 * false (a rejected action prunes nothing) or the pointer was already at
 * the tip (an ordinary append, nothing to discard). Per §4.4/§6, callers
 * are expected to archive rather than discard this, but archiving itself
 * is storage plumbing outside this pure module's concern.
 */
export interface PointerActionResult {
  result: ActionResult
  archivedTail: LoggedAction[]
}

/**
 * Submits one new action against the state as of `pointer`, per §4.4:
 * "submitting a new action while pointer < tip prunes the abandoned tail
 * ... authorized exactly like any other live action submission: normal
 * apply-action validation ... against the state replayed as of the
 * pointer." Concretely this just means calling the ordinary
 * applyActionAndFastForwardTiles() against `stateAtPointer()` instead of the
 * tip state — since that replayed state's own `actionHistory` is already
 * `history.slice(0, pointer)`, appending its new entries to it *is* "prune
 * the tail and append", with no separate history-splicing step needed.
 */
export function applyActionAtPointer(
  genesis: GameState,
  history: LoggedAction[],
  pointer: number,
  action: Action,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): PointerActionResult {
  const before = stateAtPointer(genesis, history, pointer, unitContent, achievementContent, boardGenerationContent, taleContent)
  const result = applyActionAndFastForwardTiles(before, action, unitContent, achievementContent, boardGenerationContent, taleContent)
  return { result, archivedTail: result.ok ? history.slice(pointer) : [] }
}

/**
 * §4.4's owner-override condition: "if branching would discard at least one
 * action whose playerId differs from the caller's, require the room owner
 * ... to be the one submitting it." A caller only ever rewinding their own
 * still-pending choice (the common case) needs no special permission;
 * pruning someone else's logged action does. Callers compare this against
 * `games.created_by` themselves — this module has no notion of "owner",
 * only of whose actions a branch would discard.
 */
export function branchDiscardsAnotherPlayersAction(history: LoggedAction[], pointer: number, callerPlayerId: string): boolean {
  return history.slice(pointer).some((entry) => entry.action.playerId !== callerPlayerId)
}

/** A simultaneous-phase instance a reveal mark can key on — see §5.3, computeRevealedPhaseMarks below. */
export type RevealablePhase = 'selectCards' | 'decline'

/** The key computeRevealedPhaseMarks' returned Set uses, and redactStateForPlayerAtPointer (./redaction.ts) consults it by. */
export function revealMarkKey(turn: number, phase: RevealablePhase): string {
  return `${turn}:${phase}`
}

/**
 * §5.3's "reveal high-water mark": which (turn, roundPhase) simultaneous-
 * phase instances have actually resolved somewhere in `history` — i.e. a
 * moment existed where every player still owed a pick in that phase
 * finished owing one, whether that happened via the phase's own action
 * (CHOOSE_CARD/MOVE_TO_DECLINE) or an eliminating one (CONCEDE and its
 * cascades, ./elimination.ts) clearing the last pending player some other
 * way. Once true, redaction should stop masking that phase even if a later
 * *review-only* pointer rewind (no branch) replays back into it — see
 * redactStateForPlayerAtPointer.
 *
 * Deliberately a pure function of `history` rather than separately
 * persisted, mutable state: nothing here needs an explicit "delete on
 * branch" step (§5.3 spells out the mark must vanish once the branch that
 * produced it is pruned) because a mark can only ever be present if the
 * resolving entry is still actually in `history` — call this again after a
 * branch with the new (pruned) tip history and a mark whose resolving
 * action got discarded simply doesn't reappear. `genesis`/pointer-shaped
 * inputs mirror stateAtPointer's own signature since both replay the same
 * way; unlike stateAtPointer this always walks the *whole* history (the
 * tip), independent of wherever `historyPointer` currently sits (§5.3:
 * "independent of wherever historyPointer sits afterward").
 */
export function computeRevealedPhaseMarks(
  genesis: GameState,
  history: LoggedAction[],
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): Set<string> {
  const revealed = new Set<string>()
  let state = genesis
  for (const entry of resolveHistory(history).effective) {
    const turnBefore = state.turn
    const phaseBefore = state.roundPhase
    const wasOpen = (phaseBefore === 'selectCards' || phaseBefore === 'decline') && state.pendingPlayerIds.length > 0

    const result = applyAction(state, entry.action, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!result.ok) {
      throw new Error(`computeRevealedPhaseMarks: replay failed at ${JSON.stringify(entry.action)}: ${result.error}`)
    }
    state = result.state

    // A resolution either moves roundPhase on (the ordinary case) or ends
    // the game outright via an elimination cascade mid-phase (status flips
    // to 'completed' before roundPhase would otherwise have changed) —
    // either way, nobody is left with anything of this phase-instance still
    // to hide.
    if (wasOpen && (state.roundPhase !== phaseBefore || state.status !== 'active')) {
      revealed.add(revealMarkKey(turnBefore, phaseBefore as RevealablePhase))
    }
  }
  return revealed
}
