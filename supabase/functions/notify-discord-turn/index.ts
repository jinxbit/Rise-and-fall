// Sends "it's your turn" Discord pings for async games. Runs server-side
// (Supabase Edge Function) instead of a player's browser — see
// src/lib/discordNotify.ts and README.md's "Discord turn notifications"
// section for why this moved off the client (webhook URLs no longer need
// to be readable by co-players, and the ping no longer depends on a
// browser tab staying open after the triggering write).
//
// Trigger: a Supabase Database Webhook on `game_state` UPDATE (configured
// in the dashboard, see README) POSTs the standard Database Webhook payload
// here — `{ type: 'UPDATE', table: 'game_state', record, old_record }` —
// with `record`/`old_record` being the new/old game_state rows. Configure
// the webhook to send a custom header `x-webhook-secret: <a random value>`
// and set that same value as this function's `DISCORD_NOTIFY_WEBHOOK_SECRET`
// secret, so this endpoint can't be triggered by anyone who finds the URL.
//
// `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are provided automatically
// in the Edge Function runtime — the service-role key is what lets this
// read any player's `profiles.discord_webhook_url` regardless of RLS
// (0013_discord_notify_backend.sql drops the old co-player-read policy,
// since browsers no longer need that access).

import { createClient } from 'jsr:@supabase/supabase-js@2'

// --- Pure turn-order logic, ported from src/engine/turnOrder.ts and
// src/engine/boardSetup.ts (currentTilePlacerId/currentUnitPlacerId). Deno
// Edge Functions run in an isolated runtime that can't import the app's
// Vite-aliased TypeScript sources directly, so this is a deliberate,
// minimal copy — keep it in sync if pendingActorIds()'s rules ever change.
interface BoardSetupState {
  tileTierQueue: unknown[]
  tilePlacerIndex: number
  unitsRemainingByPlayerId: Record<string, unknown[]>
  unitPlacerIndex: number
}

type RoundPhase = 'selectCards' | 'actions' | 'decline' | 'purchase'

interface GameState {
  status: 'lobby' | 'boardSetup' | 'active' | 'completed'
  turnOrder: string[]
  boardSetup: BoardSetupState | null
  activePlayerId: string | null
  pendingPlayerIds: string[]
  roundPhase: RoundPhase
}

function currentTilePlacerId(state: GameState): string | null {
  const boardSetup = state.boardSetup
  if (state.status !== 'boardSetup' || !boardSetup || boardSetup.tileTierQueue.length === 0) return null
  if (state.turnOrder.length === 0) return null
  return state.turnOrder[boardSetup.tilePlacerIndex % state.turnOrder.length]
}

function currentUnitPlacerId(state: GameState): string | null {
  const boardSetup = state.boardSetup
  if (state.status !== 'boardSetup' || !boardSetup || boardSetup.tileTierQueue.length > 0) return null
  if (Object.keys(boardSetup.unitsRemainingByPlayerId).length === 0) return null
  if (state.turnOrder.length === 0) return null
  return state.turnOrder[boardSetup.unitPlacerIndex % state.turnOrder.length]
}

function pendingActorIds(state: GameState): string[] {
  if (state.status === 'boardSetup') {
    const id = currentTilePlacerId(state) ?? currentUnitPlacerId(state)
    return id ? [id] : []
  }
  if (state.status === 'active') {
    if (state.pendingPlayerIds.length > 0) return state.pendingPlayerIds
    return state.activePlayerId ? [state.activePlayerId] : []
  }
  return []
}

const ROUND_PHASE_LABELS: Record<RoundPhase, string> = {
  selectCards: 'select a card',
  actions: 'take your action',
  decline: 'decline a card',
  purchase: 'make a purchase',
}

/** Short label for what the newly-pending player needs to do — see turnNotificationMessage's `phase` param. */
function phaseLabel(state: GameState): string {
  if (state.status === 'boardSetup') {
    return currentTilePlacerId(state) ? 'place a tile' : 'place a unit'
  }
  return ROUND_PHASE_LABELS[state.roundPhase]
}

// --- Discord ---
const WEBHOOK_URL_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/

function turnNotificationMessage(params: {
  roomCode: string
  roomName: string
  displayName: string
  phase: string
  gameUrl?: string
}): string {
  const link = params.gameUrl ? `\n${params.gameUrl}` : ` (\`${params.roomCode}\`)`
  return `**${params.displayName}**, it's your turn to **${params.phase}** in **${params.roomName}**.${link}`
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

interface DatabaseWebhookPayload {
  type: string
  table: string
  record: { game_id: string; state: GameState } | null
  old_record: { game_id: string; state: GameState } | null
}

Deno.serve(async (req) => {
  const expectedSecret = Deno.env.get('DISCORD_NOTIFY_WEBHOOK_SECRET')
  if (expectedSecret && req.headers.get('x-webhook-secret') !== expectedSecret) {
    return new Response('Unauthorized', { status: 401 })
  }

  const payload = (await req.json()) as DatabaseWebhookPayload
  if (payload.type !== 'UPDATE' || payload.table !== 'game_state' || !payload.record || !payload.old_record) {
    return new Response('ignored', { status: 200 })
  }

  const wasPending = new Set(pendingActorIds(payload.old_record.state))
  const nowPending = pendingActorIds(payload.record.state).filter((id) => !wasPending.has(id))
  if (nowPending.length === 0) {
    return new Response('no new pending players', { status: 200 })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const gameId = payload.record.game_id

  const { data: game, error: gameError } = await supabase
    .from('games')
    .select('room_code, name, play_mode')
    .eq('id', gameId)
    .maybeSingle()
  if (gameError) return new Response(`game lookup failed: ${gameError.message}`, { status: 500 })
  // Live players already get pushed the update via Realtime; hotseat is one
  // shared device with nobody to page. Only async games need a ping.
  if (!game || game.play_mode !== 'async') return new Response('not an async game', { status: 200 })

  const phase = phaseLabel(payload.record.state)
  // Optional — set via `supabase secrets set SITE_URL=...` (see README). Without
  // it the message falls back to just naming the room code instead of a link.
  const siteUrl = Deno.env.get('SITE_URL')
  const gameUrl = siteUrl ? `${siteUrl.replace(/\/$/, '')}/game/${game.room_code}` : undefined

  const { data: players, error: playersError } = await supabase
    .from('players')
    .select('id, user_id, display_name')
    .in('id', nowPending)
  if (playersError) return new Response(`players lookup failed: ${playersError.message}`, { status: 500 })
  if (!players || players.length === 0) return new Response('no matching players', { status: 200 })

  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select('user_id, discord_webhook_url')
    .in(
      'user_id',
      players.map((p) => p.user_id),
    )
  if (profilesError) return new Response(`profiles lookup failed: ${profilesError.message}`, { status: 500 })

  const webhookByUserId = new Map((profiles ?? []).map((p) => [p.user_id, p.discord_webhook_url]))

  await Promise.allSettled(
    players.map((player) => {
      const webhookUrl = webhookByUserId.get(player.user_id)
      if (!webhookUrl || !WEBHOOK_URL_PATTERN.test(webhookUrl)) return Promise.resolve()
      return sendDiscordNotification(
        webhookUrl,
        turnNotificationMessage({ roomCode: game.room_code, roomName: game.name, displayName: player.display_name, phase, gameUrl }),
      )
    }),
  )

  return new Response('ok', { status: 200 })
})
