// A Supabase stack that behaves like production, in-process.
//
// What "like production" means here, concretely — a request made through this
// stack goes:
//
//   test  ->  real @supabase/supabase-js client
//         ->  patched global fetch
//         ->  ./httpServer.ts (PostgREST / GoTrue / Edge Function routing)
//         ->  the real supabase/functions/apply-action/index.ts handler
//         ->  another real @supabase/supabase-js client (service role)
//         ->  ./httpServer.ts again
//         ->  ./database.ts (RLS from the migrations, the
//             game_state_sync_meta trigger, version compare-and-swap)
//
// The only things replaced by a double are Postgres itself and the Deno Edge
// Runtime. Every line of rule enforcement, authorization, content resolution,
// state compression and optimistic concurrency in between is the code that
// ships. Covering those last two would mean a local `supabase start` stack,
// which needs Docker — deliberately not a requirement here, since
// .github/workflows/ci.yml runs `npm run test` on a plain Node runner and
// these games should replay on every pull request, not only where Docker is
// available.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Action } from '../../engine/actions.ts'
import { applyAction } from '../../engine/applyAction.ts'
import { applyRedoAction, applyUndoAction } from '../../engine/undoRedo.ts'
import { applyRedactedGameStateDelta, toClientGameState, type RedactedGameState, type RedactedGameStateDelta } from '../../engine/redaction.ts'
import type { GameState } from '../../engine/types.ts'
import type { GameRow, PlayerRow } from '../../lib/dbTypes.ts'
import { decompressGameStateFromStorage, type StoredGameState } from '../../lib/gameStateCompression.ts'
import { Database, type GameStateRow, type ProfileRow } from './database.ts'
import type { GameContent } from './sampleGame.ts'
import { loadEdgeFunctions, type EdgeFunctionName } from './edgeFunctions.ts'
import { loadGameContext, redactedResponseState } from '../../../supabase/functions/_shared/gameEnforcement.ts'
import { ANON_KEY, SERVICE_ROLE_KEY, STACK_URL, serveStackRequest, type AccountRegistry, type EdgeFunctionHandler, type ServerOptions, type TokenRegistry } from './httpServer.ts'

export { Database, STACK_URL, ANON_KEY, SERVICE_ROLE_KEY }
export type { GameStateRow, ProfileRow }

/** Mirrors gameApi.ts's GameEnforcementResult, plus the HTTP status so a test can assert 403 vs 409 vs 400. */
export type EnforcedCallResult = ({ ok: true; state: GameState; version: number } | { ok: false; error: string }) & { status: number }

/**
 * get-game-state's full-response shape — always RedactedGameState-shaped
 * (revealedGameStateView wraps even the "nothing's actually masked" cases:
 * admin, hotseat, or a game that hasn't opted into
 * GameSettings.hiddenInformationEnabled — see get-game-state/index.ts), so
 * callers never need to sniff which shape came back. Returned whenever the
 * caller doesn't send `sinceActionIndex`, or sends one the function can't
 * honor — see GameStateDeltaReadResult below for the other shape.
 */
export type GameStateReadResult = ({ ok: true; state: RedactedGameState; version: number } | { ok: false; error: string }) & { status: number }

/**
 * get-game-state's incremental-fetch response shape (issue #647) — returned
 * instead of GameStateReadResult when the request's `sinceActionIndex` is a
 * valid index into the current safe actionHistory prefix. Mirrors gameApi.ts's
 * getGameStateRedacted, the only real caller of this shape.
 */
export type GameStateDeltaReadResult = (({ ok: true; version: number } & RedactedGameStateDelta) | { ok: false; error: string }) & { status: number }

/** start-game's response shape — no state/version to redact, unlike every other Edge Function here (see supabase/functions/start-game/index.ts). */
export type StartGameCallResult = ({ ok: true } | { ok: false; error: string }) & { status: number }

