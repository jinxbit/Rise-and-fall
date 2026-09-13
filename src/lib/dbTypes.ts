// Row shapes for the Supabase tables (see supabase/migrations/0001_init_schema.sql).
// Deliberately separate from src/engine/types.ts: these describe how a game
// is stored/queried, not the rules-engine's in-memory GameState shape. The
// game_state.state column holds a serialized engine GameState.

import type { Board, PlayMode, GameState as EngineGameState } from '../engine/types.ts'

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
  /**
   * Opt-in, per-game switch for RULE_ENFORCEMENT_PLAN.md's server-side
   * enforcement (§6/§8 phase 8, decided 2026-09-05): when true, `game_state`
   * writes are rejected by RLS for anyone but the service role, and
   * gameApi.ts routes writes through the `apply-action`/`undo-action`/
   * `redo-action` Edge Functions instead of writing the table directly.
   * Defaults to `false`, and every game that existed before this key was
   * added reads as `false` too (coalesced in the RLS policy) — old games and
   * any caller that omits this are completely unaffected. Set at creation
   * (CreateGamePage.tsx) and never changed afterward — same lifecycle as
   * mapTemplateId etc, just consumed at every write instead of only at
   * genesis time. CreateGamePage.tsx no longer offers a checkbox for this at
   * all (issue #552, superseding issue #432's checked-by-default checkbox)
   * — every game created through the UI is enforced, with no opt-out.
   */
  ruleEnforcementEnabled: boolean
  /**
   * Opt-in switch for HIDDEN_INFORMATION_PLAN.md's redacted read path
   * (§8 phase 8, decided 2026-09-08): when true (and only meaningful
   * alongside `ruleEnforcementEnabled` — a client-trusted game has no
   * server authority to redact from), `gameApi.ts` reads this game's state
   * through the `get-game-state` Edge Function instead of the raw
   * `game_state` row, so a still-secret simultaneous pick
   * (chosenCardIdByPlayerId/declineCardIds mid selectCards/decline) never
   * reaches an opponent's browser at all. Never for hotseat (one shared
   * `auth.uid()` across every local seat makes per-seat masking actively
   * wrong there — see get-game-state/index.ts). Defaults to `false` here,
   * same as ruleEnforcementEnabled, and every game that existed before this
   * key was added reads as `false` too — createGame()'s own default is
   * unchanged. CreateGamePage.tsx no longer offers a checkbox for this at
   * all (issue #552, superseding issue #481's checked-by-default checkbox):
   * since rule enforcement is now always on too, it always passes
   * `hiddenInformationAvailable` (true unless hotseat) — so a game created
   * through the UI hides in-progress picks unless it's hotseat; no existing
   * game's behavior changes.
   */
  hiddenInformationEnabled: boolean
  /**
   * Opt-in switch (issue #529) that closes the one gap
   * RULE_ENFORCEMENT_PLAN.md §4.4's owner-override check left open: a player
   * who was the *last* to pick in a simultaneous `selectCards`/`decline`
   * phase can undo straight back to before their own pick and resubmit a
   * different one — since only their own entry sits in the discarded tail,
   * `requiresOwnerOverride` (supabase/functions/_shared/gameEnforcement.ts)
   * sees no *other* player's action to protect and lets it through, even
   * though that pick already resolved the phase and so was already revealed
   * to everyone (HIDDEN_INFORMATION_PLAN.md §5.3/§5.4, todo.md #86's "a
   * reveal can't be taken back once it happens"). When true, `apply-action`
   * additionally requires the room-owner/admin override (`isOwnerOrAdmin` +
   * `GameState.adminModeActive`) for any branch that would discard a
   * `CHOOSE_CARD`/`MOVE_TO_DECLINE` entry at all, regardless of whose it is —
   * see `requiresOwnerOverride`'s doc comment for why that blanket check is
   * safe: a still-open pick is always retractable without branching at all,
   * via `RETRACT_CHOICE`/`RETRACT_DECLINE` (RULE_ENFORCEMENT_PLAN.md §4.4's
   * refinement), so this only ever affects a pick that already resolved.
   * Only meaningful alongside `hiddenInformationEnabled` (CreateGamePage.tsx
   * only offers the checkbox once that one is available) and never for
   * hotseat (apply-action already skips the whole owner-override check
   * there, issue #486 — one shared `auth.uid()` means there's no second
   * human to protect a reveal from). Defaults to `false` here and every game
   * that existed before this key was added reads as `false` too —
   * createGame()'s default is unaffected. CreateGamePage.tsx's checkbox
   * itself now defaults to checked too (issue #552, superseding issue
   * #529's opt-in default, once the on-by-default rollout of
   * ruleEnforcementEnabled/hiddenInformationEnabled had run without
   * surprises).
   */
  lockRevealedInformationEnabled: boolean
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

