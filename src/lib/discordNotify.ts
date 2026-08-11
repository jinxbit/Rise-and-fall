// Discord "your turn" notifications. Each player pastes in their own
// webhook URL (src/components/DiscordWebhookSettings.tsx) — no bot install
// or server-side integration required. Since this app has no backend
// beyond Supabase (see README), notifications are posted directly from
// whichever browser triggered the turn change straight to Discord's
// webhook endpoint, which allows cross-origin POSTs from a browser.

const WEBHOOK_URL_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/

export function isDiscordWebhookUrl(url: string): boolean {
  return WEBHOOK_URL_PATTERN.test(url.trim())
}

export function turnNotificationMessage(params: { roomCode: string; displayName: string }): string {
  return `**${params.displayName}**, it's your turn in Rise & Fall! Room \`${params.roomCode}\`.`
}

/**
 * Best-effort: a bad/deleted webhook, an offline player, or a network
 * hiccup here should never block or surface an error on the game action
 * that triggered it — this is a nice-to-have nudge, not part of the
 * write path that actually has to succeed.
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
