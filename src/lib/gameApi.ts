import { supabase } from './supabase'
import { nextSeatIndex } from './seatIndex'
import type { GameRow, GameSettings, GameStateRow, PlayerRow, PushSubscriptionRow } from './dbTypes'
import type { MyGameEntry } from './myGamesView'
import type { PublicRoomEntry } from './publicRoomsView'
import type { UnitPlateColorOverrides } from './unitColors'
import { resolveUnitReserveDisplayMode, type UnitReserveDisplayMode } from './unitReserveDisplay'
import type { Board, GameState as EngineGameState, PlayMode } from '../engine/types'

/**
 * Reads a user's Discord webhook URL (supabase/migrations/0005_discord_webhooks.sql).
 * Used both for a player loading their own settings and for a co-player's
 * client looking up who to notify when it becomes their turn — RLS allows
 * both (own row, or a row belonging to someone seated in a shared game).
 * `null` covers both "no profile row yet" and "profile row with no webhook set".
 */
export async function getDiscordWebhookUrl(userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('profiles').select('discord_webhook_url').eq('user_id', userId).maybeSingle()
  if (error) throw error
  return data?.discord_webhook_url ?? null
}

export async function saveDiscordWebhookUrl(userId: string, webhookUrl: string | null): Promise<void> {
  const { error } = await supabase.from('profiles').upsert({ user_id: userId, discord_webhook_url: webhookUrl })
  if (error) throw error
}

/**
 * Web Push subscriptions saved for this user (0020_push_subscriptions.sql) —
 * used by src/lib/pushNotify.ts to know whether the *current* browser
 * already has one, so PushNotificationSettings.tsx can show on/off state.
 */
export async function getPushSubscriptions(userId: string): Promise<PushSubscriptionRow[]> {
  const { data, error } = await supabase.from('push_subscriptions').select('*').eq('user_id', userId)
  if (error) throw error
  return data ?? []
}

export async function savePushSubscription(userId: string, subscription: PushSubscriptionJSON): Promise<void> {
  if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
    throw new Error('Incomplete push subscription')
  }
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    { onConflict: 'endpoint' },
  )
  if (error) throw error
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
  if (error) throw error
}

/**
 * Reads a user's custom display name (0015_profile_display_name.sql), if
 * they've set one — `null` covers both "no profile row yet" and "profile
 * row with no custom name set", both of which mean "fall back to the
 * Discord name" (see resolveDisplayName in lib/displayName.ts).
 */
export async function getProfileDisplayName(userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('profiles').select('display_name').eq('user_id', userId).maybeSingle()
  if (error) throw error
  return data?.display_name ?? null
}

export async function saveProfileDisplayName(userId: string, displayName: string | null): Promise<void> {
  const { error } = await supabase.from('profiles').upsert({ user_id: userId, display_name: displayName })
  if (error) throw error
}

/**
 * Reads a user's unit-plate colour overrides (0022_unit_plate_colors.sql),
 * for whichever of the 3 card-zone states they've customized — each `null`
 * (including "no profile row yet") means "use the default" (see
 * resolveUnitPlateColors in lib/unitColors.ts).
 */
export async function getProfileUnitColors(userId: string): Promise<UnitPlateColorOverrides> {
  const { data, error } = await supabase
    .from('profiles')
    .select('unit_color_hand, unit_color_selected, unit_color_discard')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return {
    hand: data?.unit_color_hand ?? null,
    selected: data?.unit_color_selected ?? null,
    discard: data?.unit_color_discard ?? null,
  }
}

export async function saveProfileUnitColors(userId: string, colors: UnitPlateColorOverrides): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .upsert({ user_id: userId, unit_color_hand: colors.hand, unit_color_selected: colors.selected, unit_color_discard: colors.discard })
  if (error) throw error
}

/**
 * Reads a user's unit reserve display preference
 * (0023_unit_reserve_display.sql) — `null` (including "no profile row yet")
 * resolves to the default ('remaining'), same null-collapsing pattern as
 * getProfileDisplayName.
 */
