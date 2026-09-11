// Closes the last out-of-scope gap in RULE_ENFORCEMENT_PLAN.md's model
// (0026_rule_enforcement_flag.sql's INSERT comment; discussed at length on
// issue #519, which surfaced it via a *different* bug — #524's lobby-roster
// race — that this same gap made permanent for the affected room): for a
// ruleEnforcementEnabled game, genesis (the game_state INSERT, and the
// games.status flip to 'active' that follows it) was still built and
// written entirely by whichever client clicked Start, with no server check
// at all — unlike every action after it. This function moves that one
// remaining direct write server-side, mirroring apply-action/undo-action/
// redo-action's shape: it re-fetches the roster straight from the DB (never
// a client-supplied one — a stale client-held `players` snapshot was
// exactly #519/#524's bug), calls the same shared buildGenesisState, and
// writes the result under a service-role client.
// 0029_start_game_edge_function.sql blocks the matching direct client
// writes (`game_state` INSERT, `games`' 'lobby' -> 'active' transition) for
// an enforced game, so this function is now the only legitimate way to
// start one — see that migration for why the restriction lives in the
// status-transition trigger rather than a plain RLS policy.
//
// Non-enforced games are completely untouched: gameApi.ts's
// startGameFromLobby() still does this exact sequence client-side for them
// (see its own doc comment) — this function rejects a game that isn't
// ruleEnforcementEnabled, rather than silently handling it too, so there is
// only ever one code path responsible for a given game's Start.
//
// Request body: `{ gameId: string }`. Idempotent past the point a
// `game_state` row exists — same no-op guard startGameFromLobby's own
// insertGameState uses — a retry after a prior call inserted genesis but
// failed before flipping `games.status` just (re)flips status instead of
// erroring.
import { canStartGame } from '../../../src/lib/roomReadiness.ts'
import { resolveMapPoolRandomAtStart, resolveSoloBuildMap } from '../../../src/lib/gameGenesis.ts'
import { compressGameStateForStorage } from '../../../src/lib/gameStateCompression.ts'
import type { GameRow, GameSettings, MapPoolRow, PlayerRow } from '../../../src/lib/dbTypes.ts'
import { buildGenesisState, corsHeaders, getCallerUserId, jsonResponse, serviceRoleClient } from '../_shared/gameEnforcement.ts'
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

interface StartGameRequest {
  gameId: string
}

/** Server-side equivalent of mapPoolApi.ts's pickRandomMapFromPool — not imported directly since that module pulls in the browser `supabase` singleton (../supabase.ts), which isn't constructible in the Edge Runtime (see gameEnforcement.ts's own doc comment on why this file's functions re-query tables directly instead of importing gameApi.ts/mapPoolApi.ts wholesale). */
async function pickRandomMapFromPool(supabase: SupabaseClient, playerCount: number): Promise<MapPoolRow | null> {
  const { data, error } = await supabase.from('map_pool').select().eq('player_count', playerCount)
  if (error) throw error
  const maps = (data ?? []) as MapPoolRow[]
  if (maps.length === 0) return null
  return maps[Math.floor(Math.random() * maps.length)]
}

/** Persists a resolved settings pick (map pool / solo build) the same way gameApi.ts's updateGameSettings does, and returns the game row with that pick applied so the rest of this request keeps using the up-to-date value. */
async function persistSettings(supabase: SupabaseClient, game: GameRow, settings: GameSettings): Promise<GameRow> {
  const { error } = await supabase.from('games').update({ settings }).eq('id', game.id)
  if (error) throw error
  return { ...game, settings }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const callerUserId = await getCallerUserId(req)
  if (!callerUserId) return jsonResponse(401, { ok: false, error: 'Not authenticated.' })

  let body: StartGameRequest
  try {
    body = await req.json()
  } catch {
    return jsonResponse(400, { ok: false, error: 'Invalid JSON body.' })
  }
  const { gameId } = body
  if (!gameId) return jsonResponse(400, { ok: false, error: 'Request body must be { gameId }.' })

  const supabase = serviceRoleClient()
  const { data: game, error: gameError } = await supabase.from('games').select().eq('id', gameId).maybeSingle()
  if (gameError) throw gameError
  if (!game) return jsonResponse(404, { ok: false, error: 'Game not found.' })
  let gameRow = game as GameRow

  // Mirrors 0008_room_lifecycle.sql's "room owner can update their game" RLS
  // and LobbyPage.tsx's own `isCreator` gate — starting a room is an Owner
  // action, same as canceling/deleting it. No admin override: nothing else
  // in the room-lifecycle model gives an admin that privilege either.
  if (gameRow.created_by !== callerUserId) {
    return jsonResponse(403, { ok: false, error: 'Only the room owner may start the game.' })
  }
  if (!gameRow.settings.ruleEnforcementEnabled) {
    return jsonResponse(400, { ok: false, error: 'This game is not rule-enforced — it starts through the client-trusted path instead.' })
  }

  const { data: existingState, error: existingStateError } = await supabase.from('game_state').select('game_id').eq('game_id', gameId).maybeSingle()
  if (existingStateError) throw existingStateError

  if (!existingState) {
    if (gameRow.status !== 'lobby') {
      return jsonResponse(400, { ok: false, error: 'This room is not in the lobby.' })
    }

    const { data: playerRows, error: playersError } = await supabase
      .from('players')
      .select()
      .eq('game_id', gameId)
      .order('seat_index', { ascending: true })
    if (playersError) throw playersError
    const players = (playerRows ?? []) as PlayerRow[]

    if (!canStartGame(gameRow, players)) {
      return jsonResponse(409, { ok: false, error: 'This room changed since you loaded it — refresh and try again.' })
    }

    // "Random saved map at start" (issue #166) / "Build alone" (issue #243):
    // same resolve-then-persist reasoning as startGameFromLobby's client-side
    // equivalent — buildGenesisState must stay a synchronous, deterministic
    // function of the game row alone, so a random pick has to be rolled and
    // locked in here, before it's called.
    if (gameRow.settings.mapPoolRandomAtStart && !gameRow.settings.mapPoolBoard) {
      const picked = await pickRandomMapFromPool(supabase, players.length)
      const settings = resolveMapPoolRandomAtStart(gameRow.settings, picked)
      if (settings !== gameRow.settings) gameRow = await persistSettings(supabase, gameRow, settings)
    }
    if (gameRow.settings.soloBuildMap) {
      const settings = resolveSoloBuildMap(gameRow.settings, players)
      if (settings !== gameRow.settings) gameRow = await persistSettings(supabase, gameRow, settings)
    }

    const genesis = buildGenesisState(gameRow, players)
    const compressed = await compressGameStateForStorage(genesis)
    const { error: insertError } = await supabase
      .from('game_state')
      .insert({ game_id: gameId, state: compressed, turn: genesis.turn, active_player_id: genesis.activePlayerId })
    if (insertError && insertError.code !== '23505') throw insertError
  }

  // Same coarse-status-only flip startGameFromLobby's client-side path ends
  // with — see its own doc comment in gameApi.ts for why `games.status`
  // itself only ever needs to become 'active' here, never anything finer.
  const { error: statusError } = await supabase.from('games').update({ status: 'active' }).eq('id', gameId)
  if (statusError) throw statusError

  return jsonResponse(200, { ok: true })
})
