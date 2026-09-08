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
// they get: a `profiles.is_admin` caller gets the raw, unredacted state
// (§4.5's admin carve-out — otherwise admin mode couldn't act on a
// still-secret in-progress choice it can't see), a seated player gets
// redactStateForPlayer keyed to their own seat, and anyone else entitled to
// read at all — including the room owner, who is NOT trusted with another
// player's hidden information just for having created the room (issue #450)
// — gets it keyed to no seat at all, i.e. everything currently secret from
// every player.
//
// redactStateForPlayer also redacts `actionHistory` itself (2026-09-08),
// not just the derived chosenCardIdByPlayerId/declineCardIds fields above —
// see its own doc comment (redaction.ts) for why the raw log needed the
// same treatment. Still not the sole read path yet: gameApi.ts's
// getGameState() itself still reads the raw game_state row directly for
// every game (RULE_ENFORCEMENT_PLAN.md §8 phase 8's still-outstanding
// client rewire), so this is landing ahead of, and unconsumed by, that
// rewire — the same safe-to-merge-early pattern this function's own initial
// version (phase 5) already followed.
//
// Request body: `{ gameId: string }` — a read, so no action payload.
import { redactStateForPlayer } from '../../../src/engine/redaction.ts'
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

  if (ctx.isAdmin) {
    return jsonResponse(200, { ok: true, state: ctx.gameState.state, version: ctx.gameState.version })
  }

  const callerPlayerId = ctx.players.find((p) => p.user_id === callerUserId)?.id ?? null
  const state = redactStateForPlayer(ctx.gameState.state, callerPlayerId)
  return jsonResponse(200, { ok: true, state, version: ctx.gameState.version })
})
