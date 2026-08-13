// Row shapes for the Supabase tables (see supabase/migrations/0001_init_schema.sql).
// Deliberately separate from src/engine/types.ts: these describe how a game
// is stored/queried, not the rules-engine's in-memory GameState shape. The
// game_state.state column holds a serialized engine GameState.

import type { PlayMode, GameState as EngineGameState } from '../engine/types'

/**
 * Per-game, creation-time configuration — a single JSONB column
 * (games.settings, see 0007_game_settings.sql) instead of one column per
 * setting, so a new pregame toggle doesn't need its own migration. Only
 * meaningful up through the lobby: set at creation (HomePage.tsx), read by
 * LobbyPage.tsx's summary and buildGenesisState. Once a game is actually
 * running, GamePage.tsx reads the equivalent settings off GameState
 * instead (GameState.activeTaleIds/gameLength — see their own doc
 * comments), not this column.
 */
export interface GameSettings {
  /** Content id of a pre-made map template (src/content/mapTemplates.json), or null to build the map interactively as usual. */
  mapTemplateId: string | null
  /** Hotseat only: skip GamePage.tsx's "pass the device" confirmation gate between local players' turns. Irrelevant for live/async. */
  skipHotseatPassGate: boolean
  /** Content ids of active Tales (src/content/tales.json). Empty = Tales variant off. */
  activeTaleIds: string[]
  /** Total achievements claimed (across all players) that ends the game. content/achievements.json's gameLength.min/max bounds it (1-6). */
  gameLength: number
}

/**
 * `status` only ever tracks the transitions this DB row can actually see
 * (see 0008_room_lifecycle.sql's trigger): 'lobby' -> 'active' -> 'canceled'
 * or 'lobby' -> 'canceled'. It never becomes 'completed' — a finished game
 * still reads 'active' here; that's tracked separately in
 * `game_state.state.status` instead (see GameStateRow, myGamesView.ts).
 * 'completed' is kept as an allowed DB value for forward compatibility only.
 * Only the room's Owner (`created_by`) may update or delete this row.
 */
export interface GameRow {
  id: string
  room_code: string
  play_mode: PlayMode
  status: 'lobby' | 'active' | 'completed' | 'canceled'
  min_players: number
  max_players: number
  created_by: string
  created_at: string
  updated_at: string
  settings: GameSettings
  /** Bumped by 0009_config_versioning.sql's trigger every time `settings` changes while the room is still in the lobby. Compare against a PlayerRow's `ready_for_version` to know if that player has acknowledged the current config (see roomReadiness.ts). */
  config_version: number
  /**
   * 'private' (default) rooms are reachable only via room code/link, same as
   * every room before this column existed. 'public' rooms additionally show
   * up on the Public Rooms screen (0011_room_visibility.sql, issue #40
   * sections 4-5, see publicRoomsView.ts). Owner-only to change.
   */
  visibility: 'public' | 'private'
}

export interface PlayerRow {
  id: string
  game_id: string
  user_id: string
  display_name: string
  avatar_url: string | null
  seat_index: number
  color: string
  is_active: boolean
  joined_at: string
  /** The GameRow.config_version this player last confirmed Ready for (0009_config_versioning.sql). Set automatically to the game's current config_version on insert; only changes afterward via markReady in gameApi.ts. */
  ready_for_version: number
}

/**
 * An Observer watching a game — view-only, does not occupy a player seat
 * (0010_observers.sql, see issue #40 section 6). Deliberately not a
 * `PlayerRow`: not counted toward min/max players, not part of readiness.
 */
export interface ObserverRow {
  id: string
  game_id: string
  user_id: string
  display_name: string
  avatar_url: string | null
  joined_at: string
}

export interface GameStateRow {
  game_id: string
  state: EngineGameState
  turn: number
  active_player_id: string | null
  version: number
  updated_at: string
}

/** Per-account settings — see supabase/migrations/0005_discord_webhooks.sql. */
export interface ProfileRow {
  user_id: string
  discord_webhook_url: string | null
  updated_at: string
}
