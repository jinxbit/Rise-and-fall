// Pure view logic for the "My games" screen (MyGamesPage.tsx). Split out
// from gameApi.ts's listMyGames (which pulls in the live Supabase client at
// import time, same reason as seatIndex.ts) so turn/finished classification
// and sorting can be unit tested without a real project config.

import { pendingActorIds as pendingActorIdsForState } from '../engine/turnOrder'
import type { GameState as EngineGameState } from '../engine/types'
import type { GameRow, PlayerRow } from './dbTypes'

/**
 * One game the current user is seated in, plus everything the list/detail
 * view needs to render it. `gameState` is null while the game is still in
 * the lobby (no game_state row exists until LobbyPage starts it). `myPlayerIds`
 * is usually a single id, but a hotseat host can hold several seats in the
 * same game (see gameApi.ts's addLocalPlayer) under one user_id.
 */
export interface MyGameEntry {
  game: GameRow
  players: PlayerRow[]
  gameState: EngineGameState | null
  myPlayerIds: string[]
}

/**
 * The status that actually matters for this screen. games.status (the DB
 * row) only ever tracks 'lobby' -> 'active' (-> 'canceled') — 'boardSetup'
 * and 'completed' live exclusively in game_state.state.status (see
 * dbTypes.ts's GameRow comment and GamePage.tsx's status checks), so a
 * finished game still shows games.status: 'active' unless we look at
 * gameState instead. 'canceled' is the one value that *is* authoritative on
 * games.status — it's checked first, ahead of gameState.
 */
export type MyGameStatus = 'lobby' | 'boardSetup' | 'active' | 'completed' | 'canceled'

export function myGameStatus(entry: MyGameEntry): MyGameStatus {
  if (entry.game.status === 'canceled') return 'canceled'
  return entry.gameState?.status ?? 'lobby'
}

export function isFinished(entry: MyGameEntry): boolean {
  return myGameStatus(entry) === 'completed'
}

export function isCanceled(entry: MyGameEntry): boolean {
  return myGameStatus(entry) === 'canceled'
}

/** The seated players who must act next, or `[]` if nobody's turn is pending (lobby/completed). */
export function pendingActorIds(entry: MyGameEntry): string[] {
  return entry.gameState ? pendingActorIdsForState(entry.gameState) : []
}

/** True if any of the current user's seats is one of the players pendingActorIds() says must act next. */
export function isMyTurn(entry: MyGameEntry): boolean {
  const pending = pendingActorIds(entry)
  return entry.myPlayerIds.some((id) => pending.includes(id))
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

/**
 * Splits into active/finished/canceled and sorts each: active games where
 * it's the user's turn float to the top (then most-recently-updated first);
 * finished and canceled games are each most-recently-updated first.
 */
export function groupMyGames(
  entries: MyGameEntry[],
): { active: MyGameEntry[]; finished: MyGameEntry[]; canceled: MyGameEntry[] } {
  const active = entries.filter((entry) => !isFinished(entry) && !isCanceled(entry))
  const finished = entries.filter((entry) => isFinished(entry))
  const canceled = entries.filter((entry) => isCanceled(entry))

  const byUpdatedDesc = (a: MyGameEntry, b: MyGameEntry) =>
    new Date(b.game.updated_at).getTime() - new Date(a.game.updated_at).getTime()

  active.sort((a, b) => Number(isMyTurn(b)) - Number(isMyTurn(a)) || byUpdatedDesc(a, b))
  finished.sort(byUpdatedDesc)
  canceled.sort(byUpdatedDesc)

  return { active, finished, canceled }
}
