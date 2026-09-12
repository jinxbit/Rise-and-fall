// Sends Web Push notifications for game *lifecycle* events — a player
// joining the lobby, the game starting, finishing, or being canceled — for
// async games. Structurally identical to notify-discord-lifecycle (see that
// function's doc comment for the full trigger/dispatch rationale, and
// notify-web-push's doc comment for why this is a near-duplicate of the
// Discord version rather than a shared import): Deno Edge Functions can't
// import the app's Vite-aliased TypeScript sources, and these are small
// enough that duplicating them beats the ceremony of a shared module.
//
// Trigger: the same three Database Webhooks as notify-discord-lifecycle
// (`players` INSERT, `games` UPDATE, `game_state` UPDATE) can each also
// target this function — Database Webhooks support multiple targets per
// table/event. Configure each to send `x-webhook-secret` matching this
// function's `PUSH_LIFECYCLE_WEBHOOK_SECRET` secret. Reuses the same
// `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_CONTACT`/`SITE_URL` secrets
// as notify-web-push — same subscriber pool, no new keypair needed.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3'

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

interface PushSubscriptionRow {
  endpoint: string
  p256dh: string
  auth: string
}

function gameUrlFor(roomCode: string): string {
  const siteUrl = Deno.env.get('SITE_URL')
  if (!siteUrl) return `/game/${roomCode}`
  try {
    return `${new URL(siteUrl).origin}/game/${roomCode}`
  } catch {
    return `/game/${roomCode}`
  }
}

async function fetchGame(supabase: SupabaseClient, gameId: string): Promise<GameRow | null> {
  const { data } = await supabase.from('games').select('id, room_code, name, play_mode, status').eq('id', gameId).maybeSingle()
  return (data as GameRow | null) ?? null
}

async function fetchPlayers(supabase: SupabaseClient, gameId: string, excludingPlayerId?: string): Promise<PlayerRow[]> {
  let query = supabase.from('players').select('id, user_id').eq('game_id', gameId)
  if (excludingPlayerId) query = query.neq('id', excludingPlayerId)
  const { data } = await query
  return (data as PlayerRow[] | null) ?? []
}

async function notifyPlayers(supabase: SupabaseClient, players: PlayerRow[], body: string, url: string): Promise<void> {
  if (players.length === 0) return
  const { data: subscriptions } = await supabase
    .from('push_subscriptions')
    .select('user_id, endpoint, p256dh, auth')
    .in(
      'user_id',
      players.map((p) => p.user_id),
    )

  await Promise.allSettled(
    ((subscriptions ?? []) as (PushSubscriptionRow & { user_id: string })[]).map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: 'Rise & Fall', body, url }),
        )
      } catch (err) {
        // A 404/410 means the browser dropped the subscription — clean it up,
        // same as notify-web-push.
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
        }
      }
    }),
  )
}

async function handlePlayerJoined(
  supabase: SupabaseClient,
  newPlayer: { id: string; game_id: string; display_name: string },
): Promise<Response> {
  const game = await fetchGame(supabase, newPlayer.game_id)
  if (!game || game.play_mode !== 'async') return new Response('not an async game', { status: 200 })

  const others = await fetchPlayers(supabase, newPlayer.game_id, newPlayer.id)
  await notifyPlayers(supabase, others, `${newPlayer.display_name} joined ${game.name}.`, gameUrlFor(game.room_code))
  return new Response('ok', { status: 200 })
}

async function handleGameStatusChange(supabase: SupabaseClient, oldGame: GameRow, newGame: GameRow): Promise<Response> {
  if (newGame.play_mode !== 'async' || oldGame.status === newGame.status) {
    return new Response('no relevant status change', { status: 200 })
  }

  let body: string | null = null
  if (oldGame.status === 'lobby' && newGame.status === 'active') {
    body = `${newGame.name} has started!`
  } else if (newGame.status === 'canceled') {
    body = `${newGame.name} was canceled.`
  }
  if (!body) return new Response('no relevant status change', { status: 200 })

  const players = await fetchPlayers(supabase, newGame.id)
  await notifyPlayers(supabase, players, body, gameUrlFor(newGame.room_code))
  return new Response('ok', { status: 200 })
}

async function handleGameFinished(supabase: SupabaseClient, oldState: GameStateStatusRow, newState: GameStateStatusRow): Promise<Response> {
  if (oldState.state.status === 'completed' || newState.state.status !== 'completed') {
    return new Response('not a finish', { status: 200 })
  }
  const game = await fetchGame(supabase, newState.game_id)
  if (!game || game.play_mode !== 'async') return new Response('not an async game', { status: 200 })

  const players = await fetchPlayers(supabase, game.id)
  await notifyPlayers(supabase, players, `${game.name} has finished!`, gameUrlFor(game.room_code))
  return new Response('ok', { status: 200 })
}

Deno.serve(async (req) => {
  const expectedSecret = Deno.env.get('PUSH_LIFECYCLE_WEBHOOK_SECRET')
  if (expectedSecret && req.headers.get('x-webhook-secret') !== expectedSecret) {
    return new Response('Unauthorized', { status: 401 })
  }

  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY')
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')
  if (!vapidPublicKey || !vapidPrivateKey) {
    return new Response('VAPID keys not configured', { status: 500 })
  }
  webpush.setVapidDetails(Deno.env.get('VAPID_CONTACT') ?? 'mailto:admin@example.com', vapidPublicKey, vapidPrivateKey)

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
