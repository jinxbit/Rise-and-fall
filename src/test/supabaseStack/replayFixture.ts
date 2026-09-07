// Replays a whole game's logged action history against the stack, submitting
// each entry the way production submits that kind of entry: a substantive
// action to apply-action, an UNDO_ACTION/REDO_ACTION marker to
// undo-action/redo-action (those move a pointer, they aren't a step forward —
// see UndoAction's doc comment in src/engine/actions.ts), each as the
// signed-in user who holds the seat that made it.
//
// Shared by ./…/__tests__/productionGames.test.ts, which points it at real
// exported games, and by ./…/__tests__/supabaseStack.test.ts, which points it
// at a game it just played — so the replay path itself stays covered in CI
// even before any production export is checked in.

import type { GameState } from '../../engine/types.ts'
import type { ProductionGameFixture } from '../fixtures/productionGames/loadFixtures.ts'
import { stripTimestamps } from '../fixtures/productionGames/loadFixtures.ts'
import type { EnforcedCallResult, ProductionStack } from './index.ts'

export type LoggedEntry = GameState['actionHistory'][number]

export function submitLoggedEntry(stack: ProductionStack, fixture: ProductionGameFixture, entry: LoggedEntry): Promise<EnforcedCallResult> {
  // UNDO_ACTION/REDO_ACTION/SET_ADMIN_MODE carry a nullable, narration-only
  // playerId (see their doc comments in src/engine/actions.ts) — a null one
  // means nobody in particular was "acting", so the room owner stands in,
  // which is also the only caller SET_ADMIN_MODE would have accepted.
  const userId = entry.action.playerId === null ? fixture.game.created_by : fixture.userIdForPlayer(entry.action.playerId)
  if (entry.action.type === 'UNDO_ACTION') return stack.undoAction(userId, fixture.game.id)
  if (entry.action.type === 'REDO_ACTION') return stack.redoAction(userId, fixture.game.id)
  return stack.applyAction(userId, fixture.game.id, entry.action)
}

/**
 * Submits every entry in order, failing with the action's position and the
 * server's own message the moment one is rejected — which is the useful half
 * of a failure here: "action 143/210, RESOLVE_UNIT_ACTION by seat-2, 400: ..."
 * localizes a rules or enforcement regression to one move of one real game.
 * Returns the `game_state.version` the row should be on afterwards.
 */
export async function replayFixtureThroughStack(stack: ProductionStack, fixture: ProductionGameFixture): Promise<number> {
  const history = fixture.finalState.actionHistory
  let version = 0
  for (const [index, entry] of history.entries()) {
    const result = await submitLoggedEntry(stack, fixture, entry)
    if (!result.ok) {
      throw new Error(
        `[${fixture.name}] action ${index + 1}/${history.length} (${entry.action.type} by ${entry.action.playerId}) was rejected with ${result.status}: ${result.error}`,
      )
    }
    version += 1
    if (result.version !== version) {
      throw new Error(`[${fixture.name}] action ${index + 1}/${history.length} left game_state at version ${result.version}, expected ${version}.`)
    }
  }
  return version
}

/**
 * Two states compared as *games*, not as bytes.
 *
 * `timestamp` is wall-clock, so it never survives a replay. An
 * UNDO_ACTION/REDO_ACTION entry's `playerId` is narration only — the server
 * stamps it from whoever called, and in a hotseat game several seats share one
 * auth user, so a replay can legitimately attribute a marker to a different
 * seat than production did (see UndoAction's doc comment). Everything else,
 * including every substantive entry and its order, has to match exactly.
 */
export function normalizeForComparison(state: GameState): GameState {
  return stripTimestamps({
    ...state,
    actionHistory: state.actionHistory.map((entry) =>
      entry.action.type === 'UNDO_ACTION' || entry.action.type === 'REDO_ACTION'
        ? { ...entry, action: { ...entry.action, playerId: '(caller)' } }
        : entry,
    ),
  })
}