export async function getProfileUnitReserveDisplay(userId: string): Promise<UnitReserveDisplayMode> {
  const { data, error } = await supabase.from('profiles').select('unit_reserve_display').eq('user_id', userId).maybeSingle()
  if (error) throw error
  return resolveUnitReserveDisplayMode(data?.unit_reserve_display)
}

export async function saveProfileUnitReserveDisplay(userId: string, mode: UnitReserveDisplayMode): Promise<void> {
  const { error } = await supabase.from('profiles').upsert({ user_id: userId, unit_reserve_display: mode })
  if (error) throw error
}

/**
 * Whether this user holds the "delete any game" override (issue #177,
 * 0017_admin_delete_any_game.sql) — `false` covers both "no profile row
 * yet" and "profile row with the flag unset", same null-collapsing pattern
 * as getProfileDisplayName. There's no UI to set this; it's assigned
 * directly via SQL, so this is read-only.
 */
export async function getIsAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('profiles').select('is_admin').eq('user_id', userId).maybeSingle()
  if (error) throw error
  return data?.is_admin ?? false
}

const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#06b6d4', '#ec4899']
/** One color per seat (PLAYER_COLORS above), so this is also the hard ceiling on max_players — used by LobbyPage.tsx's config editor to bound the input. */
export const MAX_PLAYERS = PLAYER_COLORS.length
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I

export function generateRoomCode(length = 5): string {
  let code = ''
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
  }
  return code
}

export async function createGame(params: {
  /** Owner-chosen room name, immutable after creation (see dbTypes.ts's GameRow.name). Trimmed and length-checked here to match 0012_room_name.sql's constraint; the DB is the source of truth. */
  name: string
  playMode: PlayMode
  userId: string
  displayName: string
  avatarUrl: string | null
  minPlayers?: number
  maxPlayers?: number
  /** Content id of a pre-made map template (src/content/mapTemplates.json) to skip interactive tile placement, or null/omitted for the usual interactive setup. */
  mapTemplateId?: string | null
  /** A board resolved from a randomly-picked map_pool row (see MapModeSelector.tsx), or null/omitted for the usual interactive setup. Mutually exclusive with mapTemplateId in the UI. */
  mapPoolBoard?: Board | null
  /** Which map_pool row mapPoolBoard came from, for display only. */
  mapPoolMapId?: string | null
  /** "Truly random" map mode — pick a saved map at actual game start instead of now (see GameSettings.mapPoolRandomAtStart). Mutually exclusive with mapTemplateId/mapPoolBoard in the UI. Defaults to false when omitted. */
  mapPoolRandomAtStart?: boolean
  /** "Build alone" map mode — one player places every tile interactively when the game starts (see GameSettings.soloBuildMap). Mutually exclusive with mapTemplateId/mapPoolBoard/mapPoolRandomAtStart in the UI. Defaults to false when omitted. */
  soloBuildMap?: boolean
  /** Who builds when soloBuildMap is on (see GameSettings.soloBuilderSelection). Defaults to 'owner' when omitted. */
  soloBuilderSelection?: GameSettings['soloBuilderSelection']
  /** Where the builder's own unit-placement turn falls (see GameSettings.soloBuilderUnitOrder). Defaults to 'last' when omitted. */
  soloBuilderUnitOrder?: GameSettings['soloBuilderUnitOrder']
  /** Hotseat only: skip the "pass the device" confirmation gate between local players' turns (see GamePage.tsx). Ignored for live/async. Defaults to false (gate shown) when omitted; CreateGamePage.tsx's checkbox defaults to checked (true). */
  skipHotseatPassGate?: boolean
  /** Content ids of active Tales (src/content/tales.json) for the Tales variant, or omitted/empty for none. */
  activeTaleIds?: string[]
  /** Total achievements claimed (across all players) that ends the game — content/achievements.json's gameLength.min/max bounds it (1-6). Defaults to gameLength.default (4). */
  gameLength?: number
  /** Whether the room is listed on the Public Rooms screen (issue #40 section 4-5). Defaults to 'private' when omitted; CreateGamePage.tsx's checkbox defaults to checked ('public'). */
  visibility?: GameRow['visibility']
}): Promise<{ game: GameRow; player: PlayerRow }> {
  const roomCode = generateRoomCode()
  const name = params.name.trim()
  if (name.length === 0 || name.length > 60) {
    throw new Error('Room name must be between 1 and 60 characters')
  }

  const settings: GameSettings = {
    mapTemplateId: params.mapTemplateId ?? null,
    mapPoolBoard: params.mapPoolBoard ?? null,
    mapPoolMapId: params.mapPoolMapId ?? null,
    mapPoolRandomAtStart: params.mapPoolRandomAtStart ?? false,
    soloBuildMap: params.soloBuildMap ?? false,
    soloBuilderSelection: params.soloBuilderSelection ?? 'owner',
    soloBuilderId: null,
    soloBuilderUnitOrder: params.soloBuilderUnitOrder ?? 'last',
    soloBuilderTurnOrder: null,
    skipHotseatPassGate: params.skipHotseatPassGate ?? false,
    activeTaleIds: params.activeTaleIds ?? [],
    gameLength: params.gameLength ?? 4,
  }

  const { data: game, error: gameError } = await supabase
    .from('games')
    .insert({
      room_code: roomCode,
      name,
      play_mode: params.playMode,
      created_by: params.userId,
      min_players: params.minPlayers ?? 2,
      max_players: params.maxPlayers ?? 8,
      settings,
      visibility: params.visibility ?? 'private',
    })
    .select()
    .single()

  if (gameError) throw gameError

  const { data: player, error: playerError } = await supabase
    .from('players')
    .insert({
      game_id: game.id,
      user_id: params.userId,
      display_name: params.displayName,
      avatar_url: params.avatarUrl,
      seat_index: 0,
      color: PLAYER_COLORS[0],
    })
    .select()
    .single()

  if (playerError) throw playerError

  return { game: game as GameRow, player: player as PlayerRow }
}

