/**
 * A per-account preference (issue #658, `ProfilePreferences.chatNotificationsEnabled`
 * in dbTypes.ts): whether posting a message in a game's chat should trigger
 * the existing Discord webhook / Web Push notification for the game's other
 * seated players (`supabase/functions/notify-discord-chat`,
 * `notify-web-push-chat`) — see CHAT_PLAN.md §20. Defaults to **off**, unlike
 * `confirmBeforeRevealingCards`'s default-on: those two existing channels
 * already ping on every turn/lifecycle event with no per-event toggle, so a
 * player who set either up for that purpose would otherwise start getting a
 * ping per chat message with no way to have opted out in advance.
 */
export const DEFAULT_CHAT_NOTIFICATIONS_ENABLED = false

/** A profile's raw stored value (or unset) collapsed to the effective setting — unset falls back to the default, same null-collapsing pattern as resolveConfirmBeforeRevealingCards. */
export function resolveChatNotificationsEnabled(value: boolean | null | undefined): boolean {
  return value ?? DEFAULT_CHAT_NOTIFICATIONS_ENABLED
}
