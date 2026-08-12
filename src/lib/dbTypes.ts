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

export interface GameRow {
  id: string
  room_code: string
  play_mode: PlayMode
  status: 'lobby' | 'active' | 'completed'
  min_players: number
  max_players: number
  created_by: string
  created_at: string
  updated_at: string
  settings: GameSettings
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
