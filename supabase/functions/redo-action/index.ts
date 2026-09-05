// RULE_ENFORCEMENT_PLAN.md §8 phase 6 — redo's mirror of undo-action/
// index.ts; see that file's doc comment (and apply-action/index.ts's) for
// the shared background. Same authorization (any seated player, or the room
// owner/an admin — no per-seat ownership check, no owner-override), same
// genesis-replay approach, same no-payload request body.
import { applyRedoAction } from '../../../src/engine/undoRedo.ts'
import {
  buildGenesisState,
  corsHeaders,
  getCallerUserId,
  jsonResponse,
  loadFullGameAndPlayers,
  loadGameContext,
  serviceRoleClient,
  writeGameStateCAS,
} from '../_shared/gameEnforcement.ts'

interface RedoActionRequest {
  gameId: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const callerUserId = await getCallerUserId(req)
  if (!callerUserId) return jsonResponse(401, { ok: false, error: 'Not authenticated.' })

  let body: RedoActionRequest
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

  const isSeated = ctx.players.some((p) => p.user_id === callerUserId)
  if (!isSeated && !ctx.isOwnerOrAdmin) {
    return jsonResponse(403, { ok: false, error: 'Only a seated player (or the room owner/an admin) may redo.' })
  }

  const genesisInputs = await loadFullGameAndPlayers(supabase, gameId)
  if (!genesisInputs) return jsonResponse(404, { ok: false, error: 'Game not found.' })
  const genesis = buildGenesisState(genesisInputs.game, genesisInputs.players)

  const callerPlayerId = ctx.players.find((p) => p.user_id === callerUserId)?.id ?? null

  const result = applyRedoAction(genesis, ctx.gameState.state, callerPlayerId)
  if (!result.ok) return jsonResponse(400, { ok: false, error: result.error })

  const newVersion = await writeGameStateCAS(supabase, gameId, result.state, ctx.gameState.version)
  if (newVersion === null) {
    return jsonResponse(409, { ok: false, error: 'Game state changed concurrently — refetch and retry.' })
  }

  return jsonResponse(200, { ok: true, state: result.state, version: newVersion })
})