export interface ProductionStack {
  /**
   * Where this stack answers, and the two keys it answers to — the same three
   * values a real project is configured with. Exposed so code written against
   * a deployed project (../productionSmoke/) can be pointed at this stack
   * instead and exercised in CI, rather than only ever running in production.
   */
  readonly url: string
  readonly anonKey: string
  readonly serviceRoleKey: string
  /** RLS-free access to the tables, for arranging fixtures and asserting on what landed. */
  readonly db: Database
  /** Every HTTP request the stack served, in order — `"POST /functions/v1/apply-action"`, `"PATCH /rest/v1/game_state?..."`, and so on. */
  readonly requests: string[]
  /** A signed-in browser's client for `userId`: anon key + that user's bearer token, exactly like a real session. */
  clientFor(userId: string): SupabaseClient
  /** A signed-out visitor's client — no bearer token, so every RLS policy scoped to `authenticated` denies it. */
  anonClient(): SupabaseClient
  /** Registers a user so the fake GoTrue will resolve their token, and gives them a `profiles` row. */
  addUser(userId: string, options?: { isAdmin?: boolean; displayName?: string }): void
  /**
   * Puts an already-started game into the database: the `games`/`players`/
   * `profiles` rows the lobby would have created, then the genesis
   * `game_state` row written the way LobbyPage.tsx's handleStart does it —
   * through the owner's own authenticated client, so 0001_init_schema.sql's
   * insert policy is exercised rather than bypassed.
   */
  seedStartedGame(options: { game: GameRow; players: PlayerRow[]; genesis: GameState; admins?: string[] }): Promise<void>
  /** gameApi.ts's getGameState, as `userId` — decompressed, RLS-gated, null if the row isn't readable or doesn't exist. This is the raw, unredacted direct-table read every game still uses unless it's both ruleEnforcementEnabled and hiddenInformationEnabled (see usesRedactedReads, GamePage.tsx), in which case gameApi.ts calls getGameStateRedacted (below) instead. Since 0028_hidden_information_rls_lockdown.sql (issue #488), a hiddenInformationEnabled game's row is RLS-invisible through this path entirely — seated player and stranger alike get `null`, same as a missing row — because that's exactly the game type get-game-state exists to replace this call for; an admin still sees it (0024_admin_read_all_game_state.sql). */
  readGameState(userId: string, gameId: string): Promise<{ state: GameState; version: number } | null>
  /**
   * Calls the real get-game-state Edge Function as `userId` — gameApi.ts's
   * getGameStateRedacted, the read path HIDDEN_INFORMATION_PLAN.md §8 phase 8
   * wired in. `sinceActionIndex`, when given, is sent the same way
   * getGameStateRedacted sends it (issue #647): a valid index gets back
   * GameStateDeltaReadResult; an omitted or out-of-range one falls back to
   * GameStateReadResult, same as a real client would see. `baseVersion`
   * (issue #648), when given alongside a valid `sinceActionIndex`, is what
   * lets that delta carry a `statePatch` instead of a plain `state` — see
   * get-game-state/index.ts's own doc comment for why it's a separate value
   * from `sinceActionIndex` rather than derived from it. A test that passes
   * `sinceActionIndex` and needs the delta fields narrows via
   * `'actionHistoryAppend' in result`, the same way gameApi.ts does; every
   * other call site (most of this suite) never sees that shape in practice
   * since it never sends `sinceActionIndex`, but still narrows the union with
   * a one-line assertion for TypeScript's sake — see getGameState.test.ts.
   */
  getGameState(userId: string, gameId: string): Promise<GameStateReadResult>
  getGameState(userId: string, gameId: string, sinceActionIndex: number, baseVersion?: number): Promise<GameStateReadResult | GameStateDeltaReadResult>
  /** Submits `action` to the real apply-action Edge Function as `userId`, the way gameApi.ts's applyActionEnforced does. */
  applyAction(userId: string, gameId: string, action: Action): Promise<EnforcedCallResult>
  undoAction(userId: string, gameId: string): Promise<EnforcedCallResult>
  redoAction(userId: string, gameId: string): Promise<EnforcedCallResult>
  /** Calls the real start-game Edge Function as `userId` — gameApi.ts's startGameFromLobby's enforced branch. */
  startGame(userId: string, gameId: string): Promise<StartGameCallResult>
  /**
   * The other write path: a game that never opted into enforcement, where the
   * client applies the action itself and writes the resulting state straight
   * to `game_state` under RLS and the version compare-and-swap — GamePage.tsx's
   * `writeWithRetry` branch. Most games in production still run this way, so a
   * replay of one of them has to go through here rather than the Edge
   * Functions (which such a game's RLS would let write, but whose enforcement
   * it was never played under).
   */
  applyActionClientTrusted(userId: string, gameId: string, action: Action, content: GameContent): Promise<EnforcedCallResult>
  undoActionClientTrusted(userId: string, gameId: string, playerId: string | null, genesis: GameState, content: GameContent): Promise<EnforcedCallResult>
  redoActionClientTrusted(userId: string, gameId: string, playerId: string | null, genesis: GameState, content: GameContent): Promise<EnforcedCallResult>
  /** Restores the global `fetch` this stack patched. Call from `afterEach`. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Global fetch routing
//
// supabase-js captures `fetch` when a client is constructed, and the Edge
// Functions construct their own clients per request (`serviceRoleClient`), so
// the patch has to sit on the global rather than be injected per client.
// One stack is active at a time; `dispose()` puts the original back.
// ---------------------------------------------------------------------------

let activeStack: ServerOptions | null = null
let originalFetch: typeof globalThis.fetch | null = null

function installFetch(options: ServerOptions): void {
  activeStack = options
  if (originalFetch) return
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== STACK_URL) {
      throw new Error(`The production stack test double intercepted a request to ${url.origin}, which it does not model.`)
    }
    if (!activeStack) throw new Error('No production stack is active — did a test forget to await createProductionStack()?')
    return await serveStackRequest(request, activeStack)
  }) as typeof globalThis.fetch
}

function restoreFetch(): void {
  activeStack = null
  if (originalFetch) {
    globalThis.fetch = originalFetch
    originalFetch = null
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A structurally real (but unsigned) JWT. Nothing in this stack verifies the
 * signature — the fake GoTrue resolves the token by lookup, same as a real one
 * is resolved by the auth server rather than by the client — but shaping it
 * like a genuine access token keeps any library that decodes it (auth-js does,
 * for expiry) working.
 */
function mintAccessToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ sub: userId, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600 }))
  return `${header}.${payload}.${base64url(`test-signature-${userId}`)}`
}

