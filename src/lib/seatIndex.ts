import type { PlayerRow } from './dbTypes'

/**
 * Lowest seat_index not already taken. Split out from gameApi.ts (which
 * pulls in the live Supabase client at import time, so it can't be unit
 * tested without a real project config) purely so this one calculation can
 * be tested in isolation. `existingPlayers.length` alone isn't enough once
 * a seat can be removed (hotseat's addLocalPlayer/removePlayer in
 * gameApi.ts), since seat indices are then no longer guaranteed contiguous.
 */
export function nextSeatIndex(existingPlayers: PlayerRow[]): number {
  return existingPlayers.reduce((max, p) => Math.max(max, p.seat_index), -1) + 1
}
