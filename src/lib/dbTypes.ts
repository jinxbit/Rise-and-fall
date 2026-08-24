// Row shapes for the Supabase tables (see supabase/migrations/0001_init_schema.sql).
// Deliberately separate from src/engine/types.ts: these describe how a game
// is stored/queried, not the rules-engine's in-memory GameState shape. The
// game_state.state column holds a serialized engine GameState.

import type { Board, PlayMode, GameState as EngineGameState } from '../engine/types'

/**
 * Per-game, creation-time configuration — a single JSONB column
 * (games.settings, see 0007_game_settings.sql) instead of one column per
 * setting, so a new pregame toggle doesn't need its own migration. Only
 * meaningful up through the lobby: set at creation (CreateGamePage.tsx), read by
 * LobbyPage.tsx's summary and buildGenesisState. Once a game is actually
 * running, GamePage.tsx reads the equivalent settings off GameState
 * instead (GameState.activeTaleIds/gameLength — see their own doc
 * comments), not this column.
 */
export interface GameSettings {
  /** Content id of a pre-made map template (src/content/mapTemplates.json), or null to build the map interactively as usual. */
  mapTemplateId: string | null
  /**
   * A concrete board (terrain layout only) resolved from a random
   * `map_pool` row (0016_map_pool.sql) at creation/lobby-edit time — see
   * MapModeSelector.tsx — or null to not use one. Embedded directly here
   * rather than just an id so buildGenesisState stays a synchronous,
   * deterministic function of this row alone (see its doc comment) —
   * same reasoning as mapTemplateId, just resolved from the DB instead of
   * static content, at the moment it's chosen rather than every time
   * genesis is rebuilt. Treated as mutually exclusive with mapTemplateId
   * by the UI; if both are somehow set, buildGenesisState prefers
   * mapTemplateId.
   */
  mapPoolBoard: Board | null
  /** Which map_pool row mapPoolBoard came from, for display only — never read by buildGenesisState. */
  mapPoolMapId: string | null
  /**
   * "Truly random" map mode (issue #166): don't lock in a `mapPoolBoard` yet —
   * instead, LobbyPage.tsx's handleStart() picks a random map_pool row
   * matching the *actual* seated player count once the host starts the
   * game, then persists the result into mapPoolBoard/mapPoolMapId (so
   * buildGenesisState stays a synchronous function of this row alone — see
   * mapPoolBoard's doc comment). If no saved map fits that count, the game
   * falls back to interactive board building, same as no map source at
   * all. Mutually exclusive with mapTemplateId/mapPoolBoard in the UI;
   * ignored by buildGenesisState once mapPoolBoard is set (the pick has
   * already happened).
   */
  mapPoolRandomAtStart: boolean
  /**
   * "Build alone" map mode (issue #243): one player places every tile
   * interactively when the game starts, instead of every seated player
   * taking turns — see engine/types.ts's BoardSetupState.builderId.
   * Starting *unit* placement still always follows the normal per-player
   * turnOrder rotation either way — soloBuilderUnitOrder below only
   * controls where the builder's own turn falls *within* that rotation,
   * it doesn't hand unit placement to the builder. Mutually exclusive with
   * mapTemplateId/mapPoolBoard/mapPoolRandomAtStart in the UI, same as the
   * other map-source modes.
   */
  soloBuildMap: boolean
  /**
   * Who builds when soloBuildMap is on: the room creator ('owner', the
   * default), or a random seated player ('random'). 'random' needs real
   * randomness that buildGenesisState can't perform itself and stay a
   * deterministic function of the game row (see its own doc comment) —
   * LobbyPage.tsx's handleStart() resolves it once via gameGenesis.ts's
   * resolveSoloBuildMap and persists the result into soloBuilderId below,
   * mirroring mapPoolRandomAtStart's resolve-then-persist pattern.
   */
  soloBuilderSelection: 'owner' | 'random'
  /**
   * Resolved once by resolveSoloBuildMap when soloBuilderSelection is
   * 'random' (see its own doc comment) — the actual player id who builds.
   * Null until resolved, and always ignored when soloBuilderSelection is
   * 'owner' (buildGenesisState resolves the creator's id directly and
   * deterministically in that case instead, no persistence needed).
   */
  soloBuilderId: string | null
  /**
   * Where the builder's own starting-unit-placement turn falls within the
   * normal per-player rotation once tile-building is done: forced to go
   * last ('last', the default), or left to fall wherever a randomized turn
   * order happens to put it ('random') — see soloBuilderTurnOrder below
   * for the latter's same resolve-once-and-persist reasoning as
   * soloBuilderId.
   */
  soloBuilderUnitOrder: 'last' | 'random'
  /**
   * Resolved once by resolveSoloBuildMap when soloBuilderUnitOrder is
   * 'random' — the actual turn order (a shuffled permutation of every
   * seated player's id) that GameState.turnOrder is seeded with. Null
   * until resolved, and always ignored when soloBuilderUnitOrder is 'last'
   * (buildGenesisState computes that ordering deterministically itself:
   * seat order with the builder moved to the end).
   */
  soloBuilderTurnOrder: string[] | null
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
  /** Owner-chosen at creation (CreateGamePage.tsx); immutable afterward — enforced server-side by 0012_room_name.sql's trigger. */
  name: string
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

export interface GameStateRow {
  game_id: string
  state: EngineGameState
  turn: number
  active_player_id: string | null
  version: number
  updated_at: string
}

/** A saved map in the pool (0016_map_pool.sql) — see src/lib/mapPoolApi.ts. */
export interface MapPoolRow {
  id: string
  player_count: number
  board: Board
  board_key: string
  created_by: string
  created_at: string
}

/** A browser/device's Web Push subscription (0020_push_subscriptions.sql) — see src/lib/pushNotify.ts. */
export interface PushSubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  created_at: string
}

/** Per-account settings — see supabase/migrations/0005_discord_webhooks.sql. */
export interface ProfileRow {
  user_id: string
  discord_webhook_url: string | null
  /** Custom display name, overriding the Discord-derived one — see 0015_profile_display_name.sql. Null means "use the Discord name" (src/lib/displayName.ts). */
  display_name: string | null
  /** Grants the room-lifecycle "delete any game" override (0017_admin_delete_any_game.sql) — nothing in the UI sets this, it's assigned directly via SQL. */
  is_admin: boolean
  updated_at: string
}
