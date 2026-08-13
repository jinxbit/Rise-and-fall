import { supabase } from './supabase'
import { nextSeatIndex } from './seatIndex'
import type { GameRow, GameSettings, GameStateRow, PlayerRow } from './dbTypes'
import type { MyGameEntry } from './myGamesView'
import type { GameState as EngineGameState, PlayMode } from '../engine/types'

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

const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308']
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I

export function generateRoomCode(length = 5): string {
  let code = ''
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
  }
  return code
}

export async function createGame(params: {
  playMode: PlayMode
  userId: string
  displayName: string
  avatarUrl: string | null
  minPlayers?: number
  maxPlayers?: number
  /** Content id of a pre-made map template (src/content/mapTemplates.json) to skip interactive tile placement, or null/omitted for the usual interactive setup. */
  mapTemplateId?: string | null
  /** Hotseat only: skip the "pass the device" confirmation gate between local players' turns (see GamePage.tsx). Ignored for live/async. Defaults to false (gate shown), matching the checkbox's unchecked default in HomePage.tsx. */
  skipHotseatPassGate?: boolean
  /** Content ids of active Tales (src/content/tales.json) for the Tales variant, or omitted/empty for none. */
  activeTaleIds?: string[]
  /** Total achievements claimed (across all players) that ends the game — content/achievements.json's gameLength.min/max bounds it (1-6). Defaults to gameLength.default (4). */
  gameLength?: number
}): Promise<{ game: GameRow; player: PlayerRow }> {
  const roomCode = generateRoomCode()

  const settings: GameSettings = {
    mapTemplateId: params.mapTemplateId ?? null,
    skipHotseatPassGate: params.skipHotseatPassGate ?? false,
    activeTaleIds: params.activeTaleIds ?? [],
    gameLength: params.gameLength ?? 4,
  }

  const { data: game, error: gameError } = await supabase
    .from('games')
    .insert({
      room_code: roomCode,
      play_mode: params.playMode,
      created_by: params.userId,
      min_players: params.minPlayers ?? 2,
      max_players: params.maxPlayers ?? 4,
      settings,
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
    supabase.from('game_state').select('game_id, state').in('game_id', gameIds),
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
  for (const row of states as { game_id: string; state: EngineGameState }[]) {
    stateByGame.set(row.game_id, row.state)
  }

  return (games as GameRow[]).map((game) => {
    const gamePlayers = (playersByGame.get(game.id) ?? []).sort((a, b) => a.seat_index - b.seat_index)
    return {
      game,
      players: gamePlayers,
      gameState: stateByGame.get(game.id) ?? null,
      myPlayerIds: gamePlayers.filter((p) => p.user_id === userId).map((p) => p.id),
    }
  })
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
