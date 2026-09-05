// RULE_ENFORCEMENT_PLAN.md §8 phase 6: the first of three Edge Functions
// (with undo-action/redo-action) that stop trusting client-submitted
// GameState — see that document's §3 for why Edge Functions over a
// standalone backend, and §4 for the enforcement model this implements.
// Most of the actual logic (seat resolution, the §4.1/§4.4/§4.5
// authorization checks, content resolution, the compare-and-swap write) is
// shared with the other two functions — see ../_shared/gameEnforcement.ts,
// including that file's own doc comment on what couldn't be verified in the
// sandbox this was written in (no Deno CLI, no live Supabase project).
//
// Deliberately does NOT flip game_state's RLS to service-role-only (§6:
// that's phase 8, landing together with gameApi.ts's rewire) — clients can
// still write game_state directly today. This function becomes the sole
// legitimate writer only once phase 8 rewires the client and locks RLS down;
// until then, deploying it is additive and inert unless something actually
// calls it.
//
// Request body: `{ gameId: string, action: Action }` (see
// src/engine/actions.ts for Action's shape). UNDO_ACTION/REDO_ACTION are
// rejected here (same as applyAction() itself) — submit those to
// undo-action/redo-action instead, which replay from genesis rather than
// stepping forward.
import type { Action } from '../../../src/engine/actions.ts'
import {
  applyActionFullyEnforced,
  corsHeaders,
  getCallerUserId,
  isAuthorizedToActAs,
  jsonResponse,
  loadGameContext,
  requiresOwnerOverride,
  serviceRoleClient,
  writeGameStateCAS,
} from '../_shared/gameEnforcement.ts'

interface ApplyActionRequest {
  gameId: string
  action: Action
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const callerUserId = await getCallerUserId(req)
  if (!callerUserId) return jsonResponse(401, { ok: false, error: 'Not authenticated.' })

  let body: ApplyActionRequest
  try {
    body = await req.json()
  } catch {
    return jsonResponse(400, { ok: false, error: 'Invalid JSON body.' })
  }
  const { gameId, action } = body
  if (!gameId || !action || typeof action.type !== 'string') {
    return jsonResponse(400, { ok: false, error: 'Request body must be { gameId, action }.' })
  }
  if (action.type === 'UNDO_ACTION' || action.type === 'REDO_ACTION') {
    return jsonResponse(400, { ok: false, error: `${action.type} must be submitted via the undo-action/redo-action functions, not apply-action.` })
  }

  const supabase = serviceRoleClient()
  const ctx = await loadGameContext(supabase, gameId, callerUserId)
  if (!ctx) return jsonResponse(404, { ok: false, error: 'Game not found, or has no state yet (still in the lobby?).' })

  if (!isAuthorizedToActAs(ctx, callerUserId, action.playerId)) {
    return jsonResponse(403, { ok: false, error: "You may not submit an action on another player's behalf." })
  }
  if (requiresOwnerOverride(ctx.gameState.state.actionHistory, action.playerId) && !ctx.isOwnerOrAdmin) {
    return jsonResponse(403, { ok: false, error: "Submitting this action would discard another player's undone move — only the room owner or an admin may do that." })
  }

  const result = applyActionFullyEnforced(ctx.gameState.state, action, ctx.players.length)
  if (!result.ok) return jsonResponse(400, { ok: false, error: result.error })

  const newVersion = await writeGameStateCAS(supabase, gameId, result.state, ctx.gameState.version)
  if (newVersion === null) {
    return jsonResponse(409, { ok: false, error: 'Game state changed concurrently — refetch and retry.' })
  }

  return jsonResponse(200, { ok: true, state: result.state, version: newVersion })
})
