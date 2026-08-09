import type { GameState } from './types'

/**
 * Generates a unique id from a counter carried in `GameState` itself,
 * rather than a module-level variable. The engine runs independently in
 * every player's browser tab — each a separate JS process with its own
 * module state — so a plain in-memory counter restarts at 0 in each one
 * and collides the moment two clients each generate an id off their own
 * copy of the shared state (e.g. two players each creating their first
 * unit both getting `created_unit_1`; a later `destroySelf` transform's
 * `units.filter(u => u.id !== unit.id)` then silently removes *both*
 * units sharing that id, not just the one transforming). Threading the
 * counter through `GameState` keeps id generation part of the same
 * deterministic, synced state every client already agrees on.
 */
export function nextSequenceId(state: GameState, prefix: string): { id: string; idSequence: number } {
  const idSequence = state.idSequence + 1
  return { id: `${prefix}_${idSequence}`, idSequence }
}
