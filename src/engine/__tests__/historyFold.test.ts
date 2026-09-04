import { describe, expect, it } from 'vitest'
import type { LoggedAction } from '../actions'
import { resolveHistory } from '../historyFold'

/** A minimal substantive (non-undo/redo) logged entry — CONCEDE's payload is just `playerId`, so distinct ids are enough to tell entries apart by identity/deep-equality. */
function entry(playerId: string): LoggedAction {
  return { action: { type: 'CONCEDE', playerId }, turn: 0, timestamp: '' }
}
function undo(playerId: string | null = null): LoggedAction {
  return { action: { type: 'UNDO_ACTION', playerId }, turn: 0, timestamp: '' }
}
function redo(playerId: string | null = null): LoggedAction {
  return { action: { type: 'REDO_ACTION', playerId }, turn: 0, timestamp: '' }
}

describe('resolveHistory', () => {
  it('with no undo/redo entries, effective and substantive are both the whole history and redo is unavailable', () => {
    const history = [entry('a'), entry('b')]
    expect(resolveHistory(history)).toEqual({ effective: history, canRedo: false, substantive: history })
  })

  it('one UNDO_ACTION drops the last substantive entry from effective, and makes it redoable, but leaves substantive untouched', () => {
    const a = entry('a')
    const b = entry('b')
    const resolved = resolveHistory([a, b, undo()])
    expect(resolved.effective).toEqual([a])
    expect(resolved.canRedo).toBe(true)
    // Unlike `effective`, `substantive` isn't pointer-truncated — a plain
    // undo only moves the pointer, so `b` is still reachable (via REDO_ACTION)
    // and still present here. This is what lets computeRevealedPhaseMarks
    // (./historyPointer.ts) keep §5.3's reveal high-water mark sticky across
    // a real undo instead of losing it the moment the pointer moves behind
    // the resolving entry.
    expect(resolved.substantive).toEqual([a, b])
  })

  it('REDO_ACTION restores the undone entry', () => {
    const a = entry('a')
    const b = entry('b')
    const resolved = resolveHistory([a, b, undo(), redo()])
    expect(resolved.effective).toEqual([a, b])
    expect(resolved.canRedo).toBe(false)
  })

  it('UNDO_ACTION never rewinds past an empty effective history', () => {
    const resolved = resolveHistory([entry('a'), undo(), undo(), undo()])
    expect(resolved.effective).toEqual([])
    expect(resolved.canRedo).toBe(true)
  })

  it('REDO_ACTION never advances past however many substantive actions have actually been seen', () => {
    const a = entry('a')
    const resolved = resolveHistory([a, undo(), redo(), redo(), redo()])
    expect(resolved.effective).toEqual([a])
    expect(resolved.canRedo).toBe(false)
  })

  it('a new substantive action submitted behind the tip branches: the un-redone tail is abandoned but stays in the raw history', () => {
    const a = entry('a')
    const b = entry('b')
    const c = entry('c')
    const history = [a, b, undo(), c]
    const resolved = resolveHistory(history)
    expect(resolved.effective).toEqual([a, c])
    expect(resolved.canRedo).toBe(false)
    expect(history).toContain(b) // nothing was ever deleted
    // Unlike a plain undo, an actual branch (a new substantive action
    // submitted behind the tip) DOES shrink `substantive` — `b` is no
    // longer reachable at all, by REDO_ACTION or otherwise.
    expect(resolved.substantive).toEqual([a, c])
  })

  it('branching after multiple undos only abandons what the pointer had rewound past', () => {
    const a = entry('a')
    const d = entry('d')
    // Undo twice (back down to just [a]), then submit a new action — the two
    // entries the pointer had rewound past are abandoned, not everything.
    const resolved = resolveHistory([a, entry('b'), entry('c'), undo(), undo(), d])
    expect(resolved.effective).toEqual([a, d])
  })

  it('a redo right after a branch has nothing to advance into', () => {
    const a = entry('a')
    const d = entry('d')
    const resolved = resolveHistory([a, entry('b'), undo(), d])
    expect(resolved.effective).toEqual([a, d])
    expect(resolved.canRedo).toBe(false)
  })
})
