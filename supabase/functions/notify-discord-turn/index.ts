// Sends "it's your turn" Discord pings for async games. Runs server-side
// (Supabase Edge Function) instead of a player's browser — see
// src/lib/discordNotify.ts and README.md's "Discord turn notifications"
// section for why this moved off the client (webhook URLs no longer need
// to be readable by co-players, and the ping no longer depends on a
// browser tab staying open after the triggering write).
//
// Trigger: a Supabase Database Webhook on `game_state` UPDATE (registered by
// the Set Up Discord Notifications workflow, see README) POSTs the standard
// Database Webhook payload here — `{ type: 'UPDATE', table: 'game_state',
// record, old_record }` — with `record`/`old_record` being the new/old
// game_state rows. Configure the webhook to send a custom header
// `x-webhook-secret: <a random value>` and set that same value as this
// function's `DISCORD_NOTIFY_WEBHOOK_SECRET` secret, so this endpoint can't
// be triggered by anyone who finds the URL.
//
// That one webhook feeds two different pings. Besides "it's your turn", this
// function also sends the **game finished** lifecycle ping, because a game
// finishing *is* a `game_state` UPDATE — same table, same event, same
// payload. It lived in notify-discord-lifecycle at first (issue #77), which
// meant a second hook and a second function invocation on every action write
// in every game to catch the one write per game that completes it. The other
// three lifecycle events are on other tables and are still that function's;
// see its doc comment, and todo.md #100 for the fold.
//
// `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are provided automatically
// in the Edge Function runtime — the service-role key is what lets this
// read any player's `profiles.discord_webhook_url` regardless of RLS
// (0013_discord_notify_backend.sql drops the old co-player-read policy,
// since browsers no longer need that access), and lets it call
// `auth.admin.getUserById` to resolve each player's Discord snowflake ID
// (from their Discord OAuth identity) so the ping can `@mention` them —
// a plain name in a webhook message doesn't actually notify anyone.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

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
  /** "Build alone" map mode (GameSettings.soloBuildMap) — see src/engine/types.ts's BoardSetupState.builderId doc comment. */
  builderId?: string | null
}

type RoundPhase = 'selectCards' | 'actions' | 'decline' | 'purchase'

interface GameState {
  status: 'lobby' | 'boardSetup' | 'active' | 'completed'
  turnOrder: string[]
  boardSetup: BoardSetupState | null
  activePlayerId: string | null
  pendingPlayerIds: string[]
  /** Round number — increments each time a round finishes (see src/engine/round.ts). */
  turn: number
  roundPhase: RoundPhase
}

