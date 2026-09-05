// RULE_ENFORCEMENT_PLAN.md §8 phase 6 — see apply-action/index.ts's doc
// comment for the shared background (architecture decision, what couldn't
// be verified in this sandbox). This one and redo-action are simpler than
// apply-action: per §4.4, "undo/redo just move the pointer... safe to leave
// gated on any seated player of this game, at any time" — no per-seat
// ownership check on `action.playerId` (it's narration-only, never checked
// for legality — see UndoAction's doc comment in src/engine/actions.ts), and
// no owner-override either (moving the pointer is non-destructive; the
// owner-override case only applies to a *new* action submitted while behind
// the tip, i.e. apply-action, not to undo/redo themselves).
//
// Unlike apply-action, this needs the game's genesis (buildGenesisState,
// src/lib/gameGenesis.ts) — undoing isn't a step forward from the current
// state, it's a shorter replay from the start (see applyUndoAction's own
// doc comment in src/engine/undoRedo.ts) — mirroring what GamePage.tsx's
// handleUndo does client-side today.
//
// Request body: `{ gameId: string }` — no action payload, by design (§4.4:
// "no payload; no per-action legality check applies to moving the pointer
// itself").
import { applyUndoAction } from '../../../src/engine/undoRedo.ts'
import {
  buildGenesisState,
  corsHeaders,
  getCallerUserId,
  jsonResponse,
  loadFullGameAndPlayers,
  loadGameContext,
  resolveGameContent,
  serviceRoleClient,
  writeGameStateCAS,
} from '../_shared/gameEnforcement.ts'

interface UndoActionRequest {
  gameId: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const callerUserId = await getCallerUserId(req)
  if (!callerUserId) return jsonResponse(401, { ok: false, error: 'Not authenticated.' })

  let body: UndoActionRequest
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
    return jsonResponse(403, { ok: false, error: 'Only a seated player (or the room owner/an admin) may undo.' })
  }

  const genesisInputs = await loadFullGameAndPlayers(supabase, gameId)
  if (!genesisInputs) return jsonResponse(404, { ok: false, error: 'Game not found.' })
  const genesis = buildGenesisState(genesisInputs.game, genesisInputs.players)

  // Narration-only (never checked for legality) — the caller's own seat if
  // they have one, otherwise null (e.g. an owner/admin undoing without
  // being seated themselves), same as GamePage.tsx's `me?.id ?? null`.
  const callerPlayerId = ctx.players.find((p) => p.user_id === callerUserId)?.id ?? null

  const content = resolveGameContent(ctx.gameState.state, ctx.players.length)
  const result = applyUndoAction(
    genesis,
    ctx.gameState.state,
    callerPlayerId,
    content.unitContent,
    content.achievementContent,
    content.boardGenerationContent,
    content.taleContent,
  )
  if (!result.ok) return jsonResponse(400, { ok: false, error: result.error })

  const newVersion = await writeGameStateCAS(supabase, gameId, result.state, ctx.gameState.version)
  if (newVersion === null) {
    return jsonResponse(409, { ok: false, error: 'Game state changed concurrently — refetch and retry.' })
  }

  return jsonResponse(200, { ok: true, state: result.state, version: newVersion })
})
