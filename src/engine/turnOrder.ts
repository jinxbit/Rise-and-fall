import { currentTilePlacerId, currentUnitPlacerId } from './boardSetup'
import type { GameState } from './types'

/**
 * Every seated player who must still act before this phase can move on —
 * across every game status. Board setup's tile/unit placement (see
 * ./boardSetup.ts) only ever has one placer at a time, but `active`-status
 * phases can be genuinely simultaneous (selectCards/decline have everyone
 * in `pendingPlayerIds` at once, not just the head of the queue) — so this
 * returns the full set, not just "who's first". Used to diff "who newly
 * needs to act" across a state transition for async turn notifications
 * (GamePage.tsx). `[]` once there's nobody pending (status:
 * 'lobby'/'completed').
 */
export function pendingActorIds(state: GameState): string[] {
  if (state.status === 'boardSetup') {
    const id = currentTilePlacerId(state) ?? currentUnitPlacerId(state)
    return id ? [id] : []
  }
  if (state.status === 'active') {
    if (state.pendingPlayerIds.length > 0) return state.pendingPlayerIds
    return state.activePlayerId ? [state.activePlayerId] : []
  }
  return []
}

/**
 * Whichever seated player must act next — the head of pendingActorIds().
 * Used by hotseat pass-and-play (GamePage.tsx) to know who to hand the
 * shared device to next; `null` once there's genuinely nobody pending.
 */
export function currentActorId(state: GameState): string | null {
  return pendingActorIds(state)[0] ?? null
}
