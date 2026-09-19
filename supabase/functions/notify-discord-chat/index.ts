// Sends a Discord ping when someone posts in a game's chat (issue #658,
// CHAT_PLAN.md §20). Sibling of notify-discord-lifecycle/notify-discord-turn
// (see notify-discord-turn's doc comment for the full "why server-side"
// rationale) — this one watches `chat_messages` instead of `game_state` or
// `players`/`games`.
//
// Trigger: a Supabase Database Webhook on `chat_messages` INSERT, configured
// the same way as every other notify-* function (an `x-webhook-secret`
// header matching this function's `DISCORD_CHAT_WEBHOOK_SECRET` secret) —
// see README's "Chat message notifications" section. No automated "Set Up …
// Notifications" GitHub Actions workflow exists for this one yet (unlike the
// other three notify-* families) — register the hook by hand per that
// section until one is added.
//
// In-game chat only: a `game_id is null` row (site-wide chat) is ignored —
// CHAT_PLAN.md never gave site-wide chat an unread indicator either (§13),
// same "no natural per-recipient moment" reasoning applies to a notification.
// Async games only, same rule as every other notify-* function: a live
// player already sees new messages over `chat_messages`' own Realtime
// subscription (CHAT_PLAN.md §5), and hotseat has nobody remote to ping.
//
// Unlike the turn/lifecycle pings, this is gated by its own per-player
// toggle on top of having a Discord webhook configured at all —
// `profiles.preferences.chatNotificationsEnabled`
// (src/lib/chatNotificationPreference.ts), default **on** as of issue #668
// (previously off, issue #658) — so only an explicit `false` opts a player
// out, not merely leaving the preference unset.
//
// `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are provided automatically in
// the Edge Function runtime — the service-role key is what lets this read
// any player's `profiles.discord_webhook_url`/`preferences` regardless of
// RLS, same as every other notify-* function.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const WEBHOOK_URL_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/

// A chat message can be up to 2000 chars (0031_chat_messages.sql's check
// constraint) — far too long for a ping. Trimmed with an ellipsis, not
// rejected; the full message is always readable in the game itself.
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

// Same as notify-discord-turn's gameUrlFor — see that function's doc comment
// for why only the origin of SITE_URL is used.
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

function previewBody(body: string): string {
  const trimmed = body.trim()
  return trimmed.length > BODY_PREVIEW_MAX ? `${trimmed.slice(0, BODY_PREVIEW_MAX)}…` : trimmed
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

async function handleChatMessage(supabase: SupabaseClient, message: ChatMessageRow): Promise<Response> {
  if (!message.game_id) return new Response('site-wide chat, no notification', { status: 200 })

  const { data: game } = await supabase.from('games').select('id, room_code, name, play_mode').eq('id', message.game_id).maybeSingle()
  // Live players see the message over Realtime; hotseat has nobody remote to
  // ping — same async-only rule as every other notify-* function.
  if (!game || (game as GameRow).play_mode !== 'async') return new Response('not an async game', { status: 200 })

  const { data: players } = await supabase.from('players').select('id, user_id, display_name').eq('game_id', message.game_id)
  const allPlayers = (players ?? []) as PlayerRow[]
  const sender = allPlayers.find((p) => p.user_id === message.sender_id)
  const recipients = allPlayers.filter((p) => p.user_id !== message.sender_id)
  if (recipients.length === 0) return new Response('no recipients', { status: 200 })

  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, discord_webhook_url, preferences')
    .in(
      'user_id',
      recipients.map((p) => p.user_id),
    )
  const profileByUserId = new Map(
    ((profiles ?? []) as { user_id: string; discord_webhook_url: string | null; preferences: Record<string, unknown> | null }[]).map((p) => [p.user_id, p]),
  )

  const senderName = sender?.display_name ?? 'Someone'
  const game_ = game as GameRow
  const content = `**Rise & Fall** — **${senderName}** in ${roomText(game_.name, game_.room_code, gameUrlFor(game_.room_code))}: ${previewBody(message.body)}`

  await Promise.allSettled(
    recipients.map((player) => {
      const profile = profileByUserId.get(player.user_id)
      if (!profile || profile.preferences?.chatNotificationsEnabled === false) return Promise.resolve()
      const webhookUrl = profile.discord_webhook_url
      if (!webhookUrl || !WEBHOOK_URL_PATTERN.test(webhookUrl)) return Promise.resolve()
      return sendDiscordNotification(webhookUrl, content)
    }),
  )
  return new Response('ok', { status: 200 })
}

Deno.serve(async (req) => {
  const expectedSecret = Deno.env.get('DISCORD_CHAT_WEBHOOK_SECRET')
  if (expectedSecret && req.headers.get('x-webhook-secret') !== expectedSecret) {
    return new Response('Unauthorized', { status: 401 })
  }

  const payload = (await req.json()) as DatabaseWebhookPayload
  if (payload.type !== 'INSERT' || payload.table !== 'chat_messages' || !payload.record) {
    return new Response('ignored', { status: 200 })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  return handleChatMessage(supabase, payload.record)
})
