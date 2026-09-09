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
// Verified (2026-09-05) against a local `supabase start` stack that both of
// this file's original two open questions were real deploy blockers, now
// fixed — see RULE_ENFORCEMENT_PLAN.md §8 phase 6 for the full story:
// (1) the Edge Runtime does NOT honor `sloppy-imports` (tried per-function
// deno.json, a workspace-root one, every placement) — `src/engine/`'s own
// internal relative imports (e.g. `from './cards'`) all needed an explicit
// `.ts` extension instead, safe here since `tsconfig.app.json` already sets
// `allowImportingTsExtensions`; (2) `src/content/*.json` imports did need
// the `with { type: 'json' }` attribute (added to `resolveContent.ts`).
// With both fixed, all three functions boot and were smoke-tested against a
// real local project (auth, authorization 403, a legal action's CAS write,
// undo/redo). Not yet done: against an actually-deployed (not local)
// project, and a genuine two-browser session — still phase 9.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { applyAction } from '../../../src/engine/applyAction.ts'
import type { Action, LoggedAction } from '../../../src/engine/actions.ts'
import { redoableTail } from '../../../src/engine/historyFold.ts'
import { redactStateForPlayer, revealedGameStateView, type RedactedGameState } from '../../../src/engine/redaction.ts'
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
import { compressGameStateForStorage, decompressGameStateFromStorage, type StoredGameState } from '../../../src/lib/gameStateCompression.ts'

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
  /** Room lifecycle status (0008_room_lifecycle.sql) — only get-game-state's read-visibility check (mirroring 0021_remove_observers.sql's RLS policy) uses this today; apply-action/undo-action/redo-action ignore it. */
  status: 'lobby' | 'active' | 'completed' | 'canceled'
}
export interface PlayerRow {
  id: string
  user_id: string
}
/** The row's logical (decompressed) shape — see loadGameContext, which decompresses before this ever reaches a caller. */
export interface GameStateRow {
  state: GameState
  version: number
}

/** The row's actual on-disk shape, before loadGameContext decompresses it — see gameStateCompression.ts. */
interface RawGameStateRow {
  state: StoredGameState
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
  /** profiles.is_admin, checked from the DB rather than trusted from the client. The one caller get-game-state trusts with a still-secret pick (§4.5) — unlike isOwnerOrAdmin below, the room owner does NOT get this, per jinxbit's follow-up on issue #450: an owner is still just a player, with no rules reason to see another player's hidden information. */
  isAdmin: boolean
  /** games.created_by or profiles.is_admin — §4.4/§4.5's write-side act-as-any-player/history-override carve-out. Deliberately broader than isAdmin: forcing an action through (e.g. for a stuck/AFK player) is an owner responsibility today, unrelated to reading someone else's still-secret state (see isAdmin above, and get-game-state/index.ts's use of isAdmin instead of this for its unredacted-read branch). */
  isOwnerOrAdmin: boolean
}

