/**
 * The gap between "the state as of the last action a viewer is allowed to
 * see" and "the state as that viewer is allowed to see it now".
 *
 * `unredactedPrefix` (./redaction.ts) truncates a viewer's `actionHistory` at
 * the first entry that isn't safe for them, so a client replaying everything
 * it holds lands *before* any still-unresolved simultaneous phase. The server's
 * redacted view is further on: it knows an opponent has chosen, even while
 * withholding what. Those two states differ, so a client that rebuilt the
 * state from actions alone would fail its hash check on every read taken
 * mid-phase — which is most reads — and fall back to a full fetch every time.
 *
 * This module is what closes that gap: a bounded projection of the fields
 * that an unresolved phase can move, sent alongside the actions so the client
 * can finish the job.
 *
 * WHY THIS LIST, AND WHY IT IS NOT GUESSED: the fields below were measured,
 * not reasoned about — every state of every fixture in
 * src/test/fixtures/productionGames/, from every seat (2287 comparisons),
 * diffing a replay of the safe prefix against the redacted view. An earlier
 * hand-written guess at "obviously phase-related fields" missed
 * `units`, `resourceBank`, `idSequence`, `claimedByAchievementId`,
 * `declineSourceZoneByCardId` and `achievementsClaimedThisRound`, all of which
 * a mid-flight purchase moves. `inFlightOverlay.test.ts` re-runs that
 * measurement and fails if any field outside this list ever diverges, so the
 * list cannot quietly rot as the rules grow.
 *
 * `board` and `cards` are deliberately absent: they never diverged, and they
 * are the expensive half of a `GameState`. Keeping them out is most of the
 * point.
 *
 * AN INCOMPLETE LIST IS A PERFORMANCE BUG, NOT A CORRECTNESS ONE. If a future
 * rules change moves a field that isn't here, the client's hash will not match
 * the server's and it will fetch in full — the same thing it does for a stale
 * cache. That is the property that makes a fixed list acceptable at all.
 */
import type { GameState } from './types.ts'

/**
 * Sent whole, or not at all. The server has no cheap way to know *which* of
 * these actually moved (that would need the pre-phase state, i.e. the replay
 * this design exists to avoid), so it sends the set when `needsInFlightOverlay`
 * below says a viewer's replay cannot reach their view, and omits it entirely
 * otherwise — which measured as the large majority of reads.
 */
export const IN_FLIGHT_OVERLAY_FIELDS = [
  'status',
  'roundPhase',
  'turn',
  'activePlayerId',
  'turnOrder',
  'pendingPlayerIds',
  'chosenCardIdByPlayerId',
  'players',
  'declineSourceZoneByCardId',
  'resourceBank',
  'units',
  'idSequence',
  'claimedByAchievementId',
  'achievementsClaimedThisRound',
] as const satisfies readonly (keyof GameState)[]

export type InFlightOverlay = Partial<Pick<GameState, (typeof IN_FLIGHT_OVERLAY_FIELDS)[number]>>

/**
 * Whether a viewer's own replay can reach their view unaided. Two separate
 * reasons it cannot, and missing either one sends a client into a hash
 * mismatch and a full fetch:
 *
 * 1. **The safe prefix lags the log.** An unresolved simultaneous phase has
 *    masked entries, `unredactedPrefix` cuts before them, and the viewer's
 *    replay stops short of now. This is the obvious case.
 * 2. **Redaction masked a field whose action is nonetheless visible.**
 *    `redactStateForPlayer` hides `chosenCardIdByPlayerId` for every
 *    non-viewer whenever `hideChosenCards` holds, but hides the matching
 *    `CHOOSE_CARD` *log entry* only when `entry.turn === state.turn`. A pick
 *    carried over from an earlier turn is therefore readable in the log and
 *    masked in the field: the viewer's replay reconstructs the real card id
 *    while their view says `null`, with no prefix lag at all. Measured at
 *    roughly 5% of reads across the recorded games — small, and fatal to the
 *    hash check if unhandled.
 *
 * Only `chosenCardIdByPlayerId` and `players` need comparing for (2):
 * `redactStateForPlayer` returns `{ ...state, chosenCardIdByPlayerId, players,
 * actionHistory }`, so they are the only fields masking can rewrite.
 */
export function needsInFlightOverlay(trueState: GameState, view: GameState): boolean {
  if (view.actionHistory.length < trueState.actionHistory.length) return true
  if (JSON.stringify(view.chosenCardIdByPlayerId) !== JSON.stringify(trueState.chosenCardIdByPlayerId)) return true
  return JSON.stringify(view.players) !== JSON.stringify(trueState.players)
}

/** Projects the overlay fields out of a viewer's current view, for the wire. */
export function buildInFlightOverlay(view: GameState): InFlightOverlay {
  const overlay: Record<string, unknown> = {}
  for (const field of IN_FLIGHT_OVERLAY_FIELDS) {
    const value = view[field]
    if (value !== undefined) overlay[field] = value
  }
  return overlay as InFlightOverlay
}

/**
 * Lays the overlay over a state the client rebuilt by replay. `undefined`
 * (nothing in flight) returns `base` unchanged, by reference — the common
 * case, and the one where the client's replay already *is* the answer.
 */
export function applyInFlightOverlay(base: GameState, overlay: InFlightOverlay | undefined): GameState {
  if (!overlay) return base
  return { ...base, ...overlay }
}
