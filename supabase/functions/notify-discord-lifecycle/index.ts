// Sends Discord pings for game *lifecycle* events — a player joining the
// lobby, the game starting, finishing, or being canceled — for async games.
// Sibling of notify-discord-turn (see that function's doc comment for the
// full "why server-side" rationale); kept as its own function rather than
// folded into notify-discord-turn because it's driven by three different
// Database Webhooks instead of one, and dispatches on `payload.table`
// internally instead of just diffing one row shape.
//
// Trigger: three separate Supabase Database Webhooks (configured in the
// dashboard — see README's "Lobby & game lifecycle notifications" section),
// all targeting this function:
//   - `players` INSERT    -> a player joined the lobby
//   - `games` UPDATE      -> the game started (status lobby -> active) or
//                             was canceled (status -> canceled)
//   - `game_state` UPDATE -> the game finished (state.status -> completed)
// Each sends the standard Database Webhook payload
// (`{ type, table, record, old_record }`). Configure every one of the three
// webhooks to send the same `x-webhook-secret` header, matching this
// function's `DISCORD_LIFECYCLE_WEBHOOK_SECRET` secret.
//
// `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are provided automatically in
// the Edge Function runtime, same as notify-discord-turn — the service-role
// key is what lets this read any player's `profiles.discord_webhook_url`
// regardless of RLS.
//
// A rule-enforced game's `game_state.state` is stored gzip+base64 under
// `__gz` (src/lib/gameStateCompression.ts) — but `status` is one of the
// fields duplicated in plaintext alongside it specifically so callers like
// this one can read it without decompressing, so the finished-game check
// below works unmodified for both write paths.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const WEBHOOK_URL_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/

interface GameRow {
  id: string
  room_code: string
  name: string
  play_mode: string
  status: string
}

interface PlayerRow {
  id: string
  user_id: string
  display_name: string
}

interface GameStateStatusRow {
  game_id: string
  state: { status: string }
}

interface DatabaseWebhookPayload {
  type: string
  table: string
  record: Record<string, unknown> | null
  old_record: Record<string, unknown> | null
}

// SITE_URL is an optional secret (supabase secrets set SITE_URL=...), same
// one notify-discord-turn reads — see that function's doc comment for why
// only the origin is used.
function gameUrlFor(roomCode: string): string | null {
  const siteUrl = Deno.env.get('SITE_URL')
  if (!siteUrl) return null
  try {
    return `${new URL(siteUrl).origin}/game/${roomCode}`
  } catch {
    return null
  }
}

function roomText(name: string, roomCode: string, url: string | null): string {
  return url ? `[${name}](${url})` : `**${name}** (room \`${roomCode}\`)`
}

async function sendDiscordNotification(webhookUrl: string, content: string): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  } catch {
    // Best-effort — a bad/deleted webhook or network hiccup shouldn't fail the request.
  }
}

async function notifyPlayers(
  supabase: SupabaseClient,
  players: PlayerRow[],
  message: string,
): Promise<void> {
  if (players.length === 0) return
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, discord_webhook_url')
    .in(
      'user_id',
      players.map((p) => p.user_id),
    )
  const webhookByUserId = new Map((profiles ?? []).map((p: { user_id: string; discord_webhook_url: string | null }) => [p.user_id, p.discord_webhook_url]))
  await Promise.allSettled(
    players.map((player) => {
      const webhookUrl = webhookByUserId.get(player.user_id)
      if (!webhookUrl || !WEBHOOK_URL_PATTERN.test(webhookUrl)) return Promise.resolve()
      return sendDiscordNotification(webhookUrl, message)
    }),
  )
}

async function fetchGame(supabase: SupabaseClient, gameId: string): Promise<GameRow | null> {
  const { data } = await supabase.from('games').select('id, room_code, name, play_mode, status').eq('id', gameId).maybeSingle()
  return (data as GameRow | null) ?? null
}