export async function getGameByRoomCode(roomCode: string): Promise<GameRow | null> {
  const { data, error } = await supabase
    .from('games')
    .select()
    .eq('room_code', roomCode.toUpperCase())
    .maybeSingle()

  if (error) throw error
  return data as GameRow | null
}

export async function listPlayers(gameId: string): Promise<PlayerRow[]> {
  const { data, error } = await supabase
    .from('players')
    .select()
    .eq('game_id', gameId)
    .order('seat_index', { ascending: true })

  if (error) throw error
  return data as PlayerRow[]
}

/**
 * Every game the given user is seated in — for the "My games" screen
 * (MyGamesPage.tsx). Includes each game's full GameState (not just the
 * denormalized game_state.active_player_id column) so myGamesView.ts can
 * classify turn/finished status via the same pendingActorIds() the game
 * screen itself uses; games.status alone can't tell 'boardSetup' or
 * 'completed' apart from 'active' (see dbTypes.ts's GameRow comment).
 * `gameState` is left null for games still in the lobby, which have no
 * game_state row yet. RLS already scopes game_state reads to seated
 * players, and a personal game list is small enough that fetching each
 * one's state up front is cheap.
 */
export async function listMyGames(userId: string): Promise<MyGameEntry[]> {
  const { data: myRows, error: myRowsError } = await supabase.from('players').select().eq('user_id', userId)
  if (myRowsError) throw myRowsError

  const gameIds = [...new Set((myRows as PlayerRow[]).map((p) => p.game_id))]
  if (gameIds.length === 0) return []

  const [
    { data: games, error: gamesError },
    { data: allPlayers, error: allPlayersError },
    { data: states, error: statesError },
  ] = await Promise.all([
    supabase.from('games').select().in('id', gameIds),
    supabase.from('players').select().in('game_id', gameIds),
    supabase.from('game_state').select('game_id, state, updated_at').in('game_id', gameIds),
  ])
  if (gamesError) throw gamesError
  if (allPlayersError) throw allPlayersError
  if (statesError) throw statesError

  const playersByGame = new Map<string, PlayerRow[]>()
  for (const p of allPlayers as PlayerRow[]) {
    const list = playersByGame.get(p.game_id) ?? []
    list.push(p)
    playersByGame.set(p.game_id, list)
  }

  const stateByGame = new Map<string, EngineGameState>()
  const stateUpdatedAtByGame = new Map<string, string>()
  for (const row of states as { game_id: string; state: EngineGameState; updated_at: string }[]) {
    stateByGame.set(row.game_id, row.state)
    stateUpdatedAtByGame.set(row.game_id, row.updated_at)
  }

  return (games as GameRow[]).map((game) => {
    const gamePlayers = (playersByGame.get(game.id) ?? []).sort((a, b) => a.seat_index - b.seat_index)
    return {
      game,
      players: gamePlayers,
      gameState: stateByGame.get(game.id) ?? null,
      gameStateUpdatedAt: stateUpdatedAtByGame.get(game.id) ?? null,
      myPlayerIds: gamePlayers.filter((p) => p.user_id === userId).map((p) => p.id),
    }
  })
}

