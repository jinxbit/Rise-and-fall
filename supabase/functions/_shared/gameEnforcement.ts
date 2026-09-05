// Shared plumbing for RULE_ENFORCEMENT_PLAN.md §8 phase 6's apply-action/
// undo-action/redo-action Edge Functions — §4.1's caller-seat resolution,
// §4.4/§4.5's owner/admin-override check, and the game_state
// compare-and-swap write, all in one place so the three functions (each its
// own independent deploy unit, per Supabase's `_shared/` convention) don't
// triplicate them. Imports `src/engine/`/`src/content/` directly and
// unmodified, per RULE_ENFORCEMENT_PLAN.md §3's architecture decision ("Reuse
// src/engine/'s pure, dependency-free TypeScript unmodified — no rule-logic
// duplication between client and server") — unlike notify-discord-turn/
// notify-web-push, which duplicate a few lines of turnOrder.ts by hand, this
// is far too much surface (applyAction.ts alone is ~700 lines, with a dozen
// more files behind it) to duplicate safely.
//
// This relies on two things that could not be verified in the sandbox this
// was written in (no Deno CLI, no live Supabase project to deploy against —
// same limitation RULE_ENFORCEMENT_PLAN.md §9 already calls out for this
// whole phase): (1) that the Supabase Edge Runtime, given
// `deno.json`'s `"unstable": ["sloppy-imports"]` (set per-function — see
// apply-action/deno.json etc.), resolves `src/engine/`'s extensionless
// relative imports (e.g. `from './cards'`) the same way `deno check --unstable-sloppy-imports`
// does locally; (2) that `src/content/*.json` imports resolve without an
// explicit `with { type: 'json' }` attribute for local relative files. If
// deploying any of these three functions fails on either point, the fallback
// is adding that import-attribute to `src/content/resolveContent.ts`
// (Deno's requirement, not this repo's) or, failing that, porting the
// specific failing files the way notify-discord-turn already ported
// turnOrder.ts's pendingActorIds.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { applyActionAndFastForwardTiles, fastForwardPendingChoices } from '../../../src/engine/applyAction.ts'
import type { Action, LoggedAction } from '../../../src/engine/actions.ts'
import { redoableTail } from '../../../src/engine/historyFold.ts'
import { applyTaleAchievementModifiers, applyTaleModifiers } from '../../../src/engine/tales.ts'
import type { ActionResult, GameState } from '../../../src/engine/types.ts'
import {
  resolveAchievementContent,
  resolveBoardGenerationContent,
  resolveTaleContent,
  resolveUnitContent,
} from '../../../src/content/resolveContent.ts'
import { buildGenesisState } from '../../../src/lib/gameGenesis.ts'
import type { GameRow as FullGameRow, PlayerRow as FullPlayerRow } from '../../../src/lib/dbTypes.ts'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

/** Every table row this module needs — deliberately narrower than dbTypes.ts's full GameRow/PlayerRow, just the columns actually selected below. */
export interface GameRow {
  id: string
  play_mode: 'hotseat' | 'live' | 'async'
  created_by: string
}
export interface PlayerRow {
  id: string
  user_id: string
}
export interface GameStateRow {
  state: GameState
  version: number
}

/** Service-role client — every DB read/write these functions do is against this, not the caller's own RLS-scoped session (see this file's own doc comment: these functions enforce authorization themselves, the same reasoning RULE_ENFORCEMENT_PLAN.md §3 gives for choosing Edge Functions at all). */
export function serviceRoleClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

/**
 * Resolves the calling user's id from their JWT (`Authorization` header),
 * via a client scoped to that JWT rather than the service-role one — this is
 * what actually verifies the token, exactly like GamePage.tsx's `session`
 * resolves `auth.uid()` client-side. Returns null for a missing/invalid
 * token; callers should reject with 401 in that case (verify_jwt is on by
 * default for these functions, so an invalid JWT normally never reaches this
 * point at all — this is a defensive fallback for that assumption, not the
 * primary check).
 */
export async function getCallerUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return null
  const anonClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data, error } = await anonClient.auth.getUser()
  if (error || !data.user) return null
  return data.user.id
}

export interface GameContext {
  game: GameRow
  players: PlayerRow[]
  gameState: GameStateRow
  /** games.created_by or profiles.is_admin — §4.5's carve-out, checked from the DB rather than trusted from the client. */
  isOwnerOrAdmin: boolean
}

/** Loads everything apply-action/undo-action/redo-action need about one game in one place, or null if the game/its state doesn't exist. */
export async function loadGameContext(supabase: SupabaseClient, gameId: string, callerUserId: string): Promise<GameContext | null> {
  const [{ data: game, error: gameError }, { data: players, error: playersError }, { data: gameState, error: stateError }] = await Promise.all([
    supabase.from('games').select('id, play_mode, created_by').eq('id', gameId).maybeSingle(),
    supabase.from('players').select('id, user_id').eq('game_id', gameId),
    supabase.from('game_state').select('state, version').eq('game_id', gameId).maybeSingle(),
  ])
  if (gameError) throw gameError
  if (playersError) throw playersError
  if (stateError) throw stateError
  if (!game || !players || !gameState) return null

  const { data: profile, error: profileError } = await supabase.from('profiles').select('is_admin').eq('user_id', callerUserId).maybeSingle()
  if (profileError) throw profileError

  return {
    game,
    players,
    gameState,
    isOwnerOrAdmin: game.created_by === callerUserId || (profile?.is_admin ?? false),
  }
}

