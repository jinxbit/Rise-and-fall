// Sends "it's your turn" Web Push notifications for async games — the
// notification-half of PWA support (issue #250). Structurally identical to
// notify-discord-turn (see that function's doc comment for the full
// rationale on why this runs server-side); this file is deliberately a
// near-duplicate rather than a shared import, for the same reason: Deno
// Edge Functions can't import the app's Vite-aliased TypeScript sources.
//
// Trigger: the *same* Supabase Database Webhook on `game_state` UPDATE that
// triggers notify-discord-turn can also target this function (Database
// Webhooks support multiple targets per table/event) — see README's "Push
// notifications" section for setup, including this function's own secret
// header so it can't be triggered by anyone who finds the URL.
//
// Like notify-discord-turn, that one webhook feeds two pings: "it's your
// turn", and the **game finished** lifecycle push, since a game finishing is
// itself a `game_state` UPDATE. See notify-discord-turn's doc comment for
// why that moved here out of notify-web-push-lifecycle, which still sends
// the three lifecycle pings that live on other tables.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3'

// --- Pure turn-order logic — identical copy to notify-discord-turn/index.ts.
// Keep both in sync if pendingActorIds()'s rules ever change.
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
  turn: number
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
    if (state.roundPhase === 'selectCards' || state.roundPhase === 'decline' || state.roundPhase === 'purchase') {
      return state.pendingPlayerIds
    }
    return state.activePlayerId ? [state.activePlayerId] : []
  }
  return []
}

// Identical to notify-discord-turn's — `status` is duplicated in plaintext
// alongside a rule-enforced game's gzipped state, so this needs no decompression.
function justFinished(oldState: GameState, newState: GameState): boolean {
  return oldState.status !== 'completed' && newState.status === 'completed'
}

const ROUND_PHASE_LABEL: Record<RoundPhase, string> = {
  selectCards: 'select a card',
  actions: 'take your action',
  decline: 'decline a card',
  purchase: 'make a purchase',
}

function phaseLabel(state: GameState): string {
  if (state.status === 'boardSetup') return currentTilePlacerId(state) ? 'place a tile' : 'place a unit'
  return ROUND_PHASE_LABEL[state.roundPhase]
}

interface DatabaseWebhookPayload {
  type: string
  table: string
  record: { game_id: string; state: GameState } | null
  old_record: { game_id: string; state: GameState } | null
}

interface PushSubscriptionRow {
  endpoint: string
  p256dh: string
  auth: string
}

// SITE_URL is optional; without it the notification carries a relative path,
// which the service worker resolves against its own origin anyway.
function gameUrlFor(roomCode: string): string {
  const siteUrl = Deno.env.get('SITE_URL')
  if (!siteUrl) return `/game/${roomCode}`
  try {
    return `${new URL(siteUrl).origin}/game/${roomCode}`
  } catch {
    // Malformed SITE_URL secret — fall back to the relative path above.
    return `/game/${roomCode}`
  }
}

// Returns a lookup error to surface as a 500, so a broken subscriptions read
// shows up as a failed invocation rather than as silence; the sends themselves
// stay best-effort.
async function pushToUsers(supabase: SupabaseClient, userIds: string[], body: string, url: string): Promise<string | null> {
  if (userIds.length === 0) return null
  const { data: subscriptions, error } = await supabase.from('push_subscriptions').select('user_id, endpoint, p256dh, auth').in('user_id', userIds)
  if (error) return `subscriptions lookup failed: ${error.message}`

  await Promise.allSettled(
    ((subscriptions ?? []) as (PushSubscriptionRow & { user_id: string })[]).map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: 'Rise & Fall', body, url }),
        )
      } catch (err) {
        // A 404/410 means the browser dropped the subscription (uninstalled,
        // permission revoked, storage cleared) — clean it up so future turns
        // don't keep trying a dead endpoint. Any other error is best-effort.
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
        }
      }
    }),
  )
  return null
}

async function handleGameFinished(supabase: SupabaseClient, gameId: string): Promise<Response> {
  const { data: game } = await supabase.from('games').select('room_code, name, play_mode').eq('id', gameId).maybeSingle()
  // Live players watched it end over Realtime; hotseat is one shared device.
  if (!game || game.play_mode !== 'async') return new Response('not an async game', { status: 200 })

  const { data: players } = await supabase.from('players').select('user_id').eq('game_id', gameId)
  if (!players || players.length === 0) return new Response('no players', { status: 200 })

  const pushError = await pushToUsers(
    supabase,
    (players as { user_id: string }[]).map((p) => p.user_id),
    `${game.name} has finished!`,
    gameUrlFor(game.room_code),
  )
  if (pushError) return new Response(pushError, { status: 500 })
  return new Response('ok', { status: 200 })
}

Deno.serve(async (req) => {
  const expectedSecret = Deno.env.get('PUSH_NOTIFY_WEBHOOK_SECRET')
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
  if (payload.type !== 'UPDATE' || payload.table !== 'game_state' || !payload.record || !payload.old_record) {
    return new Response('ignored', { status: 200 })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // The write that completes a game leaves nobody pending, so these two
  // branches can't both have something to say about the same payload.
  if (justFinished(payload.old_record.state, payload.record.state)) {
    return handleGameFinished(supabase, payload.record.game_id)
  }

  const wasPending = new Set(pendingActorIds(payload.old_record.state))
  const nowPending = pendingActorIds(payload.record.state).filter((id) => !wasPending.has(id))
  if (nowPending.length === 0) {
    return new Response('no new pending players', { status: 200 })
  }

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

  const gameUrl = gameUrlFor(game.room_code)
  const phase = phaseLabel(payload.record.state)
  const round = payload.record.state.status === 'active' ? payload.record.state.turn : null
  const roundText = round === null ? '' : ` (Round ${round})`

  const { data: players, error: playersError } = await supabase.from('players').select('id, user_id').in('id', nowPending)
  if (playersError) return new Response(`players lookup failed: ${playersError.message}`, { status: 500 })
  if (!players || players.length === 0) return new Response('no matching players', { status: 200 })

  const body = `It's your turn to ${phase} in ${game.name}${roundText}.`
  const pushError = await pushToUsers(
    supabase,
    players.map((p) => p.user_id),
    body,
    gameUrl,
  )
  if (pushError) return new Response(pushError, { status: 500 })

  return new Response('ok', { status: 200 })
})
