import { describe, expect, it } from 'vitest'
import type { GameState } from '../../engine/types'
import { shouldRetractOwnChoice, shouldRetractOwnDecline } from '../undoDecision'

function stateWith(roundPhase: GameState['roundPhase'], chosenCardIdByPlayerId: GameState['chosenCardIdByPlayerId']) {
  return { roundPhase, chosenCardIdByPlayerId }
}

function declineStateWith(
  roundPhase: GameState['roundPhase'],
  players: { id: string; declineCardIds: string[] }[],
  declineSourceZoneByCardId?: GameState['declineSourceZoneByCardId'],
) {
  return { roundPhase, players, declineSourceZoneByCardId }
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

describe('shouldRetractOwnDecline (issue #505)', () => {
  it("is true once the caller has an addition standing from this phase, even if another player has since acted (nothing here depends on turn order)", () => {
    const state = declineStateWith(
      'decline',
      [
        { id: 'p1', declineCardIds: ['card-1'] },
        { id: 'p2', declineCardIds: ['card-2'] },
      ],
      { 'card-1': 'hand', 'card-2': 'hand' },
    )
    expect(shouldRetractOwnDecline(state, 'p1')).toBe(true)
  })

  it('is false for a player with nothing declined this phase', () => {
    const state = declineStateWith('decline', [{ id: 'p1', declineCardIds: [] }], {})
    expect(shouldRetractOwnDecline(state, 'p1')).toBe(false)
  })

  it("is false for a card sitting in decline from an earlier, already-resolved round — declineSourceZoneByCardId has no entry for it", () => {
    const state = declineStateWith('decline', [{ id: 'p1', declineCardIds: ['old-card'] }], {})
    expect(shouldRetractOwnDecline(state, 'p1')).toBe(false)
  })

  it('is false outside the decline phase, even if the source-zone map lingers', () => {
    const state = declineStateWith('purchase', [{ id: 'p1', declineCardIds: ['card-1'] }], { 'card-1': 'hand' })
    expect(shouldRetractOwnDecline(state, 'p1')).toBe(false)
  })

  it('is false with no caller id', () => {
    const state = declineStateWith('decline', [{ id: 'p1', declineCardIds: ['card-1'] }], { 'card-1': 'hand' })
    expect(shouldRetractOwnDecline(state, null)).toBe(false)
    expect(shouldRetractOwnDecline(state, undefined)).toBe(false)
  })

  it('is true regardless of how many of the caller\'s own cards are standing — the caller retracts all of them in one action either way', () => {
    const state = declineStateWith('decline', [{ id: 'p1', declineCardIds: ['card-1', 'card-2'] }], { 'card-1': 'hand', 'card-2': 'discard' })
    expect(shouldRetractOwnDecline(state, 'p1')).toBe(true)
  })
})
