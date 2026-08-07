import type { Action } from './actions'
import type { GameEvent, GameState } from './types'

export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string }

let eventCounter = 0
function nextEventId(): string {
  eventCounter += 1
  return `evt_${eventCounter}`
}

function appendLog(state: GameState, playerId: string | null, message: string): GameEvent[] {
  const event: GameEvent = {
    id: nextEventId(),
    turn: state.turn,
    playerId,
    message,
    timestamp: new Date().toISOString(),
  }
  return [...state.log, event]
}

/**
 * Applies a single validated action to a game state, returning a new state.
 * Never mutates the input. This is the ONLY place game rules are allowed to
 * run — UI and network layers must treat GameState as opaque and always
 * route changes through here so every client (live/async/hotseat) enforces
 * identical rules.
 */
export function applyAction(state: GameState, action: Action): ActionResult {
  if (state.status !== 'active') {
    return { ok: false, error: `Game is not active (status: ${state.status})` }
  }

  switch (action.type) {
    case 'END_TURN':
      return applyEndTurn(state, action.playerId)
    case 'MOVE_UNIT':
      return { ok: false, error: 'NOT_IMPLEMENTED: MOVE_UNIT' }
    case 'PLAY_CARD':
      return { ok: false, error: 'NOT_IMPLEMENTED: PLAY_CARD' }
    default: {
      const exhaustive: never = action
      return { ok: false, error: `Unknown action: ${JSON.stringify(exhaustive)}` }
    }
  }
}

function applyEndTurn(state: GameState, playerId: string): ActionResult {
  if (state.activePlayerId !== playerId) {
    return { ok: false, error: 'It is not this player\'s turn' }
  }
  if (state.turnOrder.length === 0) {
    return { ok: false, error: 'Game has no turn order configured' }
  }

  const currentIndex = state.turnOrder.indexOf(playerId)
  const nextIndex = (currentIndex + 1) % state.turnOrder.length
  const nextPlayerId = state.turnOrder[nextIndex]
  const wrapped = nextIndex === 0

  const nextState: GameState = {
    ...state,
    turn: wrapped ? state.turn + 1 : state.turn,
    activePlayerId: nextPlayerId,
  }

  return {
    ok: true,
    state: { ...nextState, log: appendLog(nextState, playerId, `Player ${playerId} ended their turn`) },
  }
}