/**
 * Slim public projection of `GameStateRow` (`0025_game_state_meta.sql`):
 * status/roundPhase/turn/version/pendingPlayerIds only, kept in sync with
 * `game_state` by a `security definer` trigger on every insert/update —
 * clients never write this table directly. Originally landed for
 * `HIDDEN_INFORMATION_PLAN.md`'s future redaction work, but also the cheap
 * source gameApi.ts's `fetchGameStateSummaries` reads for listing screens
 * (issue #441) so they never need to download/decompress the full `state`
 * blob just to show a game's phase/round/last-updated/turn-highlighting.
 */
export interface GameStateMetaRow {
  game_id: string
  status: string
  round_phase: string | null
  turn: number
  version: number
  /** See `0027_game_state_meta_pending_players.sql`'s column comment for exactly what this holds per phase. */
  pending_player_ids: string[]
  /** Mirrors `game_state.active_player_id` — see `0028_hidden_information_rls_lockdown.sql`'s column comment. Never hidden information. */
  active_player_id: string | null
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

/**
 * Simple per-account preferences that don't warrant their own column — a
 * single JSONB column (profiles.preferences, 0023_unit_reserve_display.sql),
 * mirroring GameSettings/games.settings above: add a key here (and thread it
 * through gameApi.ts's getProfilePreferences/saveProfilePreferences) instead
 * of a migration + dedicated column whenever a new simple profile preference
 * is needed.
 */
export interface ProfilePreferences {
  /** How PlayersStrip's per-kind unit badge (RoundView.tsx) reports a player's unit supply (issue #346) — see src/lib/unitReserveDisplay.ts. Absent means "use the default" (remaining). */
  unitReserveDisplay?: string
  /**
   * Whether, when this player's pick would be the one that resolves the
   * select-cards or decline phase (the last entry leaving `pendingPlayerIds`)
   * and so reveal every player's simultaneous choice, RoundView.tsx should
   * stage that pick locally behind a "Reveal all cards" button instead of
   * submitting it the instant they click a card (issue #528) — see
   * src/lib/cardRevealConfirmation.ts. Absent means "use the default" (on).
   */
  confirmBeforeRevealingCards?: boolean
}

/**
 * Site-wide config singleton (0031_chat_messages.sql) — currently just the
 * chat kill switch. `id` is always `true`; there is exactly one row.
 */
export interface AppConfigRow {
  id: true
  /** CHAT_PLAN.md §4: gates chat_messages' RLS policies. No client can write this column — see that migration's table comment. */
  chat_enabled: boolean
}

/**
 * One chat message (0031_chat_messages.sql, CHAT_PLAN.md §3) — site-wide
 * (`game_id` null) or scoped to one game. Append-only: no edit/soft-delete
 * support yet. Sender identity is looked up via `profiles`/`useDisplayName`
 * like everywhere else in the app, not denormalized onto this row.
 */
export interface ChatMessageRow {
  id: number
  game_id: string | null
  sender_id: string
  body: string
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
  /**
   * Per-account unit-plate colour overrides (issue #311 follow-up, see
   * 0022_unit_plate_colors.sql and src/lib/unitColors.ts) — null means "use
   * the default" for that state. `unit_color_hand`: a card sitting untouched
   * in hand. `unit_color_selected`: the card chosen to play this round.
   * `unit_color_discard`: already played this round (or otherwise sitting in
   * discard).
   */
  unit_color_hand: string | null
  unit_color_selected: string | null
  unit_color_discard: string | null
  /** Simple per-account preferences — see ProfilePreferences above. */
  preferences: ProfilePreferences
  updated_at: string
}
