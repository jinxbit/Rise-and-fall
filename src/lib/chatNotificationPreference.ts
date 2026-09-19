/**
 * A per-account preference (issue #658, `ProfilePreferences.chatNotificationsEnabled`
 * in dbTypes.ts): whether posting a message in a game's chat should trigger
 * the existing Discord webhook / Web Push notification for the game's other
 * seated players (`supabase/functions/notify-discord-chat`,
 * `notify-web-push-chat`) — see CHAT_PLAN.md §20. Originally defaulted to
 * **off** (issue #658): those two channels already ping on every turn/
 * lifecycle event with no per-event toggle, so a player who set either up
 * for that purpose would otherwise start getting a ping per chat message
 * with no way to have opted out in advance. Issue #668 flips the default to
 * **on** instead — most players want to hear about chat, and requiring an
 * opt-in was hiding the feature from them; a player who wants turn pings
 * without chat noise can still opt out on the Profile page. The preference
 * is resolved from the stored value at read time rather than stamped in at
 * profile creation, so the new default applies uniformly to every profile,
 * old or new — there is no old-row/new-row split to preserve here (unlike
 * `ruleEnforcementEnabled`).
 */
export const DEFAULT_CHAT_NOTIFICATIONS_ENABLED = true

/** A profile's raw stored value (or unset) collapsed to the effective setting — unset falls back to the default, same null-collapsing pattern as resolveConfirmBeforeRevealingCards. */
export function resolveChatNotificationsEnabled(value: boolean | null | undefined): boolean {
  return value ?? DEFAULT_CHAT_NOTIFICATIONS_ENABLED
}
