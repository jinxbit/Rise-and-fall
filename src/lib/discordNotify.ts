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
 * `phase` is a short human label for what the player needs to do (e.g.
 * "select a card", "place a tile") — see phaseLabel() in the Edge Function,
 * which is the only place GameState is available to derive it from.
 * `gameUrl` is omitted (not just blank) when unknown, so the message stays
 * concise instead of printing a placeholder link.
 */
export function turnNotificationMessage(params: {
  roomCode: string
  roomName: string
  displayName: string
  phase: string
  gameUrl?: string
}): string {
  const link = params.gameUrl ? `\n${params.gameUrl}` : ` (\`${params.roomCode}\`)`
  return `**${params.displayName}**, it's your turn to **${params.phase}** in **${params.roomName}**.${link}`
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
