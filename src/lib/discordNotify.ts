// Discord "your turn" notifications. Each player pastes in their own
// webhook URL (src/components/DiscordWebhookSettings.tsx) — no bot install
// required. The actual "it's your turn" ping is sent server-side by the
// supabase/functions/notify-discord-turn Edge Function (triggered by a
// Database Webhook on game_state UPDATE, see that function's doc comment),
// using the service-role key to read the target player's webhook URL —
// browsers no longer need (or have RLS access) to read a co-player's
// webhook URL. `sendDiscordNotification` below still lives here for
// DiscordWebhookSettings.tsx's "Send test" button, which posts to the
// signed-in player's *own* webhook to confirm it's wired up correctly —
// that's not a leak since nothing about a co-player's webhook is exposed.

const WEBHOOK_URL_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/

export function isDiscordWebhookUrl(url: string): boolean {
  return WEBHOOK_URL_PATTERN.test(url.trim())
}

/**
 * A signed-in Supabase Auth user's Discord snowflake ID (for `<@id>` mentions),
 * taken from their Discord OAuth identity — `UserIdentity.id` is the provider's
 * own user ID, not Supabase's internal identity row ID. `null` if the user never
 * signed in with Discord (e.g. the guest auth bypass).
 *
 * Mirrored in supabase/functions/notify-discord-turn/index.ts, which can't
 * import from src/ — keep the two in sync if this ever changes.
 */
export function discordUserIdFromIdentities(identities: { provider: string; id: string }[] | null | undefined): string | null {
  return identities?.find((identity) => identity.provider === 'discord')?.id ?? null
}

// Mirrored in supabase/functions/notify-discord-turn/index.ts, which sends
// the real pings — that Edge Function can't import from src/, so keep the
// two in sync if this ever changes.
export function turnNotificationMessage(params: {
  displayName: string
  /** Discord snowflake ID to `@mention` (so the recipient is actually pinged), or null to fall back to the bold display name. */
  discordUserId: string | null
  roomName: string
  roomCode: string
  phase: string
  /** Round number, or null while still in board setup (pre-round 1, no round number to show). */
  round: number | null
  /** Deep link to the game, or null if the SITE_URL Edge Function secret isn't set — falls back to the room code. */
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

/**
 * Best-effort: a bad/deleted webhook or a network hiccup here should never
 * surface as an error to the player just trying to test their own webhook.
 */
export async function sendDiscordNotification(webhookUrl: string, content: string): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  } catch {
    // See doc comment above — swallow, don't propagate.
  }
}
