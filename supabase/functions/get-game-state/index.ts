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
// Request body: `{ gameId: string }` — a read, so no action payload.
import { redactStateForPlayer, revealedGameStateView } from '../../../src/engine/redaction.ts'
import { canReadGameState, corsHeaders, getCallerUserId, jsonResponse, loadGameContext, serviceRoleClient } from '../_shared/gameEnforcement.ts'

interface GetGameStateRequest {
  gameId: string
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
  const { gameId } = body
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
    return jsonResponse(200, { ok: true, state: revealedGameStateView(ctx.gameState.state), version: ctx.gameState.version })
  }

  const callerPlayerId = ctx.players.find((p) => p.user_id === callerUserId)?.id ?? null
  const state = redactStateForPlayer(ctx.gameState.state, callerPlayerId)
  return jsonResponse(200, { ok: true, state, version: ctx.gameState.version })
})
