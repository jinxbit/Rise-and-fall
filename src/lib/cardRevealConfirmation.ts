/**
 * A per-account preference (issue #528, `ProfilePreferences.confirmBeforeRevealingCards`
 * in dbTypes.ts): whether RoundView.tsx should hold a player's own pick
 * behind a "Reveal all cards" button when it's the one that would resolve
 * the select-cards or decline phase, instead of revealing every player's
 * simultaneous choice the instant they click. Defaults to on — a wrong
 * guess here can't be taken back once the reveal happens, so the safer
 * default is to ask first.
 */
export const DEFAULT_CONFIRM_BEFORE_REVEALING_CARDS = true

/** A profile's raw stored value (or unset) collapsed to the effective setting — unset falls back to the default, same null-collapsing pattern as resolveUnitReserveDisplayMode. */
export function resolveConfirmBeforeRevealingCards(value: boolean | null | undefined): boolean {
  return value ?? DEFAULT_CONFIRM_BEFORE_REVEALING_CARDS
}
