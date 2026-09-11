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
import { remapFixtureToRoom, type RemappedFixture, type RoomIdentity } from './remapFixture.ts'

export interface LiveProjectConfig {
  url: string
  anonKey: string
  serviceRoleKey: string
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

/** A short, room-name-safe label — `games.name` is capped at 60 chars by 0012_room_name.sql. */
function roomName(fixtureName: string): string {
  return `[smoke] ${fixtureName}`.slice(0, 60)
}

function randomPassword(): string {
  return `Smoke-${globalThis.crypto.randomUUID()}`
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
async function invoke(client: SupabaseClient, name: string, body: Record<string, unknown>): Promise<EnforcedCallResult> {
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
  const result = data as { ok: true; state: RedactedGameState; version: number }
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
export async function provisionLiveRoom(config: LiveProjectConfig, fixture: ProductionGameFixture): Promise<LiveRoom> {
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
        name: roomName(fixture.name),
        play_mode: 'live',
        created_by: ownerUserId,
        min_players: fixture.finalState.players.length,
        max_players: fixture.finalState.players.length,
        settings: { ...fixture.game.settings, ruleEnforcementEnabled: true },
        visibility: 'private',
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
      if (error) throw new Error(`Could not seat ${player.displayName}: ${error.message}`)
      players.push(data as PlayerRow)
    }

    const identity: RoomIdentity = {
      gameId,
      playerIdByOriginalId: Object.fromEntries(fixture.finalState.players.map((player, index) => [player.id, players[index].id])),
      userIdByOriginalPlayerId,
    }
    const remapped = remapFixtureToRoom(fixture, identity)

    // LobbyPage's resolve-then-persist step: whatever `buildGenesisState`
    // needs that isn't already on the row (a recovered preset board, a
    // resolved "build alone" builder and turn order) is pinned now, in this
    // room's ids, so genesis is a deterministic function of the row alone.
    const { data: pinnedGame, error: settingsError } = await ownerClient
      .from('games')
      .update({ settings: remapped.settings })
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

    const game: GameRow = { ...(gameRow as GameRow), settings: remapped.settings }

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

    return {
      game,
      players,
      genesis,
      remapped,
      applyAction: (userId, _gameId, action: Action) => invoke(clientFor(userId), 'apply-action', { gameId, action }),
      undoAction: (userId) => invoke(clientFor(userId), 'undo-action', { gameId }),
      redoAction: (userId) => invoke(clientFor(userId), 'redo-action', { gameId }),
      async readGameState() {
        // Ground truth for test assertions, not a simulation of any app read
        // path (contrast supabaseStack's `readGameState(userId, ...)`, which
        // deliberately reads as a specific actor to exercise RLS) — so this
        // reads as the service role, bypassing RLS entirely. It has to:
        // since 0028_hidden_information_rls_lockdown.sql (issue #488), even
        // the seated `ownerClient` this used to read as gets nothing back
        // for a hiddenInformationEnabled room, which every room this file
        // provisions for the wire check is.
        const { data, error } = await admin.from('game_state').select('state, version').eq('game_id', gameId).maybeSingle()
        if (error) throw new Error(`Could not read the smoke room's state: ${error.message}`)
        if (!data) return null
        return { state: await decompressGameStateFromStorage(data.state as StoredGameState), version: data.version as number }
      },
      clientFor,
      teardown,
    }
  } catch (error) {
    await teardown()
    throw error
  }
}
