import { supabase } from './supabase'
import type { GameRow, PlayerRow } from './dbTypes'
import type { PlayMode } from '../engine/types'

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

  const seatIndex = existingPlayers.length
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
