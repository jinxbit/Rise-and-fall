import type { LoggedAction } from './actions.ts'
import type { GameState } from './types.ts'

/**
 * The result of folding UNDO_ACTION/REDO_ACTION entries out of a raw
 * `actionHistory` (design change, issue #412 — see UndoAction's doc comment
 * in ./actions.ts for why undo/redo are logged entries rather than a
 * client-local truncation/redo-stack): `effective` is the substantive
 * (non-undo/redo) prefix currently "in effect" — what GameState is actually
 * derived from — and `canRedo` says whether there's a next one available to
 * step back into.
 */
export interface ResolvedHistory {
  /**
   * Every entry currently "in effect", in order — replay this (not the raw
   * history) to get the current GameState. This is the substantive
   * (non-undo/redo) prefix the pointer currently keeps, plus (issue #545)
   * every `SET_ADMIN_MODE` entry unconditionally — see walkHistory's doc
   * comment for why admin-mode toggles are never subject to the pointer at
   * all, so they're always included here regardless of where it sits.
   */
  effective: LoggedAction[]
  /** Whether UNDO_ACTION has any gameplay entry left to revert (issue #545: a `SET_ADMIN_MODE` entry never counts, even when it's the only thing logged so far). */
  canUndo: boolean
  /** Whether REDO_ACTION has anything left to advance into. */
  canRedo: boolean
}

/**
 * Walks raw `history` once, maintaining an implicit "pointer" into the
 * substantive (gameplay) actions seen so far: each UNDO_ACTION moves it back
 * one (never below 0), each REDO_ACTION moves it forward one (never past
 * however many substantive actions have been seen), and every other
 * gameplay action either extends the substantive list (pointer already at
 * its tip — the ordinary case) or branches (pointer behind the tip: the
 * un-redone tail beyond it is abandoned, same as today's "submitting a new
 * action after an undo drops the redo option" behavior) — either way the new
 * action becomes the substantive list's tip and the pointer advances onto
 * it. Branched-away entries stay in `history` (nothing is ever deleted — see
 * UndoAction's doc comment), simply no longer reachable by REDO_ACTION once
 * superseded.
 *
 * `SET_ADMIN_MODE` (issue #545) never joins `substantive` and never moves
 * `pointer` — it's not a gameplay step, so it's never the thing a bare Undo
 * reverts and never sits in a discarded/un-redone tail either. Before this,
 * whenever it happened to be the tip (the common case: switch it on, then
 * immediately Undo to reach for the override it was meant to unlock), a bare
 * Undo reverted the toggle itself instead of ever reaching the real action
 * underneath it, silently switching admin mode back off. It can still carry
 * a folded-in forced follow-up cascade of its own, exactly like any other
 * action (RULE_ENFORCEMENT_PLAN.md §4.2/§4.3, applyAction.ts) — replaying it
 * is still required for correctness — so resolveHistory below keeps every
 * `SET_ADMIN_MODE` entry in `.effective` unconditionally instead of dropping
 * it, rather than excluding it from replay entirely.
 *
 * Shared by resolveHistory and redoableTail below — both need the same walk,
 * just different slices of its result.
 */
function walkHistory(history: LoggedAction[]): { substantive: LoggedAction[]; pointer: number } {
  const substantive: LoggedAction[] = []
  let pointer = 0
  for (const entry of history) {
    if (entry.action.type === 'UNDO_ACTION') {
      pointer = Math.max(0, pointer - 1)
    } else if (entry.action.type === 'REDO_ACTION') {
      pointer = Math.min(substantive.length, pointer + 1)
    } else if (entry.action.type === 'SET_ADMIN_MODE') {
      // Excluded from the pointer walk entirely — see this function's own doc comment.
    } else {
      substantive.length = pointer // no-op at the tip; drops the un-redone tail otherwise
      substantive.push(entry)
      pointer += 1
    }
  }
  return { substantive, pointer }
}

