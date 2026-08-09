import { UNIT_KINDS } from './cards'
import type { GameState } from './types'

/**
 * Per-kind unit limit, per player (rules 1 & 2 of decline) — reads
 * `state.unitLimits`, set once at game creation from content/units.json's
 * `supply.byPlayerCount` (same value across every player count — 8 Cities,
 * 3 Temples, 8 Nomads, 6 Merchants, 3 Mountaineers, 5 Ships — see
 * createNewGame's `unitLimits` param). A kind missing from the map has no
 * limit (never triggers decline on its own).
 */
export function getUnitLimit(state: GameState, kind: string): number {
  return state.unitLimits[kind] ?? Infinity
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
    UNIT_KINDS.some((kind) => countUnitsOfKind(state, player.id, kind) >= getUnitLimit(state, kind)),
  )
}
