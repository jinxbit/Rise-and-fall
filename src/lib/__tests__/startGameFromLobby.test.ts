// @vitest-environment node
//
// Regression test for issue #519: LobbyPage's "Start game" used to build
// genesis from whatever `players` array the React component already had in
// state, which is only as fresh as the last Realtime event that tab
// received. A third player could join the room and the host's own client
// would never notice before Start was clicked, producing a GameState sized
// for the roster the host's browser *thought* existed rather than the one
// actually seated — see gameApi.ts's startGameFromLobby doc comment.
//
// Runs against the production-simulating stack (src/test/supabaseStack/) so
// this exercises the real games/players RLS policies and gameApi.ts's own
// createGame/joinGame, not a hand-rolled fixture — the mocked `supabase`
// singleton below is swapped to whichever seat is "acting" the way a real
// browser tab would only ever be one user, letting the same gameApi.ts
// functions LobbyPage.tsx calls run for each simulated player in turn.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

let currentClient: SupabaseClient
vi.mock('../supabase', () => ({
  get supabase() {
    return currentClient
  },
}))

const { createGame, joinGame, markReady, removePlayer, startGameFromLobby, getGameState } = await import('../gameApi.ts')
const { createProductionStack } = await import('../../test/supabaseStack/index.ts')
type ProductionStack = Awaited<ReturnType<typeof createProductionStack>>

const ALICE = 'alice-user-id'
const BOB = 'bob-user-id'
const CAROL = 'carol-user-id'

describe('startGameFromLobby', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
    stack.addUser(ALICE, { displayName: 'Alice' })
    stack.addUser(BOB, { displayName: 'Bob' })
    stack.addUser(CAROL, { displayName: 'Carol' })
  })

  afterEach(() => {
    stack.dispose()
  })

  it('builds genesis from the roster actually seated in the database, not a stale snapshot the caller already had', async () => {
    currentClient = stack.clientFor(ALICE)
    const { game } = await createGame({
      name: 'Race room',
      playMode: 'live',
      userId: ALICE,
      displayName: 'Alice',
      avatarUrl: null,
      minPlayers: 2,
      maxPlayers: 4,
    })

    currentClient = stack.clientFor(BOB)
    const bobSeat = await joinGame({ game, userId: BOB, displayName: 'Bob', avatarUrl: null })
    await markReady(bobSeat.id, game.config_version)

    // Carol joins moments before Alice clicks Start. Nothing here ever
    // refreshes a client-held `players` snapshot for Alice — if
    // startGameFromLobby trusted one, it would never see this third seat.
    currentClient = stack.clientFor(CAROL)
    const carolSeat = await joinGame({ game, userId: CAROL, displayName: 'Carol', avatarUrl: null })
    await markReady(carolSeat.id, game.config_version)

    currentClient = stack.clientFor(ALICE)
    await startGameFromLobby(game)

    const stateAsAlice = await getGameState(game.id)
    expect(stateAsAlice?.state.players).toHaveLength(3)
  })

  it('refuses to start if the fresh roster no longer meets the minimum by the time Start is actually called', async () => {
    currentClient = stack.clientFor(ALICE)
    const { game } = await createGame({
      name: 'Shrinking room',
      playMode: 'live',
      userId: ALICE,
      displayName: 'Alice',
      avatarUrl: null,
      minPlayers: 2,
      maxPlayers: 4,
    })

    currentClient = stack.clientFor(BOB)
    const bobSeat = await joinGame({ game, userId: BOB, displayName: 'Bob', avatarUrl: null })
    await markReady(bobSeat.id, game.config_version)

    // Bob leaves right as Alice clicks Start (canStartGame passed when she
    // loaded the page, with Bob still seated and ready).
    currentClient = stack.clientFor(BOB)
    await removePlayer(bobSeat.id)

    currentClient = stack.clientFor(ALICE)
    await expect(startGameFromLobby(game)).rejects.toThrow(/changed/)

    const stateAsAlice = await getGameState(game.id)
    expect(stateAsAlice).toBeNull()
  })
})

