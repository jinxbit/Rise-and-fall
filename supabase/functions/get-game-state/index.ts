// HIDDEN_INFORMATION_PLAN.md §8 phase 5: the redacted read path opposite
// apply-action/undo-action/redo-action's write-side enforcement (see
// apply-action/index.ts's doc comment for the shared architecture
// background). §10 there originally framed this as an open question between
// a plain SQL/plpgsql `get_game_state` RPC (§5.1/§5.2's original framing)
// and an Edge Function reusing src/engine/'s redaction unmodified — resolved
// in favor of the Edge Function, both because it's what §10 itself already
// leaned toward ("reuse src/engine/ unmodified, no rule-logic duplication")
// and because §5.3's reveal high-water mark (the thing that would have
// forced a full engine replay even for a "just field-nulling" read) was
// dropped the same day (see redaction.ts's doc comment on
// redactStateForPlayer) — so this ended up a straight reuse of
// redactStateForPlayer against the live state, no replay needed either way.
//
// Unlike apply-action/undo-action/redo-action, this is a read: no
// compare-and-swap, no `action.playerId` authorization — the check here is
// "is this caller entitled to read this game's state at all" (canReadGameState,
// mirroring game_state's current SELECT RLS policies, which this function's
// service-role client otherwise bypasses entirely), then which *view* of it
// they get: a `profiles.is_admin` caller, or anyone reading a game that
// isn't both ruleEnforcementEnabled and opted into
// GameSettings.hiddenInformationEnabled, or hotseat (one shared auth.uid()
// across every local seat — see below), gets revealedGameStateView — the
// same RedactedGameState *shape* redactStateForPlayer returns, but with
// nothing actually masked (§4.5's admin carve-out — otherwise admin mode
// couldn't act on a still-secret in-progress choice it can't see). A seated
// player in a hidden-information game gets redactStateForPlayer keyed to
// their own seat, and anyone else entitled to read at all — including the
// room owner, who is NOT trusted with another player's hidden information
// just for having created the room (issue #450) — gets it keyed to no seat
// at all, i.e. everything currently secret from every player.
//
// redactStateForPlayer also redacts `actionHistory` itself, not just the
// derived chosenCardIdByPlayerId/declineCardIds fields above — see its own
// doc comment (redaction.ts) for why the raw log needed the same treatment.
//
// gameApi.ts's getGameStateRedacted (RULE_ENFORCEMENT_PLAN.md §8 phase 8)
// only actually calls this for a ruleEnforcementEnabled game that also
// opted into GameSettings.hiddenInformationEnabled — every other game keeps
// reading the `game_state` row directly via RLS, completely unaffected, so
// this function's own behavior for the not-opted-in/hotseat/admin cases
// above matters only for callers that go out of their way to invoke it
// directly (e.g. this file's own test suite, or the admin room-configuration
// panel), not for gameApi.ts's actual routing decision. Always returning the
// same RedactedGameState *shape* regardless of whether anything's actually
// masked (revealedGameStateView) keeps that decision simple on the rare
// caller that does hit both branches, rather than making them sniff which
// shape came back.
//
// Request body: `{ gameId: string, sinceActionIndex?: number }` — a read, so
// no action payload; `sinceActionIndex` is the bandwidth optimization below.
//
// Incremental actionHistory (issue #647): `actionHistory` is 60-70% of a raw
// GameState's bytes (see the issue for measurements), yet a client that
// already has a prefix of it only ever needs the handful of entries logged
// since its last fetch — every submitted action is exactly one new
// `actionHistory` entry (CLAUDE.md invariant 4), and per `unredactedPrefix`'s
// own doc comment (redaction.ts) the safe-to-show prefix a client ends up
// with only ever grows, never rewrites in place. So a client that already
// holds `N` entries can name that in `sinceActionIndex` and get back just the
// entries after it, rather than the whole array again — `respondWithState`
// below does this by reusing `unredactedPrefix` (unmodified, same function
// `toClientGameState` runs client-side) to find the current safe-prefix
// length and slicing from there.
//
// A `sinceActionIndex` that isn't within `[0, safePrefixLength]` (including
// "not present at all") falls back to today's full response byte-for-byte —
// this makes the feature strictly per-request: gameApi.ts's
// getGameStateRedacted only sends it once it has a previous state to splice
// onto, and any inconsistency (a stale cache, a different game, a client
// bug) just costs one extra full response rather than a wrong splice.
//
// Patched stateWithoutHistory (issue #648): actionHistory was #647's whole
// scope — everything else in a RedactedGameState (the board, achievements,
// resources, ...) was still sent in full on every request, even though it
// plateaus early and barely changes move to move. Request body grows a
// second field, `baseVersion` — the actual `game_state.version` the caller's
// `previous` state came from (gameApi.ts's getGameStateRedacted sends
// whatever version it last applied `previous` at). This can NOT be derived
// from `sinceActionIndex` alone: `sinceActionIndex` is the caller's own safe
// (post-`unredactedPrefix`) actionHistory length, which understates the raw
// version whenever some *other* player's pick was still masked from this
// caller as of `previous` — the masked entry (and the version it landed at)
// is real and buffered, just not something this caller's own truncated log
// ever counted. `respondWithState` uses `baseVersion` to ask
// `loadBufferedGameState` (../_shared/gameEnforcement.ts) for the actual
// GameState at that version — a small rolling buffer maintained alongside
// every `writeGameStateCAS` write (0036_game_state_snapshots.sql) — redacts
// it for this same caller, and *verifies* that redaction's own safe-prefix
// length agrees with the caller's stated `sinceActionIndex` before trusting
// it as a diff base (a stale cache, a lie, or any other inconsistency just
// falls back to the old plain-`state` behavior for that one request, per
// this function's existing "any inconsistency -> full response" posture).
// Only once verified does it hand both views to `buildRedactedGameStateDelta`
// (src/engine/redaction.ts), which diffs them into a `statePatch` instead of
// resending `state` whole. A buffer miss (a base version older than the
// buffer covers, or no `baseVersion` sent at all) degrades the same way; the
// `actionHistoryAppend` half of the response is unaffected either way. This
// is still exactly the "straight reuse of redactStateForPlayer against a
// materialised state, no replay" shape this function's opening paragraph
// describes — `loadBufferedGameState` supplies an *older* materialised state
// to also call it against, nothing more; see redactStateForPlayer's own doc
// comment for why HIDDEN_INFORMATION_PLAN.md §5.3's reveal high-water mark
// stays dropped rather than revived for this.
import { buildRedactedGameStateDelta, redactStateForPlayer, revealedGameStateView, unredactedPrefix, type RedactedGameState } from '../../../src/engine/redaction.ts'
import {
  canReadGameState,
  corsHeaders,
  getCallerUserId,
  jsonResponse,
  loadBufferedGameState,
  loadGameContext,
  serviceRoleClient,
} from '../_shared/gameEnforcement.ts'
import type { GameState } from '../../../src/engine/types.ts'
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

