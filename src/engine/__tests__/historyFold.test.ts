import { describe, expect, it } from 'vitest'
import type { ChooseCardAction, LoggedAction, MoveToDeclineAction } from '../actions'
import { redoableTail, resolveHistory, undoWouldReopenRevealedPick } from '../historyFold'
import type { GameState } from '../types'

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
  it('with no undo/redo entries, effective is the whole history and redo is unavailable', () => {
    const history = [entry('a'), entry('b')]
    expect(resolveHistory(history)).toEqual({ effective: history, canRedo: false })
  })

  it('one UNDO_ACTION drops the last substantive entry from effective, and makes it redoable', () => {
    const a = entry('a')
    const b = entry('b')
    const resolved = resolveHistory([a, b, undo()])
    expect(resolved.effective).toEqual([a])
    expect(resolved.canRedo).toBe(true)
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

describe('redoableTail (RULE_ENFORCEMENT_PLAN.md §4.4 owner-override support)', () => {
  it('is empty with no undo/redo entries', () => {
    expect(redoableTail([entry('a'), entry('b')])).toEqual([])
  })

  it('is empty once canRedo is false', () => {
    expect(redoableTail([entry('a'), entry('b'), undo(), redo()])).toEqual([])
  })

  it('holds exactly the entries an undo left behind the tip', () => {
    const b = entry('b')
    expect(redoableTail([entry('a'), b, undo()])).toEqual([b])
  })

  it('holds every entry from a multi-undo rewind, in order', () => {
    const b = entry('b')
    const c = entry('c')
    expect(redoableTail([entry('a'), b, c, undo(), undo()])).toEqual([b, c])
  })

  it('is empty again once a branch has already superseded the abandoned tail', () => {
    // Same history as historyFold.test.ts's own branching case above: after
    // [a, b, undo(), c], c is the new tip and there's nothing left to redo.
    expect(redoableTail([entry('a'), entry('b'), undo(), entry('c')])).toEqual([])
  })
})

describe('undoWouldReopenRevealedPick (RULE_ENFORCEMENT_PLAN.md §4.4/issue #534)', () => {
  function chooseCard(playerId: string, cardId = 'card-1'): LoggedAction {
    return { action: { type: 'CHOOSE_CARD', playerId, cardId } as ChooseCardAction, turn: 0, timestamp: '' }
  }
  function moveToDecline(playerId: string, cardId = 'card-1'): LoggedAction {
    return { action: { type: 'MOVE_TO_DECLINE', playerId, cardId } as MoveToDeclineAction, turn: 0, timestamp: '' }
  }
  function stateWith(actionHistory: LoggedAction[], roundPhase: GameState['roundPhase']): Pick<GameState, 'actionHistory' | 'roundPhase'> {
    return { actionHistory, roundPhase }
  }

  it('is false with nothing to undo', () => {
    expect(undoWouldReopenRevealedPick(stateWith([], 'selectCards'))).toBe(false)
  })

  it('is false when the tip is a still-open CHOOSE_CARD (the phase never resolved)', () => {
    // Bob picked first; Alice is still pending — roundPhase stays selectCards.
    const history = [chooseCard('bob')]
    expect(undoWouldReopenRevealedPick(stateWith(history, 'selectCards'))).toBe(false)
  })

  it('is true when the tip is the CHOOSE_CARD that resolved selectCards (roundPhase already moved on)', () => {
    const history = [chooseCard('bob'), chooseCard('alice')]
    expect(undoWouldReopenRevealedPick(stateWith(history, 'actions'))).toBe(true)
  })

  it('is false once that resolving CHOOSE_CARD has itself already been undone', () => {
    const history = [chooseCard('bob'), chooseCard('alice'), undo()]
    // Effective tip is now bob's still-open pick — undoing further doesn't reopen anything already resolved.
    expect(undoWouldReopenRevealedPick(stateWith(history, 'selectCards'))).toBe(false)
  })

  it('is true when the tip is the MOVE_TO_DECLINE that resolved the decline phase', () => {
    const history = [moveToDecline('bob'), moveToDecline('alice')]
    expect(undoWouldReopenRevealedPick(stateWith(history, 'purchase'))).toBe(true)
  })

  it('is false when the tip is a still-open MOVE_TO_DECLINE', () => {
    const history = [moveToDecline('bob')]
    expect(undoWouldReopenRevealedPick(stateWith(history, 'decline'))).toBe(false)
  })

  it('is false for a tip entry that is neither CHOOSE_CARD nor MOVE_TO_DECLINE', () => {
    const history = [entry('alice')]
    expect(undoWouldReopenRevealedPick(stateWith(history, 'actions'))).toBe(false)
  })
})