function currentTilePlacerId(state: GameState): string | null {
  const boardSetup = state.boardSetup
  if (state.status !== 'boardSetup' || !boardSetup || boardSetup.tileTierQueue.length === 0) return null
  if (boardSetup.builderId) return boardSetup.builderId
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

// A game_state UPDATE that moves the state to `completed` is the "game
// finished" event. `status` is one of the fields gameStateCompression.ts
// duplicates in plaintext alongside a rule-enforced game's gzipped state, so
// this reads correctly on both write paths without decompressing anything.
function justFinished(oldState: GameState, newState: GameState): boolean {
  return oldState.status !== 'completed' && newState.status === 'completed'
}

// --- Human-readable phase label, mirrors src/lib/discordNotify.ts's ---
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

// --- Discord ---

// SITE_URL is an optional secret (supabase secrets set SITE_URL=...) — without
// it the message falls back to showing the room code instead of a clickable link.
// Only the origin is used, so a value that's accidentally a full page URL (e.g.
// copy-pasted from the browser while testing, like https://site.example/lobby/AB12)
// still produces a correct link instead of nesting that path into the game URL.
function gameUrlFor(roomCode: string): string | null {
  const siteUrl = Deno.env.get('SITE_URL')
  if (!siteUrl) return null
  try {
    return `${new URL(siteUrl).origin}/game/${roomCode}`
  } catch {
    // Malformed SITE_URL secret — fall back to the room code rather than emitting a broken link.
    return null
  }
}

const WEBHOOK_URL_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/

// Kept in sync with src/lib/discordNotify.ts's turnNotificationMessage — see
// that file's doc comment for why this Edge Function can't just import it.
function turnNotificationMessage(params: {
  displayName: string
  discordUserId: string | null
  roomName: string
  roomCode: string
  phase: string
  round: number | null
  gameUrl: string | null
}): string {
  const roundText = params.round === null ? '' : ` (Round ${params.round})`
  // With a game link, the room name itself becomes the link instead of pasting
  // the raw URL below — without one, fall back to the room code on its own line.
  const roomName = params.gameUrl ? `[${params.roomName}](${params.gameUrl})` : params.roomName
  const fallback = params.gameUrl ? '' : `\nRoom \`${params.roomCode}\``
  const mention = params.discordUserId ? `<@${params.discordUserId}>` : `**${params.displayName}**`
  return `**Rise & Fall** — ${mention}, it's your turn to **${params.phase}** in **${roomName}**${roundText}.${fallback}`
}

// Kept in sync with src/lib/discordNotify.ts's discordUserIdFromIdentities —
// see that file's doc comment for why this Edge Function can't just import it.
function discordUserIdFromIdentities(identities: { provider: string; id: string }[] | null | undefined): string | null {
  return identities?.find((identity) => identity.provider === 'discord')?.id ?? null
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

// Identical wording to the version this replaces in notify-discord-lifecycle,
// which still sends the other three lifecycle pings.
function roomText(name: string, roomCode: string, url: string | null): string {
  return url ? `[${name}](${url})` : `**${name}** (room \`${roomCode}\`)`
}

async function handleGameFinished(supabase: SupabaseClient, gameId: string): Promise<Response> {
  const { data: game } = await supabase.from('games').select('room_code, name, play_mode').eq('id', gameId).maybeSingle()
  // Live players watched it end over Realtime; hotseat is one shared device.
  // Same async-only rule as the turn ping below.
  if (!game || game.play_mode !== 'async') return new Response('not an async game', { status: 200 })

  const { data: players } = await supabase.from('players').select('user_id').eq('game_id', gameId)
  if (!players || players.length === 0) return new Response('no players', { status: 200 })

  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, discord_webhook_url')
    .in(
      'user_id',
      players.map((p: { user_id: string }) => p.user_id),
    )

  const message = `**Rise & Fall** — ${roomText(game.name, game.room_code, gameUrlFor(game.room_code))} has finished!`
  await Promise.allSettled(
    ((profiles ?? []) as { user_id: string; discord_webhook_url: string | null }[]).map((profile) => {
      const webhookUrl = profile.discord_webhook_url
      if (!webhookUrl || !WEBHOOK_URL_PATTERN.test(webhookUrl)) return Promise.resolve()
      return sendDiscordNotification(webhookUrl, message)
    }),
  )
  return new Response('ok', { status: 200 })
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
    players.map(async (player) => {
      const webhookUrl = webhookByUserId.get(player.user_id)
      if (!webhookUrl || !WEBHOOK_URL_PATTERN.test(webhookUrl)) return

      // Look up the player's Discord snowflake ID so the ping can @mention them
      // (a plain name in a webhook message doesn't notify anyone) — falls back
      // to the bold display name if the lookup fails or they never signed in
      // with Discord (e.g. the guest auth bypass).
      const { data: authUser } = await supabase.auth.admin.getUserById(player.user_id)
      const discordUserId = discordUserIdFromIdentities(authUser?.user?.identities ?? null)

      return sendDiscordNotification(
        webhookUrl,
        turnNotificationMessage({
          displayName: player.display_name,
          discordUserId,
          roomName: game.name,
          roomCode: game.room_code,
          phase,
          round,
          gameUrl,
        }),
      )
    }),
  )

  return new Response('ok', { status: 200 })
})
