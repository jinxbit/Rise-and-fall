import { describe, expect, it } from 'vitest'
import { createEmptyBoard } from '../board'
import { createNewGame } from '../createGame'
import { isDeclineTriggered } from '../decline'
import type { GameState } from '../types'

function makeGame(achievementsClaimedThisRound: number): GameState {
  const state = createNewGame({
    gameId: 'g1',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
    ],
  })
  return { ...state, status: 'active', achievementsClaimedThisRound }
}

describe('isDeclineTriggered', () => {
  it('is false when no achievement was claimed this round', () => {
    expect(isDeclineTriggered(makeGame(0))).toBe(false)
  })

  it('is true once at least one achievement was claimed this round', () => {
    expect(isDeclineTriggered(makeGame(1))).toBe(true)
  })

  it('is true for more than one achievement claimed the same round', () => {
    expect(isDeclineTriggered(makeGame(2))).toBe(true)
  })
})
