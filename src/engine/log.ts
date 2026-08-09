import type { GameEvent, GameState } from './types'

/**
 * Appends a log entry and returns the new log array; does not mutate state.
 * The id is derived from the log's own current length rather than a
 * module-level counter — the log is append-only (see GameEvent's doc
 * comment) and every call site always passes the just-updated state, so
 * `state.log.length` is already a deterministic, collision-free sequence;
 * a counter local to this module would instead restart at 0 in every
 * player's separate browser tab and collide across clients (see
 * idSequence.ts, which fixes the same class of bug for unit ids).
 */
export function appendLog(state: GameState, playerId: string | null, message: string): GameEvent[] {
  const event: GameEvent = {
    id: `evt_${state.log.length + 1}`,
    turn: state.turn,
    playerId,
    message,
    timestamp: new Date().toISOString(),
  }
  return [...state.log, event]
}
