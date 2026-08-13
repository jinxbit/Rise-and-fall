// Pure view logic for the "My games" screen (MyGamesPage.tsx). Split out
// from gameApi.ts's listMyGames (which pulls in the live Supabase client at
// import time, same reason as seatIndex.ts) so turn/finished classification
// and sorting can be unit tested without a real project config.

import { pendingActorIds } from '../engine/turnOrder'
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
 * row) only ever tracks 'lobby' -> 'active' — 'boardSetup' and 'completed'
 * live exclusively in game_state.state.status (see dbTypes.ts's GameRow
 * comment and GamePage.tsx's status checks), so a finished game still shows
 * games.status: 'active' unless we look at gameState instead.
 */
export type MyGameStatus = 'lobby' | 'boardSetup' | 'active' | 'completed'

export function myGameStatus(entry: MyGameEntry): MyGameStatus {
  return entry.gameState?.status ?? 'lobby'
}

export function isFinished(entry: MyGameEntry): boolean {
  return myGameStatus(entry) === 'completed'
}

/** True if any of the current user's seats is one of the players pendingActorIds() says must act next. */
export function isMyTurn(entry: MyGameEntry): boolean {
  if (!entry.gameState) return false
  const pending = pendingActorIds(entry.gameState)
  return entry.myPlayerIds.some((id) => pending.includes(id))
}

/**
 * Splits into active/finished and sorts each: active games where it's the
 * user's turn float to the top (then most-recently-updated first), finished
 * games are most-recently-updated first.
 */
export function groupMyGames(entries: MyGameEntry[]): { active: MyGameEntry[]; finished: MyGameEntry[] } {
  const active = entries.filter((entry) => !isFinished(entry))
  const finished = entries.filter((entry) => isFinished(entry))

  const byUpdatedDesc = (a: MyGameEntry, b: MyGameEntry) =>
    new Date(b.game.updated_at).getTime() - new Date(a.game.updated_at).getTime()

  active.sort((a, b) => Number(isMyTurn(b)) - Number(isMyTurn(a)) || byUpdatedDesc(a, b))
  finished.sort(byUpdatedDesc)

  return { active, finished }
}