/** Loads everything apply-action/undo-action/redo-action need about one game in one place, or null if the game/its state doesn't exist. */
export async function loadGameContext(supabase: SupabaseClient, gameId: string, callerUserId: string): Promise<GameContext | null> {
  const [{ data: game, error: gameError }, { data: players, error: playersError }, { data: gameState, error: stateError }] = await Promise.all([
    supabase.from('games').select('id, play_mode, created_by, status').eq('id', gameId).maybeSingle(),
    supabase.from('players').select('id, user_id').eq('game_id', gameId),
    supabase.from('game_state').select('state, version').eq('game_id', gameId).maybeSingle(),
  ])
  if (gameError) throw gameError
  if (playersError) throw playersError
  if (stateError) throw stateError
  if (!game || !players || !gameState) return null

  const { data: profile, error: profileError } = await supabase.from('profiles').select('is_admin').eq('user_id', callerUserId).maybeSingle()
  if (profileError) throw profileError

  const isAdmin = profile?.is_admin ?? false
  const rawGameState = gameState as RawGameStateRow
  return {
    game,
    players,
    gameState: { state: await decompressGameStateFromStorage(rawGameState.state), version: rawGameState.version },
    isAdmin,
    isOwnerOrAdmin: game.created_by === callerUserId || isAdmin,
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
 * get-game-state's read-visibility check — mirrors `game_state`'s current
 * SELECT RLS policies (0021_remove_observers.sql: seated player, or any
 * signed-in user once the game is past 'lobby'; 0024_admin_read_all_game_state.sql:
 * an admin, of anything, always) exactly, since a service-role-client Edge
 * Function bypasses RLS entirely and so has to reimplement whatever gate RLS
 * would otherwise have provided. Deliberately keyed on `isAdmin`, not the
 * broader `isOwnerOrAdmin` — RLS itself gives the room owner no special read
 * access beyond being a seated player, so neither should this.
 */
export function canReadGameState(ctx: GameContext, callerUserId: string): boolean {
  if (ctx.isAdmin) return true
  if (ctx.players.some((p) => p.user_id === callerUserId)) return true
  return ctx.game.status !== 'lobby'
}

/**
 * Write-side mirror of `get-game-state`'s redaction gate (see that
 * function's own doc comment for the condition and the admin/hotseat
 * carve-outs — this reuses the exact same one, keyed off the *result*
 * state's own `hiddenInformationEnabled`/nothing-play-mode-specific fields
 * rather than re-deriving it) — issue #478: apply-action/undo-action/
 * redo-action hand the caller back the very state their own compare-and-
 * swap just wrote, so without this the write response leaks exactly the
 * still-secret pick the read path withholds. Keyed on the caller's own seat
 * (`ctx.players`/`callerUserId`), not `action.playerId` — the owner/admin
 * override (§4.5) lets someone submit on another seat's behalf, but the
 * response still lands in *this* caller's own browser, so it's their own
 * knowledge that gates what they see back, exactly like a read.
 *
 * Always wraps in the `RedactedGameState` shape, even when nothing is
 * actually masked (`revealedGameStateView`) — same reasoning as
 * `get-game-state`: every caller gets one predictable shape, so
 * `gameApi.ts`'s callers can unconditionally run the response through
 * `toClientGameState` rather than sniffing which shape came back. That
 * collapse is a lossless round trip whenever nothing was masked (see
 * `toClientGameState`'s own doc comment), so this is not a behavior change
 * for a game without `hiddenInformationEnabled`.
 */
export function redactedResponseState(ctx: GameContext, callerUserId: string, state: GameState): RedactedGameState {
  const shouldRedact = state.hiddenInformationEnabled && ctx.game.play_mode !== 'hotseat'
  if (ctx.isAdmin || !shouldRedact) return revealedGameStateView(state)
  const callerPlayerId = ctx.players.find((p) => p.user_id === callerUserId)?.id ?? null
  return redactStateForPlayer(state, callerPlayerId)
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
 *
 * Only decides WHETHER an override is needed, not whether the caller has
 * one — since issue #464, that's no longer just `ctx.isOwnerOrAdmin`: the
 * caller (apply-action/index.ts) must also check `GameState.adminModeActive`
 * (toggled by SET_ADMIN_MODE, src/engine/actions.ts) — being the room owner
 * or a site admin is no longer sufficient by itself, it's a privilege that
 * has to be deliberately switched on first.
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
 * Applies `action` against `state.state`, resolving this game's content
 * bundles and delegating to applyAction (src/engine/applyAction.ts) — the
 * same entry point GamePage.tsx's submitAction uses client-side, so both
 * forced tile placements and forced card choices/declines (§4.3) fast-
 * forward identically here and there, folded into the same actionHistory
 * entry as `action` itself.
 */
export function applyActionFullyEnforced(state: GameState, action: Action, playerCount: number): ActionResult {
  const content = resolveGameContent(state, playerCount)
  return applyAction(state, action, content.unitContent, content.achievementContent, content.boardGenerationContent, content.taleContent)
}

/**
 * game_state's existing compare-and-swap write (mirrors writeGameState in
 * src/lib/gameApi.ts): succeeds only if `expectedVersion` still matches the
 * row's current version, same optimistic-concurrency contract clients use
 * today. Returns the new version, or null if another write raced this one
 * (caller should re-fetch and retry, or surface a 409 to the client — this
 * is expected to happen occasionally under concurrent submissions, not a bug).
 *
 * This is the one path (shared by apply-action/undo-action/redo-action, and
 * only ever invoked for `ruleEnforcementEnabled` games — see GamePage.tsx's
 * branch in submitAction/handleUndo/handleRedo) that gzip+base64-compresses
 * `state` before it's written, shrinking the stored row — which shrinks both
 * every subscribed client's Realtime broadcast of it and every later REST
 * read (getGameState/listMyGames/etc. in gameApi.ts). A client-trusted game's
 * direct writes (gameApi.ts's writeGameState/insertGameState) are unaffected
 * — see gameStateCompression.ts's doc comment for why this is scoped here
 * rather than to every write.
 */
export async function writeGameStateCAS(supabase: SupabaseClient, gameId: string, state: GameState, expectedVersion: number): Promise<number | null> {
  const compressed = await compressGameStateForStorage(state)
  const { data, error } = await supabase
    .from('game_state')
    .update({ state: compressed, turn: state.turn, active_player_id: state.activePlayerId, version: expectedVersion + 1 })
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