// issue #519's follow-up ("perhaps start game should be an edge function?"):
// for a ruleEnforcementEnabled game, startGameFromLobby now routes through
// the start-game Edge Function instead of writing game_state/games directly
// — see gameApi.ts's own doc comment for why (making the server, not
// whichever client clicks Start, authoritative for genesis too).
describe('startGameFromLobby (ruleEnforcementEnabled)', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
    stack.addUser(ALICE, { displayName: 'Alice' })
    stack.addUser(BOB, { displayName: 'Bob' })
    stack.addUser(CAROL, { displayName: 'Carol' })
  })

  afterEach(() => {
    stack.dispose()
  })

  it('still closes the roster race from the non-enforced test above, via the server instead of a re-fetch', async () => {
    currentClient = stack.clientFor(ALICE)
    const { game } = await createGame({
      name: 'Enforced race room',
      playMode: 'live',
      userId: ALICE,
      displayName: 'Alice',
      avatarUrl: null,
      minPlayers: 2,
      maxPlayers: 4,
      ruleEnforcementEnabled: true,
    })

    currentClient = stack.clientFor(BOB)
    const bobSeat = await joinGame({ game, userId: BOB, displayName: 'Bob', avatarUrl: null })
    await markReady(bobSeat.id, game.config_version)

    // Carol joins moments before Alice clicks Start, same as the non-enforced
    // test — Alice's own client never refreshes its `players` snapshot.
    currentClient = stack.clientFor(CAROL)
    const carolSeat = await joinGame({ game, userId: CAROL, displayName: 'Carol', avatarUrl: null })
    await markReady(carolSeat.id, game.config_version)

    currentClient = stack.clientFor(ALICE)
    await startGameFromLobby(game)

    const stateAsAlice = await getGameState(game.id)
    expect(stateAsAlice?.state.players).toHaveLength(3)
    expect(stack.db.table('games').find((row) => row.id === game.id)?.status).toBe('active')
  })

  it('refuses to start if the fresh roster no longer meets the minimum by the time Start is actually called', async () => {
    currentClient = stack.clientFor(ALICE)
    const { game } = await createGame({
      name: 'Enforced shrinking room',
      playMode: 'live',
      userId: ALICE,
      displayName: 'Alice',
      avatarUrl: null,
      minPlayers: 2,
      maxPlayers: 4,
      ruleEnforcementEnabled: true,
    })

    currentClient = stack.clientFor(BOB)
    const bobSeat = await joinGame({ game, userId: BOB, displayName: 'Bob', avatarUrl: null })
    await markReady(bobSeat.id, game.config_version)

    currentClient = stack.clientFor(BOB)
    await removePlayer(bobSeat.id)

    currentClient = stack.clientFor(ALICE)
    await expect(startGameFromLobby(game)).rejects.toThrow(/changed/)
    expect(await getGameState(game.id)).toBeNull()
  })

  it('rejects a non-owner trying to start the game', async () => {
    currentClient = stack.clientFor(ALICE)
    const { game } = await createGame({
      name: 'Owner-only room',
      playMode: 'live',
      userId: ALICE,
      displayName: 'Alice',
      avatarUrl: null,
      minPlayers: 2,
      maxPlayers: 2,
      ruleEnforcementEnabled: true,
    })

    currentClient = stack.clientFor(BOB)
    const bobSeat = await joinGame({ game, userId: BOB, displayName: 'Bob', avatarUrl: null })
    await markReady(bobSeat.id, game.config_version)

    const result = await stack.startGame(BOB, game.id)
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect(await getGameState(game.id)).toBeNull()
  })

  it('rejects a direct client write attempting to start the game, now that genesis is server-authoritative', async () => {
    currentClient = stack.clientFor(ALICE)
    const { game } = await createGame({
      name: 'No direct start room',
      playMode: 'live',
      userId: ALICE,
      displayName: 'Alice',
      avatarUrl: null,
      minPlayers: 1,
      maxPlayers: 2,
      ruleEnforcementEnabled: true,
    })

    // The old client-trusted sequence (insertGameState then a status flip) —
    // 0029_start_game_edge_function.sql must reject both steps for an
    // enforced game.
    const insertResult = await stack
      .clientFor(ALICE)
      .from('game_state')
      .insert({ game_id: game.id, state: {}, turn: 0, active_player_id: null })
    expect(insertResult.error).toBeTruthy()

    const updateResult = await stack.clientFor(ALICE).from('games').update({ status: 'active' }).eq('id', game.id)
    expect(updateResult.error).toBeTruthy()
    expect(stack.db.table('games').find((row) => row.id === game.id)?.status).toBe('lobby')
  })
})
