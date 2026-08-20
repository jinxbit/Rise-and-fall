// Shared view logic for game overview cards, used by every screen that lists
// games (MyGamesPage.tsx, HomePage.tsx, PublicRoomsPage.tsx) — turn
// highlighting and "time ago" labels live here so each screen computes them
// the same way. myGamesView.ts and publicRoomsView.ts wrap these with their
// own entry types.

import { pendingActorIds as pendingActorIdsForState } from '../engine/turnOrder'
import type { GameState as EngineGameState } from '../engine/types'

/** The seated players who must act next, or `[]` if nobody's turn is pending (lobby/completed). */
export function pendingActorIdsFor(gameState: EngineGameState | null): string[] {
  return gameState ? pendingActorIdsForState(gameState) : []
}

/** True if any of `myPlayerIds` is one of the players pendingActorIdsFor() says must act next. */
export function isMyTurnFor(gameState: EngineGameState | null, myPlayerIds: string[]): boolean {
  const pending = pendingActorIdsFor(gameState)
  return myPlayerIds.some((id) => pending.includes(id))
}

/**
 * Short "time ago" label for a game's games.updated_at. `now` is injectable
 * for tests; defaults to the real current time.
 */
export function formatUpdatedAt(isoTimestamp: string, now: Date = new Date()): string {
  const updated = new Date(isoTimestamp)
  const diffMinutes = Math.round((now.getTime() - updated.getTime()) / 60_000)

  if (diffMinutes < 1) return 'Updated just now'
  if (diffMinutes < 60) return `Updated ${diffMinutes}m ago`
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `Updated ${diffHours}h ago`
  const diffDays = Math.round(diffHours / 24)
  if (diffDays < 7) return `Updated ${diffDays}d ago`
  return `Updated ${updated.toLocaleDateString()}`
}
