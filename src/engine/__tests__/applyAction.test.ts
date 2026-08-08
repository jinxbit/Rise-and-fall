import { beforeEach, describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard } from '../board'
import { createNewGame, startGame } from '../createGame'
import type { GameState } from '../types'

function makeActiveGame(): GameState {
  const lobby = createNewGame({
    gameId: 'game_1',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
    ],
  })

  return startGame(lobby, {
    p1: { q: 0, r: 0 },
    p2: { q: 5, r: 0 },
  })
}

describe('createNewGame / startGame', () => {
  it('starts in lobby status with no units', () => {
    const lobby = createNewGame({
      gameId: 'game_1',
      playMode: 'live',
      board: createEmptyBoard('hex'),
      players: [{ id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' }],
    })
    expect(lobby.status).toBe('lobby')
    expect(lobby.units).toHaveLength(0)
  })

  it('places a settlement, mobile unit, and ship per player on start', () => {
    const state = makeActiveGame()
    expect(state.status).toBe('active')
    expect(state.units).toHaveLength(6)
    expect(state.units.filter((u) => u.ownerId === 'p1')).toHaveLength(3)
    expect(state.activePlayerId).toBe('p1')
  })
})

describe('applyAction', () => {
  let state: GameState

  beforeEach(() => {
    state = makeActiveGame()
  })

  it('rejects actions from a player who is not active', () => {
    const result = applyAction(state, { type: 'END_TURN', playerId: 'p2' })
    expect(result.ok).toBe(false)
  })

  it('advances the active player on END_TURN', () => {
    const result = applyAction(state, { type: 'END_TURN', playerId: 'p1' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.state.activePlayerId).toBe('p2')
      expect(result.state.turn).toBe(0)
    }
  })

  it('increments the turn counter after a full round', () => {
    const afterP1 = applyAction(state, { type: 'END_TURN', playerId: 'p1' })
    expect(afterP1.ok).toBe(true)
    if (!afterP1.ok) return

    const afterP2 = applyAction(afterP1.state, { type: 'END_TURN', playerId: 'p2' })
    expect(afterP2.ok).toBe(true)
    if (!afterP2.ok) return

    expect(afterP2.state.activePlayerId).toBe('p1')
    expect(afterP2.state.turn).toBe(1)
  })

  it('logs an event for each successful action', () => {
    const logLengthBefore = state.log.length
    const result = applyAction(state, { type: 'END_TURN', playerId: 'p1' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.state.log).toHaveLength(logLengthBefore + 1)
    }
  })

  it('does not mutate the input state', () => {
    const snapshot = JSON.stringify(state)
    applyAction(state, { type: 'END_TURN', playerId: 'p1' })
    expect(JSON.stringify(state)).toBe(snapshot)
  })

  it('returns NOT_IMPLEMENTED for actions not yet built', () => {
    const result = applyAction(state, { type: 'MOVE_UNIT', playerId: 'p1', unitId: 'unit_1', to: { q: 1, r: 0 } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('NOT_IMPLEMENTED')
    }
  })

  it('rejects actions when the game is not active', () => {
    const lobbyState: GameState = { ...state, status: 'lobby' }
    const result = applyAction(lobbyState, { type: 'END_TURN', playerId: 'p1' })
    expect(result.ok).toBe(false)
  })
})
