// Talks to a real, deployed Supabase project the way a browser does: the same
// `@supabase/supabase-js`, the same anon key, a real signed-in session per
// seat, and the same `apply-action`/`undo-action`/`redo-action` Edge Function
// calls `gameApi.ts` makes. Nothing here is a double — this is the half of the
// testing story `src/test/supabaseStack/` deliberately cannot cover, because
// what it verifies is that *the deployment* works: migrations actually
// applied, functions actually deployed, RLS actually as written.
//
// It satisfies `ReplayTarget` (src/test/supabaseStack/replayFixture.ts), so
// the same replay routine that drives the in-process stack drives this, and
// a production run and a CI run disagree about nothing except the network.
//
// Isolation is the whole safety story, since this writes to the live project:
//
// - Throwaway users per run, created and deleted through the admin API, so no
//   standing credentials and no pollution of the real user list.
// - A `private` room, so it never appears on the Public Rooms screen.
// - `play_mode: 'live'`, never 'async' — both notification functions
//   early-return on any other mode (`play_mode !== 'async'`), so a replay
//   can't page anyone. Play mode is not part of the rules: the engine only
//   carries it, and the enforcement path treats live and async identically
//   (`isAuthorizedToActAs` requires an exact seat match for both).
// - Teardown deletes the game *before* the users. `games.created_by` and
//   `players.user_id` reference `auth.users` with no `on delete cascade`
//   (0001_init_schema.sql), so the other order fails on a foreign key and
//   strands the room.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Action } from '../../engine/actions.ts'
import { toClientGameState, type RedactedGameState } from '../../engine/redaction.ts'
import type { GameState } from '../../engine/types.ts'
import type { GameRow, PlayerRow } from '../../lib/dbTypes.ts'
import { decompressGameStateFromStorage, type StoredGameState } from '../../lib/gameStateCompression.ts'
import type { ProductionGameFixture } from '../fixtures/productionGames/loadFixtures.ts'
import type { EnforcedCallResult } from '../supabaseStack/index.ts'
import type { ReplayTarget } from '../supabaseStack/replayFixture.ts'
import { buildDeltaReplayContextFromState, type DeltaReplayContext } from '../../lib/deltaReplayContext.ts'
import { applyReplayDelta, deriveBaseFromView, type ReplayDeltaFailure, type ReplayDeltaResponse } from '../../lib/replayDelta.ts'
import { remapFixtureToRoom, type RemappedFixture, type RoomIdentity } from './remapFixture.ts'

/**
 * Default ceiling on a fixture's average apply-action/undo-action/redo-action
 * round trip, in milliseconds, before ./runSmoke.ts fails the run outright.
 * Historically ~860-890ms/action against a live project; a regression that
 * roughly doubles that (todo.md #139 — a reverted attempt at #648) is exactly
 * what this is sized to catch, with headroom left for ordinary network
 * jitter. Override with SMOKE_MAX_AVERAGE_ACTION_MS.
 */
export const DEFAULT_MAX_AVERAGE_ACTION_MS = 1500

export interface LiveProjectConfig {
  url: string
  anonKey: string
  serviceRoleKey: string
  /**
   * See DEFAULT_MAX_AVERAGE_ACTION_MS. Optional so every in-process caller
   * (productionSmokeRunner.test.ts and friends, which build this object by
   * hand from the in-process stack's own url/keys) doesn't have to name it —
   * ./runSmoke.ts falls back to the default itself.
   */
  maxAverageActionMs?: number
}

/** Reads config from the environment, or explains exactly what is missing. */
export function liveProjectConfigFromEnv(env: Record<string, string | undefined>): LiveProjectConfig {
  const missing = ['SMOKE_SUPABASE_URL', 'SMOKE_SUPABASE_ANON_KEY', 'SMOKE_SUPABASE_SERVICE_ROLE_KEY'].filter((name) => !env[name])
  if (missing.length > 0) {
    throw new Error(`The production smoke test needs ${missing.join(', ')} in the environment — see .github/workflows/smoke.yml.`)
  }
  return {
    url: env.SMOKE_SUPABASE_URL!,
    anonKey: env.SMOKE_SUPABASE_ANON_KEY!,
    serviceRoleKey: env.SMOKE_SUPABASE_SERVICE_ROLE_KEY!,
    maxAverageActionMs: env.SMOKE_MAX_AVERAGE_ACTION_MS ? Number(env.SMOKE_MAX_AVERAGE_ACTION_MS) : DEFAULT_MAX_AVERAGE_ACTION_MS,
  }
}

