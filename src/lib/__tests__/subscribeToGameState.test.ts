// @vitest-environment node
//
// Regression test for issue #646: subscribeToGameState used to discard the
// realtime `game_state_meta` payload entirely and unconditionally pay for a
// fresh fetchState() HTTP round trip, even though the payload already carries
// the row's new `version` and the caller (GamePage.tsx's applyGameStateSnapshot)
// was going to throw the result away anyway whenever it wasn't newer than
// what's already applied. The common case this wastes bandwidth on: a
// player's own submitted move already applied the resulting state locally,
// then the `game_state_sync_meta` trigger's own update to `game_state_meta`
// echoes back over the same client's realtime subscription.
//
// This stack (src/test/supabaseStack/) doesn't model Realtime itself
// (database.ts's own doc comment) — only Postgres and the Deno runtime are
// doubles, everything else, including the websocket transport, would be the
// real thing, which a plain Node test runner can't open a real connection
// over. So instead of a live socket, `supabase.channel(...)` is replaced with
// a stub that captures the `postgres_changes` handler subscribeToGameState
// registers and lets the test invoke it directly with a synthetic payload —
// everything downstream of that handler (the version comparison, the
// conditional fetchState() call, and that fetch's real HTTP round trip
// through the stack) is the real gameApi.ts code running unmodified.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import type { GameRow, GameSettings, PlayerRow } from '../dbTypes.ts'
import { buildGenesisState } from '../gameGenesis.ts'

let currentClient: SupabaseClient
vi.mock('../supabase', () => ({
  get supabase() {
    return currentClient
  },
}))

const { subscribeToGameState } = await import('../gameApi.ts')
const { createProductionStack } = await import('../../test/supabaseStack/index.ts')
const { nextLegalAction, resolveGameContent } = await import('../../test/supabaseStack/sampleGame.ts')
type ProductionStack = Awaited<ReturnType<typeof createProductionStack>>

const GAME_ID = '3f1c2d4e-0000-4000-8000-000000000646'
const ALICE = 'auth-user-alice'
const BOB = 'auth-user-bob'

function settings(): GameSettings {
  return {
    mapTemplateId: 'classic',
    mapPoolBoard: null,
    mapPoolMapId: null,
    mapPoolRandomAtStart: false,
    soloBuildMap: false,
    soloBuilderSelection: 'owner',
    soloBuilderId: null,
    soloBuilderUnitOrder: 'last',
    soloBuilderTurnOrder: null,
    skipHotseatPassGate: false,
    ruleEnforcementEnabled: true,
    // Kept off so this reads through the plain game_state table (getGameState)
    // rather than the get-game-state Edge Function — subscribeToGameState's
    // skip decision doesn't depend on which one a game uses, and this keeps
    // the test's own request-counting simple.
    hiddenInformationEnabled: false,
    lockRevealedInformationEnabled: false,
    activeTaleIds: [],
    gameLength: 3,
  }
}

function gameRow(): GameRow {
  return {
    id: GAME_ID,
    room_code: 'BW646',
    name: 'subscribeToGameState self-test',
    play_mode: 'live',
    status: 'active',
    min_players: 2,
    max_players: 2,
    created_by: ALICE,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    settings: settings(),
    config_version: 1,
    visibility: 'private',
  }
}

