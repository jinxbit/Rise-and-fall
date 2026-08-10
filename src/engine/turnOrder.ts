import { currentTilePlacerId, currentUnitPlacerId } from './boardSetup'
import type { GameState } from './types'

/**
 * Whichever seated player must act next, across every game status — not
 * just during the round cycle (`pendingPlayerIds[0]`, valid for every
 * `active`-status phase: selectCards/actions/decline/purchase alike, since
 * `pendingPlayerIds` is that phase's own queue regardless of whether it's
 * simultaneous or turn-order) but also board setup's separate tile/unit
 * placement turn order (see ./boardSetup.ts). Used by hotseat pass-and-play
 * (GamePage.tsx) to know who to hand the shared device to next; `null` once
 * there's genuinely nobody pending (status: 'lobby'/'completed').
 */
export function currentActorId(state: GameState): string | null {
  if (state.status === 'boardSetup') return currentTilePlacerId(state) ?? currentUnitPlacerId(state)
  if (state.status === 'active') return state.pendingPlayerIds[0] ?? state.activePlayerId ?? null
  return null
}