export interface LiveRoom extends ReplayTarget {
  game: GameRow
  players: PlayerRow[]
  genesis: GameState
  /** The fixture, expressed in this room's ids. */
  remapped: RemappedFixture
  readGameState(): Promise<{ state: GameState; version: number } | null>
  /**
   * The same service-role read as `readGameState`, under the name
   * ../supabaseStack/replayFixture.ts's `ReplayTarget` asks for it by. A
   * replay has to keep its own copy of the *true* state to decide whether a
   * logged entry is a stale forced follow-up, and for a
   * `hiddenInformationEnabled` room the Edge Function response it would
   * otherwise use is redacted for the acting seat. Kept as a separate member
   * rather than renaming `readGameState`, because `ProductionStack`'s
   * `readGameState(userId, gameId)` — which reads as a specific actor, on
   * purpose — already owns that name with a different signature.
   */
  readTrueState(): Promise<{ state: GameState; version: number } | null>
  /**
   * `get-game-state` as one seat, through the same protocol-2 client the
   * write calls use — so the read path's delta branch is exercised too, and
   * not only against a seat that has just written.
   */
  readAs(userId: string): Promise<EnforcedCallResult>
  /** What this room's protocol-2 traffic looked like. Accumulates across every call made through it. */
  protocolStats: ProtocolStats
  /**
   * The signed-in client for one of this room's seats — the same one
   * `applyAction`/`undoAction`/`redoAction` invoke Edge Functions through.
   * Exposed for HIDDEN_INFORMATION_PLAN.md §8 phase 9's wire-level check
   * (../hiddenInformationWire.ts), which needs the raw, uncollapsed response
   * body `invoke()` above would otherwise discard, and a real Realtime
   * subscription — neither of which fits this file's existing `applyAction`-
   * shaped surface.
   */
  clientFor(userId: string): SupabaseClient
  /** Deletes the room and then the throwaway users. Safe to call twice. */
  teardown(): Promise<void>
}

/**
 * How a room differs from the smoke test's own. Defaults reproduce exactly
 * what this file did before the options existed, so the smoke path is
 * unchanged by their presence.
 */
export interface LiveRoomOptions {
  /**
   * `private` (the default) keeps a room off the Public Rooms screen, which is
   * one of this file's isolation rules. The preview seeder overrides it to
   * `public` on purpose: a seeded game nobody can find is no use for manual
   * testing (../previewSeed/seedFinishedGame.ts).
   */
  visibility?: 'private' | 'public'
  /** Prefixes `games.name`, so a room's origin is legible in a room list. */
  namePrefix?: string
  /**
   * Overrides `games.settings.hiddenInformationEnabled` for this room,
   * whatever the fixture recorded. The smoke runner sets it to `true`
   * (../productionSmoke/runSmoke.ts): none of the checked-in exports was
   * played with hidden information on, so without this the replay would
   * never reach `redactStateForPlayer` on a deployed project and the only
   * live coverage of redaction would be ./hiddenInformationWire.ts's single
   * leak check. Left undefined — the default — the fixture's own setting
   * stands, which is what the preview seeder and the wire check both want.
   */
  hiddenInformation?: boolean
}

/** A short, room-name-safe label — `games.name` is capped at 60 chars by 0012_room_name.sql. */
function roomName(fixtureName: string, prefix: string): string {
  return `${prefix} ${fixtureName}`.slice(0, 60)
}

function randomPassword(): string {
  return `Smoke-${globalThis.crypto.randomUUID()}`
}