async function fetchPlayers(supabase: SupabaseClient, gameId: string, excludingPlayerId?: string): Promise<PlayerRow[]> {
  let query = supabase.from('players').select('id, user_id, display_name').eq('game_id', gameId)
  if (excludingPlayerId) query = query.neq('id', excludingPlayerId)
  const { data } = await query
  return (data as PlayerRow[] | null) ?? []
}

async function handlePlayerJoined(
  supabase: SupabaseClient,
  newPlayer: { id: string; game_id: string; display_name: string },
): Promise<Response> {
  const game = await fetchGame(supabase, newPlayer.game_id)
  // Live players see the join over Realtime; hotseat has nobody remote to
  // ping — same async-only rule as notify-discord-turn.
  if (!game || game.play_mode !== 'async') return new Response('not an async game', { status: 200 })

  const others = await fetchPlayers(supabase, newPlayer.game_id, newPlayer.id)
  const message = `**Rise & Fall** — **${newPlayer.display_name}** joined ${roomText(game.name, game.room_code, gameUrlFor(game.room_code))}.`
  await notifyPlayers(supabase, others, message)
  return new Response('ok', { status: 200 })
}

async function handleGameStatusChange(
  supabase: SupabaseClient,
  oldGame: GameRow,
  newGame: GameRow,
): Promise<Response> {
  // A `games` UPDATE fires for any column change (name, settings, ...), not
  // just status — only react when status actually moved.
  if (newGame.play_mode !== 'async' || oldGame.status === newGame.status) {
    return new Response('no relevant status change', { status: 200 })
  }

  const room = roomText(newGame.name, newGame.room_code, gameUrlFor(newGame.room_code))
  let message: string | null = null
  if (oldGame.status === 'lobby' && newGame.status === 'active') {
    message = `**Rise & Fall** — ${room} has started!`
  } else if (newGame.status === 'canceled') {
    message = `**Rise & Fall** — ${room} was canceled.`
  }
  if (!message) return new Response('no relevant status change', { status: 200 })

  const players = await fetchPlayers(supabase, newGame.id)
  await notifyPlayers(supabase, players, message)
  return new Response('ok', { status: 200 })
}

async function handleGameFinished(
  supabase: SupabaseClient,
  oldState: GameStateStatusRow,
  newState: GameStateStatusRow,
): Promise<Response> {
  if (oldState.state.status === 'completed' || newState.state.status !== 'completed') {
    return new Response('not a finish', { status: 200 })
  }
  const game = await fetchGame(supabase, newState.game_id)
  if (!game || game.play_mode !== 'async') return new Response('not an async game', { status: 200 })

  const players = await fetchPlayers(supabase, game.id)
  const message = `**Rise & Fall** — ${roomText(game.name, game.room_code, gameUrlFor(game.room_code))} has finished!`
  await notifyPlayers(supabase, players, message)
  return new Response('ok', { status: 200 })
}

Deno.serve(async (req) => {
  const expectedSecret = Deno.env.get('DISCORD_LIFECYCLE_WEBHOOK_SECRET')
  if (expectedSecret && req.headers.get('x-webhook-secret') !== expectedSecret) {
    return new Response('Unauthorized', { status: 401 })
  }

  const payload = (await req.json()) as DatabaseWebhookPayload
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  if (payload.table === 'players' && payload.type === 'INSERT' && payload.record) {
    return handlePlayerJoined(supabase, payload.record as { id: string; game_id: string; display_name: string })
  }
  if (payload.table === 'games' && payload.type === 'UPDATE' && payload.record && payload.old_record) {
    return handleGameStatusChange(supabase, payload.old_record as GameRow, payload.record as GameRow)
  }
  if (payload.table === 'game_state' && payload.type === 'UPDATE' && payload.record && payload.old_record) {
    return handleGameFinished(supabase, payload.old_record as GameStateStatusRow, payload.record as GameStateStatusRow)
  }
  return new Response('ignored', { status: 200 })
})
