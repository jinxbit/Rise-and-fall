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
import {
  buildRedactedGameStateDelta,
  redactStateForPlayer,
  revealedGameStateView,
  unredactedPrefix,
  type RedactedGameState,
  type RedactedGameStateDelta,
} from '../../../src/engine/redaction.ts'
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
import {
  compressGameStateForStorage,
  decompressGameStateFromStorage,
  type CompressedGameState,
  type StoredGameState,
} from '../../../src/lib/gameStateCompression.ts'

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
 * owner/admin override applies on top for live/async — issue #486 gives
 * hotseat its own carve-out from that check instead (apply-action/index.ts),
 * since it exists to stop one human discarding another human's undone move,
 * and hotseat has only one human to begin with.
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
 * issue #648: apply-action/undo-action/redo-action's own response, same as
 * `get-game-state`'s, is now a `RedactedGameStateDelta` rather than a full
 * `RedactedGameState` — but unlike `get-game-state`, which needs
 * `loadBufferedGameState` to find something to diff against, a write always
 * already has its "previous" in memory: `preState` is exactly the state this
 * request's compare-and-swap wrote *over*, i.e. the very state the caller
 * must already hold (a stale one would have lost the CAS and 409'd instead
 * of reaching this call at all). So this never hits the `state`-fallback arm
 * of `buildRedactedGameStateDelta` — every enforced write response carries a
 * `statePatch`, never a full `state`.
 *
 * `sinceActionIndex` is `unredactedPrefix(previousView.actionHistory).length`
 * — the caller's own *safe* prefix length as of `preState`, not
 * `preState.actionHistory.length` itself (the raw log's length). Those two
 * can differ: if some other player's pick was still masked from this caller
 * as of `preState` (e.g. a three-seat selectCards phase where seat B picked
 * first, still hidden from A and C), that masked entry — and everything
 * `unredactedPrefix` cuts because of it — was never part of what this caller
 * actually held, even though the raw log already contains it. Getting this
 * wrong doesn't leak anything (the cut is always conservative), but it does
 * make `applyRedactedGameStateDelta` reject the response outright, since the
 * caller's own `previous.actionHistory.length` (built the same
 * redact-then-truncate way, client-side) would then disagree with
 * `actionHistoryFrom`.
 */
