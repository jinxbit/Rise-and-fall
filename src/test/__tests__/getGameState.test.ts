// @vitest-environment node
//
// Self-test for the get-game-state Edge Function (HIDDEN_INFORMATION_PLAN.md
// phase 5/8) against the production-simulating Supabase stack
// (src/test/supabaseStack/) — see supabaseStack.test.ts's own doc comment for
// what "production-simulating" means here. gameApi.ts's getGameStateRedacted
// is the app's only caller (GamePage.tsx, for a game with both
// ruleEnforcementEnabled and hiddenInformationEnabled on), so this is where
// its authorization/redaction/opt-in-gating behavior runs against the real
// canReadGameState()/redactStateForPlayer() code paths, rather than just the
// engine-level redaction.test.ts unit tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildGameLogFrom } from '../../engine/gameLog.ts'
import { toClientGameState } from '../../engine/redaction.ts'
import { buildGenesisState } from '../../lib/gameGenesis.ts'
import type { GameRow, GameSettings, PlayerRow } from '../../lib/dbTypes.ts'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'
import { nextLegalAction, resolveGameContent } from '../supabaseStack/sampleGame.ts'

const GAME_ID = '3f1c2d4e-0000-4000-8000-000000000002'
const ALICE = 'auth-user-alice' // room owner, seated
const BOB = 'auth-user-bob' // seated
const CAROL = 'auth-user-carol' // unseated stranger
const ADMIN = 'auth-user-admin' // unseated site admin

function settingsFor(overrides: Partial<GameSettings> = {}): GameSettings {
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
    // This file's default is opted in — most tests here are exercising
    // actual redaction (GameSettings.hiddenInformationEnabled). The
    // "not opted in"/hotseat tests below override it back to false.
    hiddenInformationEnabled: true,
    activeTaleIds: [],
    gameLength: 3,
    ...overrides,
  }
}

function gameRow(settings: GameSettings, status: GameRow['status'] = 'active', playMode: GameRow['play_mode'] = 'live'): GameRow {
  return {
    id: GAME_ID,
    room_code: 'GETST',
    name: 'get-game-state self-test',
    play_mode: playMode,
    status,
    min_players: 2,
    max_players: 2,
    created_by: ALICE,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    settings,
    config_version: 1,
    visibility: 'private',
  }
}

