import { supabase } from './supabase'
import { nextSeatIndex } from './seatIndex'
import type { GameRow, GameStateRow, PlayerRow } from './dbTypes'
import type { GameState as EngineGameState, PlayMode } from '../engine/types'

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
}): Promise<{ game: GameRow; player: PlayerRow }> {
  const roomCode = generateRoomCode()

  const { data: game, error: gameError } = await supabase
    .from('games')
    .insert({
      room_code: roomCode,
      play_mode: params.playMode,
      created_by: params.userId,
      min_players: params.minPlayers ?? 2,
      max_players: params.maxPlayers ?? 4,
      map_template_id: params.mapTemplateId ?? null,
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