/**
 * Every room currently listed on the Public Rooms screen (issue #40
 * sections 4-5): visibility 'public', excluding 'canceled' (issue section 5:
 * "Canceled and Deleted rooms do not appear in the listing" — deleted rows
 * don't exist to query at all). Shaped like listMyGames's MyGameEntry
 * (game/players/gameState) minus the caller-specific `myPlayerIds`, since
 * this list isn't scoped to any one user — see publicRoomsView.ts for the
 * grouping/status logic built on top of it.
 */
export async function listPublicRooms(): Promise<PublicRoomEntry[]> {
  const { data: games, error: gamesError } = await supabase
    .from('games')
    .select()
    .eq('visibility', 'public')
    .neq('status', 'canceled')
    .order('updated_at', { ascending: false })
  if (gamesError) throw gamesError

  const gameRows = games as GameRow[]
  if (gameRows.length === 0) return []
  const gameIds = gameRows.map((g) => g.id)

  const [
    { data: allPlayers, error: allPlayersError },
    { data: states, error: statesError },
  ] = await Promise.all([
    supabase.from('players').select().in('game_id', gameIds),
    supabase.from('game_state').select('game_id, state, updated_at').in('game_id', gameIds),
  ])
  if (allPlayersError) throw allPlayersError
  if (statesError) throw statesError

  const playersByGame = new Map<string, PlayerRow[]>()
  for (const p of allPlayers as PlayerRow[]) {
    const list = playersByGame.get(p.game_id) ?? []
    list.push(p)
    playersByGame.set(p.game_id, list)
  }

  const stateByGame = new Map<string, EngineGameState>()
  const stateUpdatedAtByGame = new Map<string, string>()
  for (const row of states as { game_id: string; state: EngineGameState; updated_at: string }[]) {
    stateByGame.set(row.game_id, row.state)
    stateUpdatedAtByGame.set(row.game_id, row.updated_at)
  }

  return gameRows.map((game) => ({
    game,
    players: (playersByGame.get(game.id) ?? []).sort((a, b) => a.seat_index - b.seat_index),
    gameState: stateByGame.get(game.id) ?? null,
    gameStateUpdatedAt: stateUpdatedAtByGame.get(game.id) ?? null,
  }))
}

