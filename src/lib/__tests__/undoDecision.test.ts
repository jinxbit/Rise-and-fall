import { describe, expect, it } from 'vitest'
import type { GameState } from '../../engine/types'
import { shouldRetractOwnChoice } from '../undoDecision'

function stateWith(roundPhase: GameState['roundPhase'], chosenCardIdByPlayerId: GameState['chosenCardIdByPlayerId']) {
  return { roundPhase, chosenCardIdByPlayerId }
}

describe('shouldRetractOwnChoice', () => {
  it('is true once the caller has chosen their own card and the phase is still open (issue #503)', () => {
    // p1 chose, p2 hasn't yet — p1's Undo must not touch p2's still-pending pick.
    const state = stateWith('selectCards', { p1: 'card-1', p2: null })
    expect(shouldRetractOwnChoice(state, 'p1')).toBe(true)
  })

  it('is false for a player who has not chosen yet this phase', () => {
    const state = stateWith('selectCards', { p1: 'card-1', p2: null })
    expect(shouldRetractOwnChoice(state, 'p2')).toBe(false)
  })

  it('is false once the phase has resolved, even if the map entry lingers', () => {
    const state = stateWith('actions', { p1: 'card-1', p2: 'card-2' })
    expect(shouldRetractOwnChoice(state, 'p1')).toBe(false)
  })

  it('is false outside selectCards (e.g. decline/purchase)', () => {
    expect(shouldRetractOwnChoice(stateWith('decline', { p1: 'card-1' }), 'p1')).toBe(false)
    expect(shouldRetractOwnChoice(stateWith('purchase', { p1: 'card-1' }), 'p1')).toBe(false)
  })

  it('is false with no caller id', () => {
    const state = stateWith('selectCards', { p1: 'card-1' })
    expect(shouldRetractOwnChoice(state, null)).toBe(false)
    expect(shouldRetractOwnChoice(state, undefined)).toBe(false)
  })
})
