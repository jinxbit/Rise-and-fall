// Pure view logic for the Public Rooms screen (PublicRoomsPage.tsx) — issue
// #40 sections 4 (Room Visibility) and 5 (Public Rooms Screen). Split out
// from gameApi.ts's listPublicRooms the same way myGamesView.ts is split
// from listMyGames, so grouping/status classification can be unit tested
// without a real Supabase project.

import type { GameState as EngineGameState } from '../engine/types'
import type { GameRow, PlayerRow } from './dbTypes'

/**
 * One publicly-listed room, plus everything the list view needs to render
 * it. `gameState` is null while the room is still in the lobby, same as
 * MyGameEntry (see myGamesView.ts). listPublicRooms() (gameApi.ts) already
 * excludes canceled rooms — issue section 5: "Canceled and Deleted rooms do
 * not appear in the listing" — so unlike MyGameEntry there's no canceled
 * case to classify here.
 */
export interface PublicRoomEntry {
  game: GameRow
  players: PlayerRow[]
  gameState: EngineGameState | null
}

/**
 * The three buckets the Public Rooms screen groups by (issue section 5).
 * games.status can't tell "In Progress" from "Finished" apart on its own
 * (see dbTypes.ts's GameRow comment) — that distinction only exists once a
 * game_state row exists, via `gameState.status`.
 */
export type PublicRoomBucket = 'notStarted' | 'inProgress' | 'finished'

export function publicRoomBucket(entry: PublicRoomEntry): PublicRoomBucket {
  if (entry.game.status === 'lobby') return 'notStarted'
  return entry.gameState?.status === 'completed' ? 'finished' : 'inProgress'
}

/** Joinable per issue section 4: Active and Not Started, with a free seat. */
export function isJoinable(entry: PublicRoomEntry): boolean {
  return publicRoomBucket(entry) === 'notStarted' && entry.players.length < entry.game.max_players
}

/** Observable per issue section 4: Active and In Progress. */
export function isObservable(entry: PublicRoomEntry): boolean {
  return publicRoomBucket(entry) === 'inProgress'
}

/**
 * Buckets rooms for display, each most-recently-updated first — matching
 * the order the issue's section 5 lists the three groups in.
 */
export function groupPublicRooms(
  entries: PublicRoomEntry[],
): { notStarted: PublicRoomEntry[]; inProgress: PublicRoomEntry[]; finished: PublicRoomEntry[] } {
  const byUpdatedDesc = (a: PublicRoomEntry, b: PublicRoomEntry) =>
    new Date(b.game.updated_at).getTime() - new Date(a.game.updated_at).getTime()

  const notStarted = entries.filter((entry) => publicRoomBucket(entry) === 'notStarted').sort(byUpdatedDesc)
  const inProgress = entries.filter((entry) => publicRoomBucket(entry) === 'inProgress').sort(byUpdatedDesc)
  const finished = entries.filter((entry) => publicRoomBucket(entry) === 'finished').sort(byUpdatedDesc)

  return { notStarted, inProgress, finished }
}