/**
 * What a run's protocol-2 traffic actually looked like, so
 * ./runSmoke.ts can assert on it rather than take the deployed
 * functions' word for it.
 *
 * `fullResponses` is not a failure count. The server decides a delta is not
 * worth sending in two legitimate cases — a caller with no `sinceActionIndex`
 * (a seat's very first call, since a browser starts with an empty cache too),
 * and a redacted game whose safe prefix moved *backwards*, which is a real
 * thing: it is not monotonic (a measured 173 -> 104), and get-game-state
 * answers `prefix-moved-back` with a full state. `rebuildFailures` is the
 * count that matters: each one is this client being handed a delta and failing
 * to reproduce the state the server said it would.
 */
export interface ProtocolStats {
  /** Deltas received and successfully rebuilt and hash-verified. */
  deltaResponses: number
  /** Full states received — a first call for a seat, or the server declining to send a delta. */
  fullResponses: number
  /** One entry per delta this client could not reproduce, with `applyReplayDelta`'s own reason. */
  rebuildFailures: ReplayDeltaFailure[]
}

/**
 * Mirrors gameApi.ts's `invokeGameFunction`: supabase-js reports a non-2xx
 * Edge Function response as `error` with `data: null`, hiding the function's
 * own `{ok:false, error}` body inside `error.context`. The app has to reach
 * in there, so a test of the app's backend does too. Also mirrors that
 * function's `toClientGameState` collapse of the `RedactedGameState`-shaped
 * success response (issue #478) back into a plain `GameState`, so
 * `replayFixtureThroughStack`'s local re-application and final fixture
 * comparison see the same shape they always have.
 */
type RawInvokeResult = { ok: true; data: unknown } | { ok: false; error: string; status: number }

/** The error-unwrapping half of `invoke` below, split out so the protocol-2 client can reuse it without also collapsing the success body. */
async function rawInvoke(client: SupabaseClient, name: string, body: Record<string, unknown>): Promise<RawInvokeResult> {
  const { data, error } = await client.functions.invoke(name, { body })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context) {
      const status = context.status
      try {
        const parsed = (await context.clone().json()) as { error?: string }
        if (parsed.error) return { ok: false, error: parsed.error, status }
      } catch {
        // Not JSON — fall through to the generic message.
      }
      return { ok: false, error: error.message, status }
    }
    return { ok: false, error: error.message, status: 0 }
  }
  return { ok: true, data }
}

async function invoke(client: SupabaseClient, name: string, body: Record<string, unknown>): Promise<EnforcedCallResult> {
  const raw = await rawInvoke(client, name, body)
  if (!raw.ok) return raw
  const result = raw.data as { ok: true; state: RedactedGameState; version: number }
  return { ok: true, state: toClientGameState(result.state), version: result.version, status: 200 }
}

/**
 * Same response-unwrapping as invoke() above, but for start-game
 * (supabase/functions/start-game/index.ts), whose success response is just
 * `{ok:true}` — no state/version to redact or collapse.
 */
async function invokeStartGame(client: SupabaseClient, gameId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await client.functions.invoke('start-game', { body: { gameId } })
  if (!error) return { ok: true }
  const context = (error as { context?: Response }).context
  if (context) {
    try {
      const parsed = (await context.clone().json()) as { error?: string }
      if (parsed.error) return { ok: false, error: parsed.error }
    } catch {
      // Not JSON — fall through to the generic message below.
    }
  }
  return { ok: false, error: error.message }
}

/**
 * Creates one throwaway account per seat, opens a room, seats everyone, pins
 * the settings this game's genesis needs, and starts it — the same sequence
 * CreateGamePage.tsx and LobbyPage.tsx's `handleStart` perform (resolve
 * settings, then — since this room is always `ruleEnforcementEnabled` — the
 * `start-game` Edge Function, not a direct client write: it re-resolves the
 * roster itself, writes genesis, and flips `games.status` to 'active' under
 * its own service-role client, per `0029_start_game_edge_function.sql`).
 *
 * Every step runs as the user who would really do it: each player seats
 * themselves (0001's `users can seat themselves` policy checks
 * `user_id = auth.uid()`), and only the owner edits settings or starts the
 * game. A failure part-way through tears down whatever was created before
 * rethrowing, so a broken run doesn't leave a room behind.
 */