interface GetGameStateRequest {
  gameId: string
  sinceActionIndex?: number
  /** The actual `game_state.version` `sinceActionIndex` was computed from — see the module doc comment above for why this can't be derived from `sinceActionIndex` alone. */
  baseVersion?: number
}

/**
 * Builds this function's response for a given (already redacted-or-not)
 * current state view — see the module doc comment above for why
 * `sinceActionIndex` only ever changes the response when it's a valid index
 * into the current safe actionHistory prefix, and falls back to the full
 * `view` otherwise.
 *
 * `redact` is the same per-viewer function (`revealedGameStateView` or
 * `redactStateForPlayer` bound to this caller's seat) already used to
 * produce `view` — passed through so a buffered earlier `GameState`
 * (issue #648, `loadBufferedGameState`, keyed by `baseVersion`) can be
 * redacted for the *same* viewer before `buildRedactedGameStateDelta` diffs
 * the two. Its own safe-prefix length is then checked against the caller's
 * stated `sinceActionIndex` before it's trusted as a diff base — a mismatch
 * means `baseVersion` doesn't actually correspond to the `previous` state
 * `sinceActionIndex` was computed from (a stale/foreign cache, or worse), so
 * treating it as a buffer miss (never as something to patch against) is the
 * safe response either way. A miss still gets the `actionHistoryAppend` half
 * of the win — only the `stateWithoutHistory` patch degrades to a plain,
 * un-patched value for that one request.
 */
