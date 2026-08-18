// Reads/writes for the map pool (0016_map_pool.sql) — player-saved maps,
// categorized by player count, built via MapBuilderPage.tsx and later
// picked up at random by CreateGamePage/LobbyPage's MapModeSelector to
// skip interactive board setup (see GameSettings.mapPoolBoard).

import { canonicalizeBoard } from '../engine/board'
import { supabase } from './supabase'
import type { MapPoolRow } from './dbTypes'
import type { Board } from '../engine/types'

const UNIQUE_VIOLATION = '23505'

/**
 * Saves `board` to the pool under `playerCount`. Rejects an exact
 * duplicate — same terrain layout already saved for that player count
 * (0016_map_pool.sql's `unique (player_count, board_key)`) — with a
 * friendly error instead of the raw Postgres one, per issue #23's "the
 * same map should not be allowed to be saved more than once".
 */
export async function saveMapToPool(params: { board: Board; playerCount: number; userId: string }): Promise<MapPoolRow> {
  const boardKey = canonicalizeBoard(params.board)
  const { data, error } = await supabase
    .from('map_pool')
    .insert({ board: params.board, board_key: boardKey, player_count: params.playerCount, created_by: params.userId })
    .select()
    .single()

  if (error) {
    if (error.code === UNIQUE_VIOLATION) throw new Error('This exact map has already been saved to the pool.')
    throw error
  }
  return data as MapPoolRow
}

export async function listMapPoolByPlayerCount(playerCount: number): Promise<MapPoolRow[]> {
  const { data, error } = await supabase
    .from('map_pool')
    .select()
    .eq('player_count', playerCount)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as MapPoolRow[]
}

/**
 * Every saved map, across all player counts — for the admin maps screen
 * (issue #185), which browses/deletes the whole pool rather than one
 * player-count bucket at a time. Small-scale like listMyGames/
 * listPublicRooms, so callers paginate client-side (lib/pagination.ts)
 * rather than this taking offset/limit params.
 */
export async function listAllMapPool(): Promise<MapPoolRow[]> {
  const { data, error } = await supabase.from('map_pool').select().order('created_at', { ascending: false })
  if (error) throw error
  return data as MapPoolRow[]
}

/**
 * Removes a map from the pool (issue #185). Only an admin's delete
 * succeeds — 0016_map_pool.sql grants no owner-delete policy, and
 * 0018_admin_delete_map_pool.sql's is the only delete policy on this
 * table — so a non-admin's call resolves with no matching row and no
 * error (Postgres RLS silently filters rows the policy doesn't grant).
 */
export async function deleteMapFromPool(mapId: string): Promise<void> {
  const { error } = await supabase.from('map_pool').delete().eq('id', mapId)
  if (error) throw error
}

/**
 * One random saved map for `playerCount`, or null if the pool has none
 * yet. Used once, at game creation/lobby-edit time, to lock in a concrete
 * board — see GameSettings.mapPoolBoard's doc comment for why the
 * *result* of this pick is what gets embedded, rather than re-rolling on
 * every genesis rebuild.
 */
export async function pickRandomMapFromPool(playerCount: number): Promise<MapPoolRow | null> {
  const maps = await listMapPoolByPlayerCount(playerCount)
  if (maps.length === 0) return null
  return maps[Math.floor(Math.random() * maps.length)]
}
