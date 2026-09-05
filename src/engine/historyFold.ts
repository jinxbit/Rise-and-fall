import type { LoggedAction } from './actions.ts'

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
  /** Substantive actions currently in effect, in order — replay this (not the raw history) to get the current GameState. */
  effective: LoggedAction[]
  /** Whether REDO_ACTION has anything left to advance into. */
  canRedo: boolean
}

/**
 * Walks raw `history` once, maintaining an implicit "pointer" into the
 * substantive actions seen so far: each UNDO_ACTION moves it back one (never
 * below 0), each REDO_ACTION moves it forward one (never past however many
 * substantive actions have been seen), and every other action either
 * extends the substantive list (pointer already at its tip — the ordinary
 * case) or branches (pointer behind the tip: the un-redone tail beyond it is
 * abandoned, same as today's "submitting a new action after an undo drops
 * the redo option" behavior) — either way the new action becomes the
 * substantive list's tip and the pointer advances onto it. Branched-away
 * entries stay in `history` (nothing is ever deleted — see UndoAction's doc
 * comment), simply no longer reachable by REDO_ACTION once superseded.
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
  return { effective: substantive.slice(0, pointer), canRedo: pointer < substantive.length }
}

/**
 * The substantive entries currently sitting behind the tip — i.e. exactly
 * what a fresh substantive action submitted right now would push out of
 * `resolveHistory(...).effective` and out of REDO_ACTION's reach (see
 * `walkHistory`'s branching case above). RULE_ENFORCEMENT_PLAN.md §4.4's
 * owner-override check (`apply-action`, phase 6) uses this to decide whether
 * a live submission needs the room-owner/admin carve-out: empty whenever
 * `resolveHistory(history).canRedo` is false, since there's nothing behind
 * the tip to discard.
 */
export function redoableTail(history: LoggedAction[]): LoggedAction[] {
  const { substantive, pointer } = walkHistory(history)
  return substantive.slice(pointer)
}
