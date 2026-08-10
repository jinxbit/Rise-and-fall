// Row shapes for the Supabase tables (see supabase/migrations/0001_init_schema.sql).
// Deliberately separate from src/engine/types.ts: these describe how a game
// is stored/queried, not the rules-engine's in-memory GameState shape. The
// game_state.state column holds a serialized engine GameState.

import type { PlayMode, GameState as EngineGameState } from '../engine/types'

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
  /** Content id of a pre-made map template (src/content/mapTemplates.json), or null to build the map interactively as usual. */
  map_template_id: string | null
  /** Hotseat only: skip GamePage.tsx's "pass the device" confirmation gate between local players' turns. Set at creation (HomePage.tsx); irrelevant for live/async. */
  skip_hotseat_pass_gate: boolean
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
