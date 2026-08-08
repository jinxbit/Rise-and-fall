import { UNIT_KINDS } from './cards'
import type { GameState } from './types'

/**
 * Placeholder per-kind unit limit, per player — the user's own example
 * ("let's say the limit is 2") while real numbers are pending. Should
 * eventually read from src/content/units.json's `supply.byPlayerCount`
 * once that's filled in (see content/README.md).
 */
const PLACEHOLDER_UNIT_LIMIT = 2

export function getUnitLimit(_kind: string): number {
  return PLACEHOLDER_UNIT_LIMIT
}

function countUnitsOfKind(state: GameState, playerId: string, kind: string): number {
  return state.units.filter((u) => u.ownerId === playerId && u.kind === kind).length
}

/**
 * Rules 1 & 2: true once any player has reached their per-kind unit limit.
 * Computed live from the current board rather than tracked as a sticky
 * flag — equivalent to edge-triggering at the moment a limit is reached,
 * since nothing removes units mid-round yet, but avoids a flag that future
 * unit-creation code would have to remember to set.
 */
export function isDeclineTriggered(state: GameState): boolean {
  return state.players.some((player) =>
    UNIT_KINDS.some((kind) => countUnitsOfKind(state, player.id, kind) >= getUnitLimit(kind)),
  )
}