export async function joinGame(params: {
  game: GameRow
  userId: string
  displayName: string
  avatarUrl: string | null
}): Promise<PlayerRow> {
  const existingPlayers = await listPlayers(params.game.id)

  const already = existingPlayers.find((p) => p.user_id === params.userId)
  if (already) return already

  if (params.game.status !== 'lobby') {
    throw new Error('This game has already started.')
  }
  if (existingPlayers.length >= params.game.max_players) {
    throw new Error('This game is full.')
  }

  const seatIndex = nextSeatIndex(existingPlayers)
  const { data, error } = await supabase
    .from('players')
    .insert({
      game_id: params.game.id,
      user_id: params.userId,
      display_name: params.displayName,
      avatar_url: params.avatarUrl,
      seat_index: seatIndex,
      color: PLAYER_COLORS[seatIndex % PLAYER_COLORS.length],
    })
    .select()
    .single()

  if (error) throw error
  return data as PlayerRow
}

/**
 * Hotseat's answer to joinGame(): the one signed-in host seats another
 * *local* player under their own user_id — see 0003_hotseat_local_players.sql
 * for why that no longer collides with `unique (game_id, user_id)`. No
 * separate auth identity needed per seat, which is the whole point of
 * pass-and-play on a single device.
 */
export async function addLocalPlayer(params: { game: GameRow; hostUserId: string; displayName: string }): Promise<PlayerRow> {
  if (params.game.play_mode !== 'hotseat') {
    throw new Error('Local players can only be added to a hotseat game.')
  }
  if (params.game.status !== 'lobby') {
    throw new Error('This game has already started.')
  }

  const existingPlayers = await listPlayers(params.game.id)
  if (existingPlayers.length >= params.game.max_players) {
    throw new Error('This game is full.')
  }

  const seatIndex = nextSeatIndex(existingPlayers)
  const { data, error } = await supabase
    .from('players')
    .insert({
      game_id: params.game.id,
      user_id: params.hostUserId,
      display_name: params.displayName,
      avatar_url: null,
      seat_index: seatIndex,
      color: PLAYER_COLORS[seatIndex % PLAYER_COLORS.length],
    })
    .select()
    .single()

  if (error) throw error
  return data as PlayerRow
}

/** Removes a seated player — used pre-start to undo a mis-added hotseat local player (LobbyPage.tsx). RLS only allows deleting your own row (0003_hotseat_local_players.sql), which for hotseat covers every local player the host added. */
export async function removePlayer(playerId: string): Promise<void> {
  const { error } = await supabase.from('players').delete().eq('id', playerId)
  if (error) throw error
}

export async function setGameStatus(gameId: string, status: GameRow['status']): Promise<void> {
  const { error } = await supabase.from('games').update({ status }).eq('id', gameId)
  if (error) throw error
}

/**
 * Owner-only (RLS's "room owner can update their game" policy): toggles
 * whether the room is listed on the Public Rooms screen (issue #40 sections
 * 4-5, 0011_room_visibility.sql). Deliberately separate from
 * updateGameSettings — visibility isn't part of the game's rules
 * configuration (issue section 7), so changing it does not bump
 * `config_version` or reset player readiness.
 */
export async function setGameVisibility(gameId: string, visibility: GameRow['visibility']): Promise<void> {
  const { error } = await supabase.from('games').update({ visibility }).eq('id', gameId)
  if (error) throw error
}

/**
 * Owner-only (RLS's "room owner can update their game" policy), and only
 * while the room is still in the lobby (0009_config_versioning.sql's
 * `games_bump_config_version` trigger rejects it otherwise). Bumps
 * `config_version` server-side, which is what makes every non-Owner seated
 * player Not Ready again — see the room lifecycle spec's sections 7 (player
 * count is configuration too) and 9, and roomReadiness.ts.
 */
export async function updateGameSettings(
  gameId: string,
  params: { settings: GameSettings; minPlayers: number; maxPlayers: number },
): Promise<void> {
  const { error } = await supabase
    .from('games')
    .update({ settings: params.settings, min_players: params.minPlayers, max_players: params.maxPlayers })
    .eq('id', gameId)
  if (error) throw error
}