const PLAYERS: PlayerRow[] = [
  { id: 'seat-alice', game_id: GAME_ID, user_id: ALICE, display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#e11', is_active: true },
  { id: 'seat-bob', game_id: GAME_ID, user_id: BOB, display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#11e', is_active: true },
] as PlayerRow[]

describe('get-game-state Edge Function', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
  })
  afterEach(() => {
    stack.dispose()
  })

  /** Plays board setup to completion (every starting unit placed) via the real apply-action function, landing on the round cycle's simultaneous selectCards phase with both seats pending. */
  async function reachSelectCardsPhase(settingsOverrides: Partial<GameSettings> = {}, playMode: GameRow['play_mode'] = 'live') {
    const game = gameRow(settingsFor(settingsOverrides), 'active', playMode)
    const genesis = buildGenesisState(game, PLAYERS)
    await stack.seedStartedGame({ game, players: PLAYERS, genesis })
    stack.addUser(CAROL)
    stack.addUser(ADMIN, { isAdmin: true })

    const content = resolveGameContent(genesis, PLAYERS.length)
    let state = genesis
    for (let i = 0; i < PLAYERS.length * 3; i++) {
      const action = nextLegalAction(state, content)!
      const userIdForSeat: Record<string, string> = { 'seat-alice': ALICE, 'seat-bob': BOB }
      const result = await stack.applyAction(userIdForSeat[action.playerId ?? '']!, GAME_ID, action)
      if (!result.ok) throw new Error(`setup failed: ${result.error}`)
      state = result.state
    }
    expect(state.roundPhase).toBe('selectCards')
    expect(state.pendingPlayerIds).toEqual(expect.arrayContaining(['seat-alice', 'seat-bob']))
    return state
  }

  it("hides another player's in-progress pick from a seated player, including the room owner", async () => {
    const setup = await reachSelectCardsPhase()
    const bobCard = setup.players.find((p) => p.id === 'seat-bob')!.handCardIds[0]
    const chose = await stack.applyAction(BOB, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-bob', cardId: bobCard })
    if (!chose.ok) throw new Error(chose.error)
    expect(chose.state.pendingPlayerIds).toEqual(['seat-alice'])

    // Alice is the room owner — issue #450's point is that this earns her no
    // special visibility into Bob's still-secret pick.
    const asOwner = await stack.getGameState(ALICE, GAME_ID)
    if (!asOwner.ok) throw new Error(asOwner.error)
    expect(asOwner.state.chosenCardIdByPlayerId['seat-bob']).toEqual({ chosen: true, cardId: null })

    // Bob sees his own real pick.
    const asBob = await stack.getGameState(BOB, GAME_ID)
    if (!asBob.ok) throw new Error(asBob.error)
    expect(asBob.state.chosenCardIdByPlayerId['seat-bob']).toEqual({ chosen: true, cardId: bobCard })
  })

  it('gives a site admin the real pick, wrapped in the same RedactedGameState shape everyone else gets', async () => {
    const setup = await reachSelectCardsPhase()
    const bobCard = setup.players.find((p) => p.id === 'seat-bob')!.handCardIds[0]
    const chose = await stack.applyAction(BOB, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-bob', cardId: bobCard })
    if (!chose.ok) throw new Error(chose.error)

    const asAdmin = await stack.getGameState(ADMIN, GAME_ID)
    if (!asAdmin.ok) throw new Error(asAdmin.error)
    // Nothing is actually masked (revealedGameStateView, not
    // redactStateForPlayer) — but the response is still RedactedChoice-shaped
    // like every other caller's, so gameApi.ts's toClientGameState never has
    // to sniff which shape it got back.
    expect(asAdmin.state.chosenCardIdByPlayerId['seat-bob']).toEqual({ chosen: true, cardId: bobCard })
  })

  it("doesn't redact a game that hasn't opted into hiddenInformationEnabled, even with ruleEnforcementEnabled on", async () => {
    const setup = await reachSelectCardsPhase({ hiddenInformationEnabled: false })
    const bobCard = setup.players.find((p) => p.id === 'seat-bob')!.handCardIds[0]
    const chose = await stack.applyAction(BOB, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-bob', cardId: bobCard })
    if (!chose.ok) throw new Error(chose.error)

    const asOwner = await stack.getGameState(ALICE, GAME_ID)
    if (!asOwner.ok) throw new Error(asOwner.error)
    expect(asOwner.state.chosenCardIdByPlayerId['seat-bob']).toEqual({ chosen: true, cardId: bobCard })
  })

  it('never redacts a hotseat game, regardless of hiddenInformationEnabled', async () => {
    const setup = await reachSelectCardsPhase({ hiddenInformationEnabled: true }, 'hotseat')
    const bobCard = setup.players.find((p) => p.id === 'seat-bob')!.handCardIds[0]
    const chose = await stack.applyAction(BOB, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-bob', cardId: bobCard })
    if (!chose.ok) throw new Error(chose.error)

    // Asking as Alice's own auth user still sees Bob's real pick: one shared
    // auth.uid() per local device means per-seat masking would just hide a
    // local player's own pick from the device they're using to make it.
    const asAlice = await stack.getGameState(ALICE, GAME_ID)
    if (!asAlice.ok) throw new Error(asAlice.error)
    expect(asAlice.state.chosenCardIdByPlayerId['seat-bob']).toEqual({ chosen: true, cardId: bobCard })
  })

  it('lets a signed-in stranger read a started game redacted with no seat of their own, but refuses a lobby game', async () => {
    const setup = await reachSelectCardsPhase()
    const bobCard = setup.players.find((p) => p.id === 'seat-bob')!.handCardIds[0]
    const chose = await stack.applyAction(BOB, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-bob', cardId: bobCard })
    if (!chose.ok) throw new Error(chose.error)

    const asStranger = await stack.getGameState(CAROL, GAME_ID)
    if (!asStranger.ok) throw new Error(asStranger.error)
    expect(asStranger.state.chosenCardIdByPlayerId['seat-bob']).toEqual({ chosen: true, cardId: null })

    // 0021_remove_observers.sql: a lobby-status game is invisible to a
    // non-seated, non-admin stranger — same gate apply-action's siblings rely
    // on RLS for, reimplemented here since the service-role client bypasses it.
    const lobbyGame = stack.db.table<{ id: string; status: string }>('games').find((row) => row.id === GAME_ID)!
    lobbyGame.status = 'lobby'
    stack.db.replaceRow('games', lobbyGame)
    const blocked = await stack.getGameState(CAROL, GAME_ID)
    expect(blocked).toMatchObject({ ok: false, status: 403 })

    // A seated player is unaffected by the game being in the lobby.
    const stillOk = await stack.getGameState(ALICE, GAME_ID)
    expect(stillOk.ok).toBe(true)
  })

  it('refuses an unauthenticated caller', async () => {
    await reachSelectCardsPhase()
    const { error } = await stack.anonClient().functions.invoke('get-game-state', { body: { gameId: GAME_ID } })
    expect((error as { context?: Response }).context?.status).toBe(401)
  })

  it('404s for a game with no state yet', async () => {
    stack.addUser(ALICE)
    const missing = await stack.getGameState(ALICE, '3f1c2d4e-0000-4000-8000-00000000dead')
    expect(missing).toMatchObject({ ok: false, status: 404 })
  })

  it("the client-side collapse (toClientGameState) of a real redacted response never crashes the game log while a pick is still pending — the phase-8 replay blocker this opt-in was scoped to close", async () => {
    const setup = await reachSelectCardsPhase()
    const genesis = buildGenesisState(gameRow(settingsFor()), PLAYERS)
    const bobCard = setup.players.find((p) => p.id === 'seat-bob')!.handCardIds[0]
    const chose = await stack.applyAction(BOB, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-bob', cardId: bobCard })
    if (!chose.ok) throw new Error(chose.error)

    const asOwner = await stack.getGameState(ALICE, GAME_ID)
    if (!asOwner.ok) throw new Error(asOwner.error)
    const client = toClientGameState(asOwner.state)

    // Bob's still-secret pick simply isn't in the truncated actionHistory
    // yet (unredactedPrefix) — buildGameLogFrom must not throw trying to
    // replay a masked entry, which is exactly what the previous session
    // found broken before this opt-in/truncation landed.
    expect(() => buildGameLogFrom(genesis, client.actionHistory)).not.toThrow()
    const { events } = buildGameLogFrom(genesis, client.actionHistory)
    expect(events.some((e) => e.message.includes('chose to play'))).toBe(false)
  })

  it('reveals both picks once the selectCards phase resolves and moves on', async () => {
    const setup = await reachSelectCardsPhase()
    const aliceCard = setup.players.find((p) => p.id === 'seat-alice')!.handCardIds[0]
    const bobCard = setup.players.find((p) => p.id === 'seat-bob')!.handCardIds[0]
    const first = await stack.applyAction(ALICE, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-alice', cardId: aliceCard })
    if (!first.ok) throw new Error(first.error)
    const second = await stack.applyAction(BOB, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-bob', cardId: bobCard })
    if (!second.ok) throw new Error(second.error)
    expect(second.state.roundPhase).toBe('actions')

    const asOwner = await stack.getGameState(ALICE, GAME_ID)
    if (!asOwner.ok) throw new Error(asOwner.error)
    expect(asOwner.state.chosenCardIdByPlayerId['seat-bob']).toEqual({ chosen: true, cardId: bobCard })
  })
})