async function respondWithState(
  supabase: SupabaseClient,
  gameId: string,
  redact: (state: GameState) => RedactedGameState,
  view: RedactedGameState,
  version: number,
  sinceActionIndex: number | undefined,
  baseVersion: number | undefined,
) {
  if (typeof sinceActionIndex === 'number' && Number.isInteger(sinceActionIndex) && sinceActionIndex >= 0) {
    const safePrefixLength = unredactedPrefix(view.actionHistory).length
    if (sinceActionIndex <= safePrefixLength) {
      let previousView: RedactedGameState | null = null
      if (typeof baseVersion === 'number' && Number.isInteger(baseVersion) && baseVersion >= 0) {
        const previousState = await loadBufferedGameState(supabase, gameId, baseVersion)
        if (previousState) {
          const candidateView = redact(previousState)
          if (unredactedPrefix(candidateView.actionHistory).length === sinceActionIndex) previousView = candidateView
        }
      }
      const delta = buildRedactedGameStateDelta(previousView, view, sinceActionIndex)
      return jsonResponse(200, { ok: true, ...delta, version })
    }
  }
  return jsonResponse(200, { ok: true, state: view, version })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const callerUserId = await getCallerUserId(req)
  if (!callerUserId) return jsonResponse(401, { ok: false, error: 'Not authenticated.' })

  let body: GetGameStateRequest
  try {
    body = await req.json()
  } catch {
    return jsonResponse(400, { ok: false, error: 'Invalid JSON body.' })
  }
  const { gameId, sinceActionIndex, baseVersion } = body
  if (!gameId) return jsonResponse(400, { ok: false, error: 'Request body must be { gameId }.' })

  const supabase = serviceRoleClient()
  const ctx = await loadGameContext(supabase, gameId, callerUserId)
  if (!ctx) return jsonResponse(404, { ok: false, error: 'Game not found, or has no state yet (still in the lobby?).' })

  if (!canReadGameState(ctx, callerUserId)) {
    return jsonResponse(403, { ok: false, error: 'You may not view this game.' })
  }

  // Opt-in (GameSettings.hiddenInformationEnabled, carried onto GameState at
  // genesis — see its own doc comment): every game that existed before this
  // flag, or didn't check the box, gets the same response shape but with
  // nothing actually masked, same as the admin/hotseat carve-outs below —
  // this function becomes the sole read path for every ruleEnforcementEnabled
  // game (gameApi.ts), not just ones that opted into redaction.
  //
  // Hotseat is also never redacted regardless of the flag: one shared
  // `auth.uid()` covers every local seat (HIDDEN_INFORMATION_PLAN.md §2), so
  // `callerPlayerId` below would resolve to whichever seat happens to come
  // first in `ctx.players` — meaningless for per-seat masking, and actively
  // wrong (it would hide a local player's own pick from the very device
  // they're using to make it).
  const shouldRedact = ctx.gameState.state.hiddenInformationEnabled && ctx.game.play_mode !== 'hotseat'

  if (ctx.isAdmin || !shouldRedact) {
    return await respondWithState(supabase, gameId, revealedGameStateView, revealedGameStateView(ctx.gameState.state), ctx.gameState.version, sinceActionIndex, baseVersion)
  }

  const callerPlayerId = ctx.players.find((p) => p.user_id === callerUserId)?.id ?? null
  const redact = (s: GameState) => redactStateForPlayer(s, callerPlayerId)
  return await respondWithState(supabase, gameId, redact, redact(ctx.gameState.state), ctx.gameState.version, sinceActionIndex, baseVersion)
})
