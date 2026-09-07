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
import type { GameState } from '../../engine/types.ts'
import type { GameRow, PlayerRow } from '../../lib/dbTypes.ts'
import { decompressGameStateFromStorage, type StoredGameState } from '../../lib/gameStateCompression.ts'
import { Database, type GameStateRow, type ProfileRow } from './database.ts'
import { loadEdgeFunctions, type EdgeFunctionName } from './edgeFunctions.ts'
import { ANON_KEY, SERVICE_ROLE_KEY, STACK_URL, serveStackRequest, type EdgeFunctionHandler, type ServerOptions, type TokenRegistry } from './httpServer.ts'

export { Database, STACK_URL, ANON_KEY, SERVICE_ROLE_KEY }
export type { GameStateRow, ProfileRow }

/** Mirrors gameApi.ts's GameEnforcementResult, plus the HTTP status so a test can assert 403 vs 409 vs 400. */
export type EnforcedCallResult = ({ ok: true; state: GameState; version: number } | { ok: false; error: string }) & { status: number }

export interface ProductionStack {
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
  /** gameApi.ts's getGameState, as `userId` — decompressed, RLS-gated, null if the row isn't readable or doesn't exist. */
  readGameState(userId: string, gameId: string): Promise<{ state: GameState; version: number } | null>
  /** Submits `action` to the real apply-action Edge Function as `userId`, the way gameApi.ts's applyActionEnforced does. */
  applyAction(userId: string, gameId: string, action: Action): Promise<EnforcedCallResult>
  undoAction(userId: string, gameId: string): Promise<EnforcedCallResult>
  redoAction(userId: string, gameId: string): Promise<EnforcedCallResult>
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
  const requests: string[] = []
  const edgeFunctions: Map<string, EdgeFunctionHandler> = await loadEdgeFunctions()

  installFetch({ db, tokens, edgeFunctions, requestLog: requests })

  const tokenByUserId = new Map<string, string>()
  const clients = new Map<string, SupabaseClient>()

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
   */
  async function invoke(name: EdgeFunctionName, userId: string, body: Record<string, unknown>): Promise<EnforcedCallResult> {
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
    return { ...(data as { ok: true; state: GameState; version: number }), status: 200 }
  }

  return {
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
      // GameState written by a seated player, which is what every game in
      // production starts from regardless of its enforcement setting.
      const { error } = await clientFor(players[0].user_id)
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

    applyAction: (userId, gameId, action) => invoke('apply-action', userId, { gameId, action }),
    undoAction: (userId, gameId) => invoke('undo-action', userId, { gameId }),
    redoAction: (userId, gameId) => invoke('redo-action', userId, { gameId }),

    dispose: restoreFetch,
  }
}
