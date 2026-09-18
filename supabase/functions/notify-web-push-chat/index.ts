// Sends a Web Push notification when someone posts in a game's chat (issue
// #658, CHAT_PLAN.md §20). Structurally identical to notify-discord-chat
// (see that function's doc comment for the full trigger/scope rationale —
// in-game only, async games only, opt-in via `profiles.preferences.
// chatNotificationsEnabled`); deliberately a near-duplicate rather than a
// shared import, same reason as every other push/Discord pair in this repo:
// Deno Edge Functions can't import the app's Vite-aliased TypeScript
// sources.
//
// Trigger: the *same* Supabase Database Webhook on `chat_messages` INSERT
// that triggers notify-discord-chat can also target this function (Database
// Webhooks support multiple targets per table/event), with its own
// `x-webhook-secret` matching this function's `PUSH_CHAT_WEBHOOK_SECRET`
// secret. Reuses the same `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/
// `VAPID_CONTACT`/`SITE_URL` secrets as notify-web-push — same subscriber
// pool, no new keypair needed. See README's "Chat message notifications"
// section — no automated setup workflow exists for this one yet.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3'

const BODY_PREVIEW_MAX = 200

interface GameRow {
  id: string
  room_code: string
  name: string
  play_mode: string
}

interface PlayerRow {
  id: string
  user_id: string
  display_name: string
}

interface ChatMessageRow {
  id: number
  game_id: string | null
  sender_id: string
  body: string
}

interface DatabaseWebhookPayload {
  type: string
  table: string
  record: ChatMessageRow | null
  old_record: ChatMessageRow | null
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

function previewBody(body: string): string {
  const trimmed = body.trim()
  return trimmed.length > BODY_PREVIEW_MAX ? `${trimmed.slice(0, BODY_PREVIEW_MAX)}…` : trimmed
}

async function handleChatMessage(supabase: SupabaseClient, message: ChatMessageRow): Promise<Response> {
  if (!message.game_id) return new Response('site-wide chat, no notification', { status: 200 })

  const { data: game } = await supabase.from('games').select('id, room_code, name, play_mode').eq('id', message.game_id).maybeSingle()
  if (!game || (game as GameRow).play_mode !== 'async') return new Response('not an async game', { status: 200 })

  const { data: players } = await supabase.from('players').select('id, user_id, display_name').eq('game_id', message.game_id)
  const allPlayers = (players ?? []) as PlayerRow[]
  const sender = allPlayers.find((p) => p.user_id === message.sender_id)
  const recipients = allPlayers.filter((p) => p.user_id !== message.sender_id)
  if (recipients.length === 0) return new Response('no recipients', { status: 200 })

  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, preferences')
    .in(
      'user_id',
      recipients.map((p) => p.user_id),
    )
  const optedInUserIds = new Set(
    ((profiles ?? []) as { user_id: string; preferences: Record<string, unknown> | null }[])
      .filter((p) => p.preferences?.chatNotificationsEnabled === true)
      .map((p) => p.user_id),
  )
  const optedInUserIdList = recipients.map((p) => p.user_id).filter((id) => optedInUserIds.has(id))
  if (optedInUserIdList.length === 0) return new Response('no opted-in recipients', { status: 200 })

  const { data: subscriptions } = await supabase.from('push_subscriptions').select('user_id, endpoint, p256dh, auth').in('user_id', optedInUserIdList)

  const senderName = sender?.display_name ?? 'Someone'
  const game_ = game as GameRow
  const body = `${senderName} in ${game_.name}: ${previewBody(message.body)}`
  const url = gameUrlFor(game_.room_code)

  await Promise.allSettled(
    ((subscriptions ?? []) as (PushSubscriptionRow & { user_id: string })[]).map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ title: 'Rise & Fall', body, url }))
      } catch (err) {
        // A 404/410 means the browser dropped the subscription — clean it up, same as notify-web-push.
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
        }
      }
    }),
  )
  return new Response('ok', { status: 200 })
}

Deno.serve(async (req) => {
  const expectedSecret = Deno.env.get('PUSH_CHAT_WEBHOOK_SECRET')
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
  if (payload.type !== 'INSERT' || payload.table !== 'chat_messages' || !payload.record) {
    return new Response('ignored', { status: 200 })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  return handleChatMessage(supabase, payload.record)
})