const PLAYERS: PlayerRow[] = [
  { id: 'seat-alice', game_id: GAME_ID, user_id: ALICE, display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#e11', is_active: true },
  { id: 'seat-bob', game_id: GAME_ID, user_id: BOB, display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#11e', is_active: true },
] as PlayerRow[]

/**
 * Stands in for the real Realtime websocket transport (not modeled by this
 * stack — see this file's header comment): replaces `client.channel()` with a
 * stub whose `.on('postgres_changes', ...)` just remembers the handler
 * instead of wiring up a socket, so the test can fire it directly with
 * whatever `payload.new` a real `game_state_meta` change would have carried.
 */
function stubChannel(client: SupabaseClient): { fire: (newRow: { version: number }) => void; restore: () => void } {
  let handler: ((payload: { new: { version: number } }) => void) | null = null
  const fakeChannel = {
    on: (_event: string, _filter: unknown, cb: (payload: { new: { version: number } }) => void) => {
      handler = cb
      return fakeChannel
    },
    subscribe: () => fakeChannel,
  } as unknown as RealtimeChannel
  const channelSpy = vi.spyOn(client, 'channel').mockReturnValue(fakeChannel)
  const removeChannelSpy = vi.spyOn(client, 'removeChannel').mockResolvedValue('ok')
  return {
    fire: (newRow) => handler?.({ new: newRow }),
    restore: () => {
      channelSpy.mockRestore()
      removeChannelSpy.mockRestore()
    },
  }
}

/** Lets a real fetchState() round trip (through the patched-fetch stack, several awaits deep) settle before asserting on it. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Seat id -> auth user id, so a legal action's playerId can be routed to the right client. */
const USER_ID_BY_SEAT: Record<string, string> = { 'seat-alice': ALICE, 'seat-bob': BOB }

describe('subscribeToGameState (issue #646)', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
    const game = gameRow()
    const genesis = buildGenesisState(game, PLAYERS)
    await stack.seedStartedGame({ game, players: PLAYERS, genesis })
  })

  afterEach(() => {
    stack.dispose()
  })

  /** Plays one legal action (board setup's first tile placement, on a fresh genesis) through the real apply-action Edge Function, returning the version it bumped to. */
  async function playOneMove(): Promise<number> {
    const genesis = buildGenesisState(gameRow(), PLAYERS)
    const content = resolveGameContent(genesis)
    const action = nextLegalAction(genesis, content)!
    const result = await stack.applyAction(USER_ID_BY_SEAT[action.playerId ?? '']!, GAME_ID, action)
    if (!result.ok) throw new Error(`setup failed: ${result.error}`)
    return result.version
  }

  it("skips the refetch when the realtime payload's version is already applied — the submitter's own move echoing back", async () => {
    // Whichever seat submits this move already has its exact resulting
    // version applied locally the moment apply-action's own response comes
    // back, same as GamePage.tsx's runEnforced -> applyGameStateSnapshot —
    // we then simulate that same client's realtime subscription seeing the
    // trigger's own echo of that version.
    const appliedVersion = await playOneMove()

    currentClient = stack.clientFor(ALICE)
    const channel = stubChannel(currentClient)
    const onChange = vi.fn()
    const unsubscribe = subscribeToGameState(GAME_ID, onChange, false, () => appliedVersion)

    const requestsBefore = stack.requests.length
    channel.fire({ version: appliedVersion })
    // subscribeToGameState's would-be fetch is async; give it a turn so a
    // wrongly-triggered fetch has a chance to show up before we assert it didn't.
    await flush()

    expect(onChange).not.toHaveBeenCalled()
    expect(stack.requests.length).toBe(requestsBefore)

    unsubscribe()
    channel.restore()
  })

  it('still refetches when a payload version is newer than what this client already applied — a second client seeing the same event', async () => {
    const newVersion = await playOneMove()

    // A different client (a second player's tab) hasn't applied anything yet.
    currentClient = stack.clientFor(BOB)
    const channel = stubChannel(currentClient)
    const onChange = vi.fn()
    const unsubscribe = subscribeToGameState(GAME_ID, onChange, false, () => null)

    const requestsBefore = stack.requests.length
    channel.fire({ version: newVersion })
    await flush()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toMatchObject({ version: newVersion })
    expect(stack.requests.length).toBe(requestsBefore + 1)

    unsubscribe()
    channel.restore()
  })

  it('always refetches when no getAppliedVersion is supplied, same as before this change — the shape useRefetchOnVisible and the initial load rely on', async () => {
    const version = await playOneMove()

    currentClient = stack.clientFor(ALICE)
    const channel = stubChannel(currentClient)
    const onChange = vi.fn()
    const unsubscribe = subscribeToGameState(GAME_ID, onChange, false)

    const requestsBefore = stack.requests.length
    channel.fire({ version })
    await flush()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(stack.requests.length).toBe(requestsBefore + 1)

    unsubscribe()
    channel.restore()
  })
})