/**
 * §4.1: is `callerUserId` entitled to submit `playerId`'s action? Hotseat is
 * explicitly out of scope (one shared `auth.uid()` covers every local seat —
 * see RULE_ENFORCEMENT_PLAN.md's Scope section), so any player enrolled in a
 * hotseat game may act for any seat in it, same as today's client-trusted
 * behavior. Live/async requires an exact (game, seat, caller) match. §4.5's
 * owner/admin override applies uniformly on top, regardless of play mode.
 */
export function isAuthorizedToActAs(ctx: GameContext, callerUserId: string, playerId: string): boolean {
  if (ctx.isOwnerOrAdmin) return true
  if (ctx.game.play_mode === 'hotseat') return ctx.players.some((p) => p.user_id === callerUserId)
  return ctx.players.some((p) => p.id === playerId && p.user_id === callerUserId)
}

/**
 * §4.4's owner-override condition, adapted to the actually-shipped
 * marker-based history model (issue #412's UNDO_ACTION/REDO_ACTION entries +
 * resolveHistory, ./historyFold.ts) rather than historyPointer.ts's
 * separate-pointer-column design that turned out unnecessary (§6 of the
 * plan): appending `submittedByPlayerId`'s new action to the raw
 * `actionHistory` already makes resolveHistory prune any un-redone tail
 * automatically (see historyFold.test.ts's branching cases) — this just
 * checks, before that happens, whether that tail contains anyone else's
 * action, which is the one case §4.4 says needs the room owner (extended by
 * §4.5 to `profiles.is_admin` too — both already folded into
 * ctx.isOwnerOrAdmin).
 */
export function requiresOwnerOverride(rawHistory: LoggedAction[], submittedByPlayerId: string): boolean {
  return redoableTail(rawHistory).some((entry) => entry.action.playerId !== submittedByPlayerId)
}

/** GameState.activeTaleIds/gameLength + player count -> every content bundle applyAction's dispatch needs, mirroring GamePage.tsx's own resolution order (tale content first, since it modifies the other two). */
export function resolveGameContent(state: GameState, playerCount: number) {
  const boardGenerationContent = resolveBoardGenerationContent(playerCount)
  const taleContent = resolveTaleContent(state.activeTaleIds, playerCount)
  const unitContent = applyTaleModifiers(resolveUnitContent(playerCount), taleContent)
  const achievementContent = applyTaleAchievementModifiers(resolveAchievementContent(state.gameLength), taleContent)
  return { unitContent, achievementContent, boardGenerationContent, taleContent }
}

/**
 * Applies `action` against `state.state`, fast-forwarding both forced tile
 * placements (§4.3, boardSetup) and forced card choices/declines (§4.3,
 * active) — the two are mutually exclusive by GameState.status, so running
 * both loops unconditionally after every action is cheap and correct rather
 * than gating on the submitted action's own type.
 */
export function applyActionFullyEnforced(state: GameState, action: Action, playerCount: number): ActionResult {
  const content = resolveGameContent(state, playerCount)
  const tileResult = applyActionAndFastForwardTiles(state, action, content.unitContent, content.achievementContent, content.boardGenerationContent, content.taleContent)
  if (!tileResult.ok) return tileResult
  return { ok: true, state: fastForwardPendingChoices(tileResult.state, content.unitContent, content.achievementContent, content.boardGenerationContent, content.taleContent) }
}

/**
 * game_state's existing compare-and-swap write (mirrors writeGameState in
 * src/lib/gameApi.ts): succeeds only if `expectedVersion` still matches the
 * row's current version, same optimistic-concurrency contract clients use
 * today. Returns the new version, or null if another write raced this one
 * (caller should re-fetch and retry, or surface a 409 to the client — this
 * is expected to happen occasionally under concurrent submissions, not a bug).
 */
export async function writeGameStateCAS(supabase: SupabaseClient, gameId: string, state: GameState, expectedVersion: number): Promise<number | null> {
  const { data, error } = await supabase
    .from('game_state')
    .update({ state, turn: state.turn, active_player_id: state.activePlayerId, version: expectedVersion + 1 })
    .eq('game_id', gameId)
    .eq('version', expectedVersion)
    .select('version')
    .maybeSingle()
  if (error) throw error
  return data ? data.version : null
}

/**
 * Full game/player rows, beyond loadGameContext's narrow projection — needed
 * only by undo-action/redo-action, to rebuild genesis (buildGenesisState,
 * src/lib/gameGenesis.ts) the same way GamePage.tsx's handleUndo/handleRedo
 * do client-side today. apply-action never needs genesis: a live submission
 * only ever steps forward from the current stored GameState.
 */
export async function loadFullGameAndPlayers(supabase: SupabaseClient, gameId: string): Promise<{ game: FullGameRow; players: FullPlayerRow[] } | null> {
  const [{ data: game, error: gameError }, { data: players, error: playersError }] = await Promise.all([
    supabase.from('games').select().eq('id', gameId).maybeSingle(),
    supabase.from('players').select().eq('game_id', gameId).order('seat_index', { ascending: true }),
  ])
  if (gameError) throw gameError
  if (playersError) throw playersError
  if (!game || !players) return null
  return { game: game as FullGameRow, players: players as FullPlayerRow[] }
}

export { buildGenesisState }