// ---------------------------------------------------------------------------

export async function createProductionStack(): Promise<ProductionStack> {
  const db = new Database()
  const tokens: TokenRegistry = new Map()
  const accounts: AccountRegistry = new Map()
  const requests: string[] = []
  const edgeFunctions: Map<string, EdgeFunctionHandler> = await loadEdgeFunctions()

  const tokenByUserId = new Map<string, string>()
  const clients = new Map<string, SupabaseClient>()
  // Same shape as an Edge Function's own serviceRoleClient() (gameEnforcement.ts)
  // — used only by seedStartedGame below, to seed an enforced game's genesis
  // the way start-game/index.ts actually writes it (0029_start_game_edge_function.sql
  // narrows game_state's INSERT policy to require enforcement off, so a
  // seated player's own client can no longer do this for such a game).
  const serviceClient = createClient(STACK_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, storageKey: 'sb-test-service-role' },
  })

  installFetch({
    db,
    tokens,
    accounts,
    edgeFunctions,
    requestLog: requests,
    // Deliberately no `profiles` row: production doesn't create one when an
    // account is made either (they're upserted lazily by the settings
    // screens), and `loadGameContext` copes with its absence.
    createUser(email, password) {
      const userId = globalThis.crypto.randomUUID()
      const accessToken = mintAccessToken(userId)
      tokenByUserId.set(userId, accessToken)
      tokens.set(accessToken, { userId, email })
      accounts.set(email, { userId, password })
      return { userId, accessToken }
    },
    deleteUser(userId) {
      const accessToken = tokenByUserId.get(userId)
      if (!accessToken) return false
      tokenByUserId.delete(userId)
      tokens.delete(accessToken)
      clients.delete(userId)
      for (const [email, account] of accounts) if (account.userId === userId) accounts.delete(email)
      db.deleteProfileFor(userId)
      return true
    },
  })

  function clientFor(userId: string): SupabaseClient {
    const token = tokenByUserId.get(userId)
    if (!token) throw new Error(`No such user in this stack: ${userId}. Call addUser()/seedStartedGame() first.`)
    let client = clients.get(userId)
    if (!client) {
      client = createClient(STACK_URL, ANON_KEY, {
        // A distinct storage key per user keeps auth-js from warning about
        // several clients sharing one browser context — each simulated
        // player is a separate browser in production.
        auth: { persistSession: false, autoRefreshToken: false, storageKey: `sb-test-${userId}` },
        global: { headers: { Authorization: `Bearer ${token}` } },
      })
      clients.set(userId, client)
    }
    return client
  }

  function addUser(userId: string, options: { isAdmin?: boolean; displayName?: string } = {}): void {
    if (tokenByUserId.has(userId)) return
    const token = mintAccessToken(userId)
    tokenByUserId.set(userId, token)
    tokens.set(token, { userId, email: `${userId}@example.test` })
    db.seed('profiles', { user_id: userId, display_name: options.displayName ?? null, is_admin: options.isAdmin ?? false })
  }

  /**
   * Mirrors gameApi.ts's `invokeGameFunction`: supabase-js reports a non-2xx
   * Edge Function response as `error` with `data: null`, hiding the function's
   * own `{ok:false, error}` body inside `error.context`. Reproducing that
   * unwrapping here is the point — it's the shape the app has to cope with.
   *
   * Generic over the whole `ok: true` success shape (not just a `state` type)
   * so this covers start-game's `{ok:true}` — no state/version to redact —
   * the same way it covers apply-action/undo-action/redo-action/get-game-state's
   * `{ok:true, state, version}`.
   */
  async function invoke<TOk extends { ok: true }>(name: EdgeFunctionName, userId: string, body: Record<string, unknown>): Promise<(TOk | { ok: false; error: string }) & { status: number }> {
    const { data, error } = await clientFor(userId).functions.invoke(name, { body })
    if (error) {
      const context = (error as { context?: Response }).context
      if (context) {
        const status = context.status
        try {
          const parsed = (await context.clone().json()) as { error?: string }
          if (parsed.error) return { ok: false, error: parsed.error, status }
        } catch {
          // Not JSON — fall through to the generic message below.
        }
        return { ok: false, error: error.message, status }
      }
      return { ok: false, error: error.message, status: 0 }
    }
    return { ...(data as TOk), status: 200 }
  }

  /**
   * apply-action/undo-action/redo-action's response is a `RedactedGameStateDelta`
   * (issue #478's redaction, patched since issue #648 against the pre-write
   * state — see `buildEnforcedActionResponseDelta`,
   * `../../../supabase/functions/_shared/gameEnforcement.ts`) — this
   * reconstructs it back to a plain `GameState` via
   * `applyRedactedGameStateDelta`, the same conversion `gameApi.ts`'s
   * `invokeGameFunction` does, so `EnforcedCallResult.state` stays a real
   * `GameState` for every existing caller (including replayFixture.ts's
   * local re-application and final fixture comparison).
   *
   * Reconstructing needs the exact pre-write state the server diffed
   * against, redacted for this same `userId` — read straight from the DB
   * (service role) *before* the call, via the same `loadGameContext`/
   * `redactedResponseState` the Edge Function itself uses, rather than
   * tracked client-side: a real client always already holds this (its own
   * `gameState`, guaranteed current or the write's own compare-and-swap
   * would have 409'd instead), but this stack's test callers routinely
   * submit a game's very first action without ever having called
   * `getGameState` first, so there is no "this caller's last response" to
   * reuse here the way a real client's `latestGameStateRef` would.
   */
  async function invokeEnforced(name: EdgeFunctionName, userId: string, gameId: string, body: Record<string, unknown>): Promise<EnforcedCallResult> {
    const ctxBefore = await loadGameContext(serviceClient, gameId, userId)
    const result = await invoke<{ ok: true; version: number } & RedactedGameStateDelta>(name, userId, body)
    if (!result.ok) return result
    if (!ctxBefore) return { ok: false, error: 'pre-write game context vanished mid-call', status: 500 }
    const previous = toClientGameState(redactedResponseState(ctxBefore, userId, ctxBefore.gameState.state))
    const state = applyRedactedGameStateDelta(previous, result)
    if (!state) return { ok: false, error: 'delta failed to reconstruct against this stack\'s own pre-write state', status: 500 }
    return { ok: true, state, version: result.version, status: result.status }
  }

  /**
   * GamePage.tsx's `writeWithRetry` for one attempt: read the row, apply the
   * transition client-side, write it back guarded by the version we read (the
   * same compare-and-swap `gameApi.ts`'s `writeGameState` uses, and the same
   * RLS an ordinary player's write goes through). No retry loop — a replay is
   * single-threaded, so losing the race would mean a bug in the harness, not
   * a concurrent player.
   */
  async function writeClientTrusted(
    userId: string,
    gameId: string,
    transition: (state: GameState) => { ok: true; state: GameState } | { ok: false; error: string },
  ): Promise<EnforcedCallResult> {
    const client = clientFor(userId)
    const { data: row, error: readError } = await client.from('game_state').select('state, version').eq('game_id', gameId).maybeSingle()
    if (readError) return { ok: false, error: readError.message, status: 500 }
    if (!row) return { ok: false, error: 'Game not found, or has no state yet (still in the lobby?).', status: 404 }

    const state = await decompressGameStateFromStorage(row.state as StoredGameState)
    const result = transition(state)
    if (!result.ok) return { ok: false, error: result.error, status: 400 }

    const expectedVersion = row.version as number
    const { data, error } = await client
      .from('game_state')
      .update({ state: result.state, turn: result.state.turn, active_player_id: result.state.activePlayerId, version: expectedVersion + 1 })
      .eq('game_id', gameId)
      .eq('version', expectedVersion)
      .select('version')
    if (error) return { ok: false, error: error.message, status: 500 }
    if ((data?.length ?? 0) === 0) {
      // Zero rows changed is either a lost race or RLS refusing the write —
      // indistinguishable to a client, which is exactly what 0026 relies on.
      return { ok: false, error: 'Game state changed concurrently, or this game is not writable directly — refetch and retry.', status: 409 }
    }
    return { ok: true, state: result.state, version: expectedVersion + 1, status: 200 }
  }

  // A real overloaded function, not an inline arrow assigned to the object
  // literal's `getGameState` property below — only a genuine overloaded
  // declaration+implementation is assignable to ProductionStack's own
  // overloaded `getGameState` member (see that interface's own doc comment
  // for why the no-`sinceActionIndex` overload matters to callers).
  function getGameState(userId: string, gameId: string): Promise<GameStateReadResult>
  function getGameState(userId: string, gameId: string, sinceActionIndex: number, baseVersion?: number): Promise<GameStateReadResult | GameStateDeltaReadResult>
  function getGameState(userId: string, gameId: string, sinceActionIndex?: number, baseVersion?: number) {
    return invoke<{ ok: true; state: RedactedGameState; version: number } | ({ ok: true; version: number } & RedactedGameStateDelta)>(
      'get-game-state',
      userId,
      sinceActionIndex === undefined ? { gameId } : { gameId, sinceActionIndex, ...(baseVersion === undefined ? {} : { baseVersion }) },
    )
  }

  return {
    url: STACK_URL,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
    db,
    requests,
    clientFor,
    anonClient: () => createClient(STACK_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'sb-test-anon' } }),
    addUser,

    async seedStartedGame({ game, players, genesis, admins = [] }) {
      addUser(game.created_by, { isAdmin: admins.includes(game.created_by) })
      for (const player of players) addUser(player.user_id, { isAdmin: admins.includes(player.user_id), displayName: player.display_name })
      db.seed('games', game as unknown as Record<string, unknown>)
      for (const player of players) db.seed('players', player as unknown as Record<string, unknown>)

      // gameApi.ts's insertGameState, verbatim in shape — an uncompressed
      // GameState written directly. A non-enforced game really is written
      // this way by a seated player (0001_init_schema.sql's INSERT policy);
      // an enforced game's genesis now comes from start-game/index.ts's
      // service-role client instead (0029_start_game_edge_function.sql), so
      // this uses whichever actor a real one of each kind would.
      const insertingClient = game.settings.ruleEnforcementEnabled ? serviceClient : clientFor(players[0].user_id)
      const { error } = await insertingClient
        .from('game_state')
        .insert({ game_id: game.id, state: genesis, turn: genesis.turn, active_player_id: genesis.activePlayerId })
      if (error) throw new Error(`Seeding the genesis game_state row failed: ${error.message}`)
    },

    async readGameState(userId, gameId) {
      const { data, error } = await clientFor(userId).from('game_state').select('state, version').eq('game_id', gameId).maybeSingle()
      if (error) throw new Error(`${error.code ?? ''} ${error.message}`.trim())
      if (!data) return null
      return { state: await decompressGameStateFromStorage(data.state as StoredGameState), version: data.version as number }
    },

    getGameState,
    applyAction: (userId, gameId, action) => invokeEnforced('apply-action', userId, gameId, { gameId, action }),
    undoAction: (userId, gameId) => invokeEnforced('undo-action', userId, gameId, { gameId }),
    redoAction: (userId, gameId) => invokeEnforced('redo-action', userId, gameId, { gameId }),
    startGame: (userId, gameId) => invoke<{ ok: true }>('start-game', userId, { gameId }),

    applyActionClientTrusted: (userId, gameId, action, content) =>
      writeClientTrusted(userId, gameId, (state) =>
        applyAction(state, action, content.unitContent, content.achievementContent, content.boardGenerationContent, content.taleContent),
      ),
    undoActionClientTrusted: (userId, gameId, playerId, genesis, content) =>
      writeClientTrusted(userId, gameId, (state) =>
        applyUndoAction(genesis, state, playerId, content.unitContent, content.achievementContent, content.boardGenerationContent, content.taleContent),
      ),
    redoActionClientTrusted: (userId, gameId, playerId, genesis, content) =>
      writeClientTrusted(userId, gameId, (state) =>
        applyRedoAction(genesis, state, playerId, content.unitContent, content.achievementContent, content.boardGenerationContent, content.taleContent),
      ),

    dispose: restoreFetch,
  }
}
