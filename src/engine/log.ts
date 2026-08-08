import type { GameEvent, GameState } from './types'

let eventCounter = 0
function nextEventId(): string {
  eventCounter += 1
  return `evt_${eventCounter}`
}

/** Appends a log entry and returns the new log array; does not mutate state. */
export function appendLog(state: GameState, playerId: string | null, message: string): GameEvent[] {
  const event: GameEvent = {
    id: nextEventId(),
    turn: state.turn,
    playerId,
    message,
    timestamp: new Date().toISOString(),
  }
  return [...state.log, event]
}