/**
 * A seated player confirms they've seen the room's current configuration.
 * `configVersion` must be the room's *current* config_version — the
 * `players_enforce_ready_for_version` trigger rejects any other value, so a
 * stale client can't mark itself ready for a version that's since moved on.
 */
export async function markReady(playerId: string, configVersion: number): Promise<void> {
  const { error } = await supabase.from('players').update({ ready_for_version: configVersion }).eq('id', playerId)
  if (error) throw error
}

/**
 * Owner-only (0008_room_lifecycle.sql's RLS policy silently drops the write
 * for anyone else): moves a room from 'lobby' or 'active' to 'canceled'.
 * Disables further `game_state` writes and blocks new joins (joinGame
 * already rejects any `status !== 'lobby'`) — see the room lifecycle spec's
 * section 11.
 */
export async function cancelGame(gameId: string): Promise<void> {
  const { error } = await supabase.from('games').update({ status: 'canceled' }).eq('id', gameId)
  if (error) throw error
}

/**
 * Owner-only, and only from a deletable state ('lobby' or 'canceled' —
 * 0008_room_lifecycle.sql's delete policy enforces both). Cascades remove
 * the room's `players`/`game_state` rows via their existing FKs.
 */
export async function deleteGame(gameId: string): Promise<void> {
  const { error } = await supabase.from('games').delete().eq('id', gameId)
  if (error) throw error
}

export function subscribeToPlayers(gameId: string, onChange: () => void): () => void {
  const channel = supabase
    .channel(`players:${gameId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `game_id=eq.${gameId}` }, onChange)
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}

export function subscribeToGame(gameId: string, onChange: (game: GameRow) => void): () => void {
  const channel = supabase
    .channel(`games:${gameId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` },
      (payload) => onChange(payload.new as GameRow),
    )
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}

export interface GameStateSnapshot {
  state: EngineGameState
  version: number
}

/**
 * Writes the game's very first GameState row (see createNewGame/startGame in
 * ../engine/createGame.ts). A no-op if a row already exists — LobbyPage
 * checks first via getGameState, but this stays defensive in case "start
 * game" is ever clicked twice in a race.
 */
export async function insertGameState(gameId: string, state: EngineGameState): Promise<void> {
  const { error } = await supabase
    .from('game_state')
    .insert({ game_id: gameId, state, turn: state.turn, active_player_id: state.activePlayerId })
  if (error && error.code !== '23505') throw error
}

export async function getGameState(gameId: string): Promise<GameStateSnapshot | null> {
  const { data, error } = await supabase.from('game_state').select('state, version').eq('game_id', gameId).maybeSingle()
  if (error) throw error
  if (!data) return null
  return { state: data.state as EngineGameState, version: data.version }
}

/**
 * Writes a new GameState produced by applyAction(), guarded by the row's
 * `version` (see 0001_init_schema.sql's game_state comment) so two clients
 * racing to submit an action can't silently clobber each other — returns
 * false (no rows updated) when `expectedVersion` is stale, in which case the
 * caller should refetch via getGameState and let the player retry.
 */
export async function writeGameState(gameId: string, state: EngineGameState, expectedVersion: number): Promise<boolean> {
  const { data, error } = await supabase
    .from('game_state')
    .update({ state, turn: state.turn, active_player_id: state.activePlayerId, version: expectedVersion + 1 })
    .eq('game_id', gameId)
    .eq('version', expectedVersion)
    .select('version')
  if (error) throw error
  return (data?.length ?? 0) > 0
}

export function subscribeToGameState(gameId: string, onChange: (snapshot: GameStateSnapshot) => void): () => void {
  const channel = supabase
    .channel(`game_state:${gameId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'game_state', filter: `game_id=eq.${gameId}` },
      (payload) => {
        const row = payload.new as GameStateRow
        onChange({ state: row.state, version: row.version })
      },
    )
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}