/**
 * This is deliberately the primary place that interprets UNDO_ACTION/
 * REDO_ACTION — every other engine function that used to walk
 * `actionHistory` directly (replayActions, gameLog's narration,
 * scoreHistory/unitValue's whole-game replays) now either delegates to this
 * (replayActions) or pre-filters through `.effective` (the ones that only
 * ever care about "what's actually in effect now", not per-entry narration).
 */
export function resolveHistory(history: LoggedAction[]): ResolvedHistory {
  const { substantive, pointer } = walkHistory(history)
  const keptGameplay = new Set(substantive.slice(0, pointer))
  const effective = history.filter((entry) => entry.action.type === 'SET_ADMIN_MODE' || keptGameplay.has(entry))
  return { effective, canUndo: pointer > 0, canRedo: pointer < substantive.length }
}

/**
 * The substantive entries currently sitting behind the tip — i.e. exactly
 * what a fresh substantive action submitted right now would push out of
 * `resolveHistory(...).effective` and out of REDO_ACTION's reach (see
 * `walkHistory`'s branching case above). RULE_ENFORCEMENT_PLAN.md §4.4's
 * owner-override check (`apply-action`, phase 6) uses this to decide whether
 * a live submission needs the room-owner/admin carve-out: empty whenever
 * `resolveHistory(history).canRedo` is false, since there's nothing behind
 * the tip to discard. Never contains a `SET_ADMIN_MODE` entry (issue #545):
 * it's never part of `substantive` to begin with, so branching past one
 * never counts as discarding "someone else's action" the way discarding a
 * real gameplay entry would.
 */
export function redoableTail(history: LoggedAction[]): LoggedAction[] {
  const { substantive, pointer } = walkHistory(history)
  return substantive.slice(pointer)
}

/**
 * Whether a plain UNDO_ACTION against `state` right now would revert a
 * CHOOSE_CARD/MOVE_TO_DECLINE that has already resolved its simultaneous
 * phase (selectCards/decline respectively) — i.e. put an already-revealed
 * pick back under wraps rather than merely retract a still-open one.
 *
 * The last non-`SET_ADMIN_MODE` entry in `resolveHistory(...).effective` is
 * exactly the entry a bare Undo reverts next (see resolveHistory's own doc
 * comment — a `SET_ADMIN_MODE` entry is always present regardless of the
 * undo/redo pointer, issue #545, so it's never itself what Undo reverts even
 * when it's the last entry in raw order), and CLAUDE.md invariant 4
 * guarantees that if this entry's own submission emptied `pendingPlayerIds`
 * and advanced the round, that transition was folded into this same entry
 * rather than a separate one — so `state.roundPhase` having already moved
 * past the phase this entry belongs to means this specific entry is what
 * closed it, not some later one.
 *
 * Issue #534: closes the undo-side half of the gap
 * `GameSettings.lockRevealedInformationEnabled` (issue #529) already closes
 * on resubmission — see requiresOwnerOverride's doc comment
 * (supabase/functions/_shared/gameEnforcement.ts). Without this, undo alone
 * already reopens the phase (re-masking everyone's now-"unrevealed" pick,
 * HIDDEN_INFORMATION_PLAN.md §5.3), and it was the *next* action attempt
 * that then got rejected instead — leaving the game stuck mid-reveal with
 * no visible way forward. Callers combine this with
 * `lockRevealedInformationEnabled` themselves (this function doesn't know
 * about that setting) and with whatever owner-override carve-out they use
 * for `requiresOwnerOverride` — see undo-action/index.ts and GamePage.tsx's
 * Undo button.
 */
export function undoWouldReopenRevealedPick(state: Pick<GameState, 'actionHistory' | 'roundPhase'>): boolean {
  const effective = resolveHistory(state.actionHistory).effective
  let tip: LoggedAction | undefined
  for (let i = effective.length - 1; i >= 0; i--) {
    if (effective[i].action.type !== 'SET_ADMIN_MODE') {
      tip = effective[i]
      break
    }
  }
  if (!tip) return false
  if (tip.action.type === 'CHOOSE_CARD') return state.roundPhase !== 'selectCards'
  if (tip.action.type === 'MOVE_TO_DECLINE') return state.roundPhase !== 'decline'
  return false
}