export async function provisionLiveRoom(config: LiveProjectConfig, fixture: ProductionGameFixture, options: LiveRoomOptions = {}): Promise<LiveRoom> {
  const { visibility = 'private', namePrefix = '[smoke]', hiddenInformation } = options
  // Applied to both the room's initial settings and the resolved ones pinned
  // before start-game, since genesis — and so `GameState.hiddenInformationEnabled`,
  // which is what gameEnforcement.ts's `shouldRedact` actually reads — is
  // built from the row as it stands at start.
  const hiddenInformationOverride = hiddenInformation === undefined ? {} : { hiddenInformationEnabled: hiddenInformation }
  const admin = createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const createdUserIds: string[] = []
  let gameId: string | null = null

  const teardown = async () => {
    if (gameId) {
      // 0008_room_lifecycle.sql only allows deleting a room in 'lobby' or
      // 'canceled', so cancel first. Service role bypasses RLS either way,
      // but going through the same states the app does keeps this honest.
      await admin.from('games').update({ status: 'canceled' }).eq('id', gameId)
      await admin.from('games').delete().eq('id', gameId)
      gameId = null
    }
    for (const userId of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(userId)
    }
  }

  try {
    const clientByUserId = new Map<string, SupabaseClient>()
    const userIdByOriginalPlayerId: Record<string, string> = {}

    for (const player of fixture.finalState.players) {
      const email = `rf-smoke-${globalThis.crypto.randomUUID()}@example.com`
      const password = randomPassword()
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      if (error || !data.user) throw new Error(`Could not create a throwaway user: ${error?.message ?? 'no user returned'}`)
      createdUserIds.push(data.user.id)
      userIdByOriginalPlayerId[player.id] = data.user.id

      const client = createClient(config.url, config.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, storageKey: `sb-smoke-${data.user.id}` },
      })
      const { error: signInError } = await client.auth.signInWithPassword({ email, password })
      if (signInError) throw new Error(`Could not sign in the throwaway user: ${signInError.message}`)
      clientByUserId.set(data.user.id, client)
    }

    const [ownerPlayer] = fixture.finalState.players
    const ownerUserId = userIdByOriginalPlayerId[ownerPlayer.id]
    const ownerClient = clientByUserId.get(ownerUserId)!

    // Mirrors gameApi.ts's createGame, minus the parts a smoke room fixes:
    // a private room, 'live' mode, and this game's own seat count.
    const { data: gameRow, error: gameError } = await ownerClient
      .from('games')
      .insert({
        room_code: `S${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`,
        name: roomName(fixture.name, namePrefix),
        play_mode: 'live',
        created_by: ownerUserId,
        min_players: fixture.finalState.players.length,
        max_players: fixture.finalState.players.length,
        settings: { ...fixture.game.settings, ruleEnforcementEnabled: true, ...hiddenInformationOverride },
        visibility,
      })
      .select()
      .single()
    if (gameError) throw new Error(`Could not create the smoke room: ${gameError.message}`)
    gameId = (gameRow as GameRow).id

    const players: PlayerRow[] = []
    for (const [seatIndex, player] of fixture.finalState.players.entries()) {
      const userId = userIdByOriginalPlayerId[player.id]
      const { data, error } = await clientByUserId
        .get(userId)!
        .from('players')
        // The fixture's own display name and colour, so the state this room
        // ends on is comparable to the exported one field for field.
        .insert({ game_id: gameId, user_id: userId, display_name: player.displayName, avatar_url: null, seat_index: seatIndex, color: player.color })
        .select()
        .single()
      // Identifies the seat by colour, not displayName: this error can end up
      // in a failed run's log tail, which becomes a public GitHub issue body.
      if (error) throw new Error(`Could not seat the ${player.color} seat: ${error.message}`)
      players.push(data as PlayerRow)
    }

    const identity: RoomIdentity = {
      gameId,
      playerIdByOriginalId: Object.fromEntries(fixture.finalState.players.map((player, index) => [player.id, players[index].id])),
      userIdByOriginalPlayerId,
    }
    const remapped = remapFixtureToRoom(fixture, identity)
    const roomSettings = { ...remapped.settings, ...hiddenInformationOverride }

    // LobbyPage's resolve-then-persist step: whatever `buildGenesisState`
    // needs that isn't already on the row (a recovered preset board, a
    // resolved "build alone" builder and turn order) is pinned now, in this
    // room's ids, so genesis is a deterministic function of the row alone.
    const { data: pinnedGame, error: settingsError } = await ownerClient
      .from('games')
      .update({ settings: roomSettings })
      .eq('id', gameId)
      .select('config_version')
      .single()
    if (settingsError) throw new Error(`Could not pin the room's settings: ${settingsError.message}`)

    // Pinning settings after everyone's already seated bumps config_version
    // past whatever each player's seat-time ready_for_version was set to
    // (0009_config_versioning.sql) — a real lobby's players would just click
    // Ready again; do the same here so start-game's own canStartGame check
    // (below) doesn't see a room that looks un-ready.
    const configVersion = (pinnedGame as { config_version: number }).config_version
    for (const player of players) {
      if (player.user_id === ownerUserId) continue
      const { error: readyError } = await clientByUserId
        .get(player.user_id)!
        .from('players')
        .update({ ready_for_version: configVersion })
        .eq('id', player.id)
      if (readyError) throw new Error(`Could not mark ${player.display_name} ready: ${readyError.message}`)
    }

    const game: GameRow = { ...(gameRow as GameRow), settings: roomSettings }

    // 0029_start_game_edge_function.sql: this room is always
    // ruleEnforcementEnabled (see the games.insert above), so genesis is no
    // longer a direct client write — the start-game Edge Function resolves
    // the roster itself, writes `game_state`, and flips `games.status` to
    // 'active', all under its own service-role client.
    const startResult = await invokeStartGame(ownerClient, gameId)
    if (!startResult.ok) throw new Error(`Could not start the smoke room: ${startResult.error}`)

    // Read the row straight back afterward for the actual (server-computed)
    // genesis this room started from — the same deterministic
    // `buildGenesisState(game, players)` output either way, just produced
    // server-side now. Through get-game-state rather than a direct table
    // select: this room may also have `hiddenInformationEnabled` on, and
    // 0028_hidden_information_rls_lockdown.sql makes such a game's
    // `game_state` row invisible to a direct SELECT entirely, seated player
    // or not (redaction can't happen within a row) — genesis has no
    // actionHistory to redact yet, so this is a no-op collapse either way.
    const readResult = await invoke(ownerClient, 'get-game-state', { gameId })
    if (!readResult.ok) throw new Error(`Could not read the smoke room's genesis: ${readResult.error}`)
    const genesis = readResult.state

    const clientFor = (userId: string): SupabaseClient => {
      const client = clientByUserId.get(userId)
      if (!client) throw new Error(`No signed-in client for user ${userId} in this smoke room.`)
      return client
    }

    // --- The protocol-2 client (issue #648/#693) -------------------------
    //
    // Neither smoke file used to send `protocol`/`sinceActionIndex` at all, so
    // every deployed response came back `shape: "full", reason: "protocol-1"`
    // and the delta path — the rebuild, the in-flight overlay, the hash check —
    // had no coverage against a real project whatsoever. It has it now: every
    // call below asks for a delta as soon as it has a base to apply one to.
    //
    // A cache per *seat*, not per room, because that is what the world looks
    // like: each seat is a separate browser holding its own IndexedDB entry,
    // and a seat's cache only advances when that seat itself calls. So a
    // request's `sinceActionIndex` is usually several entries behind the row,
    // and the append it gets back is a multi-entry one — which is the case
    // `extendReplay` has to fold undo/redo markers through, and the case a
    // single-action test never reaches.
    //
    // The logic is gameApi.ts's own (`applyReplayDelta`, `deriveBaseFromView`,
    // imported from src/lib/replayDelta.ts), deliberately: a smoke test that
    // reimplemented the client half would prove the deployment agrees with the
    // test, not that it agrees with the app.
    const replayContext: DeltaReplayContext | null = buildDeltaReplayContextFromState(game, genesis)
    // The base — the unredacted-replayable state — not the rendered view, the
    // same distinction GamePage.tsx's `latestBaseRef` draws.
    const baseByUserId = new Map<string, GameState>()
    const protocolStats: ProtocolStats = { deltaResponses: 0, fullResponses: 0, rebuildFailures: [] }

    async function invokeWithDelta(userId: string, name: string, body: Record<string, unknown>): Promise<EnforcedCallResult> {
      const base = baseByUserId.get(userId)
      const useDelta = Boolean(base && replayContext)
      const raw = await rawInvoke(clientFor(userId), name, {
        ...body,
        ...(useDelta ? { sinceActionIndex: base!.actionHistory.length, protocol: 2 } : {}),
      })
      if (!raw.ok) return raw
      const result = raw.data as ({ ok: true; state: RedactedGameState; version: number }) | ({ ok: true } & ReplayDeltaResponse)

      if (useDelta && 'stateHash' in result && 'actionHistoryAppend' in result) {
        const rebuilt = applyReplayDelta(base!, replayContext!, result)
        if (rebuilt.ok) {
          protocolStats.deltaResponses += 1
          baseByUserId.set(userId, rebuilt.base)
          return { ok: true, state: rebuilt.state, version: result.version, status: 200 }
        }
        // The app answers a miss with one full fetch and carries on, so this
        // does too — but it records the reason, and runSmoke.ts fails the run
        // on any of them. A miss here means the deployed engine and this
        // checkout's engine disagree about what the game is, which is exactly
        // the class of deployment problem this file exists to catch.
        protocolStats.rebuildFailures.push(rebuilt.reason)
        const fresh = await rawInvoke(clientFor(userId), 'get-game-state', { gameId, fallbackReason: rebuilt.reason })
        if (!fresh.ok) return fresh
        return collapseFull(userId, fresh.data, result.version)
      }

      if (!('state' in result)) {
        // A delta with no replay context to apply it with — only reachable if
        // `replayContext` is null, in which case `useDelta` was false and the
        // server should not have sent one.
        return { ok: false, error: `${name} answered with a protocol-2 delta this client never asked for.`, status: 200 }
      }
      return collapseFull(userId, raw.data, result.version)
    }

    /** A full response: collapse it the way gameApi.ts does, and re-derive the base to send with the next call. */
    function collapseFull(userId: string, data: unknown, version: number): EnforcedCallResult {
      const result = data as { ok: true; state: RedactedGameState; version: number }
      protocolStats.fullResponses += 1
      const state = toClientGameState(result.state)
      if (replayContext) {
        const derived = deriveBaseFromView(state, replayContext)
        if (derived) baseByUserId.set(userId, derived)
        else baseByUserId.delete(userId)
      }
      return { ok: true, state, version: result.version ?? version, status: 200 }
    }

    // Ground truth for test assertions, not a simulation of any app read
    // path (contrast supabaseStack's `readGameState(userId, ...)`, which
    // deliberately reads as a specific actor to exercise RLS) — so this
    // reads as the service role, bypassing RLS entirely. It has to: since
    // 0028_hidden_information_rls_lockdown.sql (issue #488), even the seated
    // `ownerClient` this used to read as gets nothing back for a
    // hiddenInformationEnabled room, which — since the smoke runner passes
    // `hiddenInformation: true` — is now every room this file provisions,
    // not just the wire check's.
    const readTrueState = async () => {
      const { data, error } = await admin.from('game_state').select('state, version').eq('game_id', gameId).maybeSingle()
      if (error) throw new Error(`Could not read the smoke room's state: ${error.message}`)
      if (!data) return null
      return { state: await decompressGameStateFromStorage(data.state as StoredGameState), version: data.version as number }
    }

    return {
      game,
      players,
      genesis,
      remapped,
      applyAction: (userId, _gameId, action: Action) => invokeWithDelta(userId, 'apply-action', { gameId, action }),
      undoAction: (userId) => invokeWithDelta(userId, 'undo-action', { gameId }),
      redoAction: (userId) => invokeWithDelta(userId, 'redo-action', { gameId }),
      readAs: (userId) => invokeWithDelta(userId, 'get-game-state', { gameId }),
      protocolStats,
      readGameState: readTrueState,
      readTrueState,
      clientFor,
      teardown,
    }
  } catch (error) {
    await teardown()
    throw error
  }
}
