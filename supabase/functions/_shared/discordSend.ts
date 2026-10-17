// Shared Discord delivery for every notify-discord-* function (issue #737).
//
// A player is reached by, in order:
//   1. a **DM from the notification bot** — when the `DISCORD_BOT_TOKEN`
//      secret is set and the player signed in with Discord (their Discord
//      snowflake comes from the OAuth identity, so they paste nothing);
//   2. their personal **webhook URL** (`profiles.discord_webhook_url`) — the
//      original mechanism, kept as a fallback for anyone the bot can't reach
//      (no shared server with the bot, DMs from server members turned off, no
//      Discord identity) and for games on a project with no bot configured.
//
// Discord only lets a bot open a DM with someone who shares a server with it,
// so players have to join the one (tiny, private) server the bot lives in.
//
// Best-effort and never throws: a failed send is reported in the returned
// outcome so callers can log it. Never log the bot token or a webhook URL.
//
// Relative imports in this graph need the explicit `.ts` extension (the Edge
// Runtime does not honor sloppy-imports) — there are none here on purpose.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export const WEBHOOK_URL_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/

const DISCORD_API = 'https://discord.com/api/v10'

export interface DiscordSendOutcome {
  /** Discord's HTTP status, or 'no-destination', 'invalid-webhook', 'fetch-error'. */
  result: number | string
  /** Which route delivered it (or was last tried). */
  via?: 'bot' | 'webhook'
  /** Discord's error body on a non-2xx, trimmed — it names the reason. */
  detail?: string
}

// Kept in sync with src/lib/discordNotify.ts's discordUserIdFromIdentities —
// this Edge Function graph can't import UI-adjacent files without extensions.
export function discordUserIdFromIdentities(identities: { provider: string; id: string }[] | null | undefined): string | null {
  return identities?.find((identity) => identity.provider === 'discord')?.id ?? null
}

/** The user's Discord snowflake, or null if they never signed in with Discord (or the lookup fails). */
export async function resolveDiscordUserId(supabase: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data } = await supabase.auth.admin.getUserById(userId)
    return discordUserIdFromIdentities(data?.user?.identities ?? null)
  } catch {
    return null
  }
}

async function failure(res: Response, via: 'bot' | 'webhook'): Promise<DiscordSendOutcome> {
  return { result: res.status, via, detail: (await res.text().catch(() => '')).slice(0, 200) }
}

async function sendBotDm(botToken: string, discordUserId: string, content: string): Promise<DiscordSendOutcome> {
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` }
    const channelRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ recipient_id: discordUserId }),
    })
    if (!channelRes.ok) return await failure(channelRes, 'bot')
    const channel = (await channelRes.json()) as { id?: string }
    if (!channel.id) return { result: 'fetch-error', via: 'bot', detail: 'no DM channel id returned' }
    const res = await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content }),
    })
    return res.ok ? { result: res.status, via: 'bot' } : await failure(res, 'bot')
  } catch (err) {
    return { result: 'fetch-error', via: 'bot', detail: String(err).slice(0, 200) }
  }
}

async function sendWebhook(webhookUrl: string, content: string): Promise<DiscordSendOutcome> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    return res.ok ? { result: res.status, via: 'webhook' } : await failure(res, 'webhook')
  } catch (err) {
    return { result: 'fetch-error', via: 'webhook', detail: String(err).slice(0, 200) }
  }
}

export async function sendDiscordToPlayer(params: {
  discordUserId: string | null
  webhookUrl: string | null | undefined
  content: string
}): Promise<DiscordSendOutcome> {
  const botToken = Deno.env.get('DISCORD_BOT_TOKEN')
  let botOutcome: DiscordSendOutcome | null = null
  if (botToken && params.discordUserId) {
    botOutcome = await sendBotDm(botToken, params.discordUserId, params.content)
    if (typeof botOutcome.result === 'number' && botOutcome.result >= 200 && botOutcome.result < 300) return botOutcome
  }

  if (params.webhookUrl) {
    if (!WEBHOOK_URL_PATTERN.test(params.webhookUrl)) return botOutcome ?? { result: 'invalid-webhook' }
    const webhookOutcome = await sendWebhook(params.webhookUrl, params.content)
    // If both routes failed, report the bot's outcome — it was the primary.
    const delivered = typeof webhookOutcome.result === 'number' && webhookOutcome.result >= 200 && webhookOutcome.result < 300
    return botOutcome && !delivered ? botOutcome : webhookOutcome
  }
  return botOutcome ?? { result: 'no-destination' }
}

/** True when a player could be reached by *some* route — lets callers skip the auth lookup for nobody. */
export function hasDestination(webhookUrl: string | null | undefined): boolean {
  return Boolean(Deno.env.get('DISCORD_BOT_TOKEN')) || Boolean(webhookUrl)
}