export function buildEnforcedActionResponseDelta(ctx: GameContext, callerUserId: string, preState: GameState, postState: GameState): RedactedGameStateDelta {
  const previousView = redactedResponseState(ctx, callerUserId, preState)
  const currentView = redactedResponseState(ctx, callerUserId, postState)
  const sinceActionIndex = unredactedPrefix(previousView.actionHistory).length
  return buildRedactedGameStateDelta(previousView, currentView, sinceActionIndex)
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
 * has to be deliberately switched on first. Also unconditional here on play
 * mode — issue #486: this function has no `GameContext` to read `play_mode`
 * from, so its caller skips calling it at all for a hotseat game instead
 * (same reasoning as isAuthorizedToActAs's hotseat branch above: one shared
 * `auth.uid()` covers every seat, so there is no second human whose undone
 * move could be discarded).
 *
 * `lockRevealedInformationEnabled` (issue #529,
 * GameState.lockRevealedInformationEnabled — see that field's own doc
 * comment) closes a second gap the "someone else's action" check above
 * doesn't: a player who was the *last* to pick in a simultaneous
 * `selectCards`/`decline` phase can undo straight back to before their own
 * pick and resubmit a different one — only their own entry sits in the
 * discarded tail, so the check above sees nothing to protect, even though
 * that pick already resolved the phase and so was already revealed to
 * everyone. When on, a branch that would discard *any*
 * `CHOOSE_CARD`/`MOVE_TO_DECLINE` entry — regardless of whose — needs the
 * same override, not just one that discards another player's. This is safe
 * to apply unconditionally on entry type rather than first checking whether
 * that particular phase had actually resolved: a still-*open* pick never
 * needs branching to retract in the first place — `RETRACT_CHOICE`/
 * `RETRACT_DECLINE` (RULE_ENFORCEMENT_PLAN.md §4.4's refinement) are
 * ordinary forward actions the caller can always submit directly for their
 * own still-pending pick, with no owner-override check at all — so any
 * `CHOOSE_CARD`/`MOVE_TO_DECLINE` a client instead reaches via undo+resubmit
 * is, by construction, one that already resolved.
 *
 * Issue #547 gives `RETRACT_CHOICE` one further, still-forward-only reach:
 * the caller's own pick, even after some *other* player's resolved the
 * `selectCards` phase, as long as nothing has happened in `actions` since —
 * see `canRetractChoiceAfterReveal` (src/engine/applyAction.ts). That path
 * is self-gated on `lockRevealedInformationEnabled` inside the engine
 * itself rather than through this function, since it's still a forward
 * submission with nothing in `redoableTail` to check — `RETRACT_DECLINE` has
 * no equivalent yet (its own post-resolve case would mean reversing
 * `beginPurchasePhase`'s possible cascade into a finished round, not just a
 * phase flip — see the issue's own applyRetractChoice doc comment for why
 * that's out of scope for now).
 */
export function requiresOwnerOverride(rawHistory: LoggedAction[], submittedByPlayerId: string, lockRevealedInformationEnabled: boolean): boolean {
  const tail = redoableTail(rawHistory)
  if (tail.some((entry) => entry.action.playerId !== submittedByPlayerId)) return true
  return lockRevealedInformationEnabled && tail.some((entry) => entry.action.type === 'CHOOSE_CARD' || entry.action.type === 'MOVE_TO_DECLINE')
}

/**
 * GameState.activeTaleIds/gameLength + player count -> every content bundle
 * applyAction's dispatch needs, mirroring GamePage.tsx's own resolution
 * order (tale content first, since it modifies the other two).
 *
 * Player count comes from `state.players.length`, not a fresh `players`
 * table read (contrast `ctx.players` in GameContext, which is deliberately
 * live — see isAuthorizedToActAs/canReadGameState, which need the *current*
 * roster for auth) — `state.players` is fixed at genesis and never shrinks
 * afterward (elimination flags a player, it doesn't remove them, see
 * elimination.ts), so it's the self-contained source CLAUDE.md's "read them
 * from GameState, not the games row" already asks for elsewhere
 * (activeTaleIds/gameLength above). Using a live count here instead let one
 * request's content resolution (board-generation pool sizes, unit supply
 * caps, ...) silently diverge from genesis's — confirmed against a reported
 * 2-player game (issue #519) whose `boardSetup.tilesRemainingInTier` ended
 * up permanently set to the *3*-player pool size for its next tile tier,
 * because whatever `players` read happened to run for that one request
 * returned 3 rows.
 */
export function resolveGameContent(state: GameState) {
  const playerCount = state.players.length
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
export function applyActionFullyEnforced(state: GameState, action: Action): ActionResult {
  const content = resolveGameContent(state)
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
  if (!data) return null
  await bufferGameStateSnapshot(supabase, gameId, data.version as number, compressed, state.status === 'completed')
  return data.version
}

/**
 * How many recent versions of a game's GameState `game_state_snapshots`
 * keeps (issue #648, 0036_game_state_snapshots.sql) — sized off the normal
 * async usage pattern (an opponent makes 1-3 moves between a player's own
 * visits), so a cold open after hours away still finds its base version in
 * the buffer far more often than not; a miss just costs one full response
 * instead of a patch (`get-game-state/index.ts`), never a wrong one. Not
 * tuned from real production data yet — a starting point per the issue's own
 * design note, revisit if misses turn out to be common.
 */
const SNAPSHOT_BUFFER_SIZE = 16

/**
 * Maintains `game_state_snapshots` alongside `writeGameStateCAS`'s own write
 * (genesis's equivalent write — `start-game/index.ts`'s direct insert at
 * version 0 — calls this too, since it's the one write path
 * `writeGameStateCAS` doesn't cover): inserts this write's own resulting
 * `(gameId, version, state)`, then either prunes the buffer back down to
 * `SNAPSHOT_BUFFER_SIZE` rows or, once the game has actually finished, drops
 * every row for it outright — a completed game never writes again, so a
 * `get-game-state` delta request against it will only ever ask for the same
 * final version repeatedly (an empty patch), making the buffer pure
 * unreclaimed storage from that point on.
 *
 * Deliberately best-effort: this is a bandwidth optimization's cache, not
 * part of the write's own correctness — a failure here must never turn an
 * otherwise-successful game-state write into an apparent failure for the
 * caller, so every error is swallowed (logged, not thrown) rather than
 * propagated. The cost of a miss is exactly one full `get-game-state`
 * response instead of a patch (see `loadBufferedGameState`'s callers), never
 * a correctness issue.
 */
export async function bufferGameStateSnapshot(supabase: SupabaseClient, gameId: string, version: number, compressed: CompressedGameState, completed: boolean): Promise<void> {
  try {
    if (completed) {
      const { error } = await supabase.from('game_state_snapshots').delete().eq('game_id', gameId)
      if (error) throw error
      return
    }
    // A plain insert, not an upsert: `unique (game_id, version)` means a
    // second write for a version already buffered (only possible on a
    // caller retry after an earlier failure) hits 23505, which this
    // function's own try/catch below already treats as a harmless miss —
    // no need for a second conflict-resolution mechanism on top of that.
    const { error: insertError } = await supabase.from('game_state_snapshots').insert({ game_id: gameId, version, state: compressed })
    if (insertError) throw insertError
    const { error: pruneError } = await supabase.from('game_state_snapshots').delete().eq('game_id', gameId).lte('version', version - SNAPSHOT_BUFFER_SIZE)
    if (pruneError) throw pruneError
  } catch (err) {
    console.error(`game_state_snapshots maintenance failed for game ${gameId} (non-fatal — the next delta request for it just falls back to a full fetch):`, err)
  }
}

/**
 * `get-game-state`'s buffer lookup: the `GameState` this game had at exactly
 * `version`, or `null` if it's outside `game_state_snapshots`' rolling window
 * (or the lookup itself fails — treated the same as a miss, per
 * `bufferGameStateSnapshot`'s own best-effort reasoning). A miss means
 * `respondWithState` falls back to sending the plain, un-patched
 * `stateWithoutHistory` for this one request — never an error, and never a
 * reason to withhold the `actionHistoryAppend` half of the response, which
 * has nothing to do with this buffer at all.
 */
export async function loadBufferedGameState(supabase: SupabaseClient, gameId: string, version: number): Promise<GameState | null> {
  try {
    const { data, error } = await supabase.from('game_state_snapshots').select('state').eq('game_id', gameId).eq('version', version).maybeSingle()
    if (error) throw error
    if (!data) return null
    return await decompressGameStateFromStorage(data.state as StoredGameState)
  } catch (err) {
    console.error(`game_state_snapshots lookup failed for game ${gameId} version ${version} (non-fatal — falling back to a full response):`, err)
    return null
  }
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
