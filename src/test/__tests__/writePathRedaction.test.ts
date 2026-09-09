// @vitest-environment node
//
// Self-test for issue #478: apply-action/undo-action/redo-action's own
// response used to hand the acting player back the full, unredacted
// GameState — including every *other* player's still-secret selectCards
// pick — even for a game with GameSettings.hiddenInformationEnabled on,
// completely bypassing get-game-state's redaction (getGameState.test.ts).
// This exercises the fix (redactedResponseState, ../../../supabase/functions
// /_shared/gameEnforcement.ts) against the real Edge Function handlers via
// the production-simulating stack (src/test/supabaseStack/) — see
// supabaseStack.test.ts's own doc comment for what "production-simulating"
// means here.
//
// Needs three seats, not two: in a two-player game, the acting player is
// always the *last* to choose, so by the time their own submission's
// response comes back the phase has already resolved and nothing is masked
// — the leak only shows up while at least one other player is still
// pending after the acting player's own submission.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RedactedGameState } from '../../engine/redaction.ts'
import { buildGenesisState } from '../../lib/gameGenesis.ts'
import type { GameRow, GameSettings, PlayerRow } from '../../lib/dbTypes.ts'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'
import { nextLegalAction, resolveGameContent } from '../supabaseStack/sampleGame.ts'

const GAME_ID = '3f1c2d4e-0000-4000-8000-000000000003'
const ALICE = 'auth-user-alice' // room owner, seated
const BOB = 'auth-user-bob' // seated
const CHARLIE = 'auth-user-charlie' // seated

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
    hiddenInformationEnabled: true,
    activeTaleIds: [],
    gameLength: 3,
    ...overrides,
  }
}

function gameRow(settings: GameSettings): GameRow {
  return {
    id: GAME_ID,
    room_code: 'WRTST',
    name: 'write-path redaction self-test',
    play_mode: 'live',
    status: 'active',
    min_players: 3,
    max_players: 3,
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
  { id: 'seat-charlie', game_id: GAME_ID, user_id: CHARLIE, display_name: 'Charlie', avatar_url: null, seat_index: 2, color: '#1e1', is_active: true },
] as PlayerRow[]

const USER_ID_FOR_SEAT: Record<string, string> = { 'seat-alice': ALICE, 'seat-bob': BOB, 'seat-charlie': CHARLIE }

describe('apply-action/undo-action/redo-action write-path redaction (issue #478)', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
  })
  afterEach(() => {
    stack.dispose()
  })

  /** Plays board setup to completion via the real apply-action function, landing on the simultaneous selectCards phase with all three seats pending. */
  async function reachSelectCardsPhase(settingsOverrides: Partial<GameSettings> = {}) {
    const game = gameRow(settingsFor(settingsOverrides))
    const genesis = buildGenesisState(game, PLAYERS)
    await stack.seedStartedGame({ game, players: PLAYERS, genesis })

    const content = resolveGameContent(genesis, PLAYERS.length)
    let state = genesis
    // roundPhase already defaults to 'selectCards' at genesis (see
    // createGame.ts) even while status is still 'boardSetup', so the loop
    // condition needs both: keep going until board setup has actually
    // finished and the game has genuinely reached the simultaneous phase.
    for (let guard = 0; state.status !== 'active' || state.roundPhase !== 'selectCards'; guard++) {
      if (guard > 500) throw new Error('setup ran on far longer than a board-setup-to-selectCards transition should take')
      const action = nextLegalAction(state, content)
      if (!action?.playerId) throw new Error('setup ran out of legal actions before reaching selectCards')
      const result = await stack.applyAction(USER_ID_FOR_SEAT[action.playerId]!, GAME_ID, action)
      if (!result.ok) throw new Error(`setup failed: ${result.error}`)
      state = result.state
    }
    expect(state.pendingPlayerIds).toEqual(expect.arrayContaining(['seat-alice', 'seat-bob', 'seat-charlie']))
    return state
  }

  /** The raw Edge Function response body, bypassing gameApi.ts/the stack's own toClientGameState collapse — this is what actually crossed the wire. */
  async function rawApplyAction(userId: string, action: Parameters<ProductionStack['applyAction']>[2]) {
    const { data, error } = await stack.clientFor(userId).functions.invoke('apply-action', { body: { gameId: GAME_ID, action } })
    if (error) throw new Error(`apply-action rejected: ${error.message}`)
    return data as { ok: true; state: RedactedGameState; version: number }
  }

  it("hides another still-pending player's secret pick from the acting player's own apply-action response, and reveals it once the phase resolves", async () => {
    const setup = await reachSelectCardsPhase()
    const bobCard = setup.players.find((p) => p.id === 'seat-bob')!.handCardIds[0]
    const aliceCard = setup.players.find((p) => p.id === 'seat-alice')!.handCardIds[0]
    const charlieCard = setup.players.find((p) => p.id === 'seat-charlie')!.handCardIds[0]

    // Bob chooses first — pending: Alice, Charlie.
    const bobChose = await stack.applyAction(BOB, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-bob', cardId: bobCard })
    if (!bobChose.ok) throw new Error(bobChose.error)
    expect(bobChose.state.pendingPlayerIds).toEqual(expect.arrayContaining(['seat-alice', 'seat-charlie']))

    // Alice submits her own pick next — pending: Charlie only, so the phase
    // is still open. Before the fix, this response's chosenCardIdByPlayerId
    // carried Bob's real cardId straight back to Alice's own browser.
    const aliceResponse = await rawApplyAction(ALICE, { type: 'CHOOSE_CARD', playerId: 'seat-alice', cardId: aliceCard })
    expect(aliceResponse.state.pendingPlayerIds).toEqual(['seat-charlie'])
    expect(aliceResponse.state.chosenCardIdByPlayerId['seat-bob']).toEqual({ chosen: true, cardId: null })
    // Alice's own pick is never hidden from herself.
    expect(aliceResponse.state.chosenCardIdByPlayerId['seat-alice']).toEqual({ chosen: true, cardId: aliceCard })

    // Charlie's own submission resolves the phase — nothing left pending, so
    // this same response (still Charlie's own apply-action call) now reveals
    // every pick, Bob's included.
    const charlieResponse = await rawApplyAction(CHARLIE, { type: 'CHOOSE_CARD', playerId: 'seat-charlie', cardId: charlieCard })
    expect(charlieResponse.state.roundPhase).toBe('actions')
    expect(charlieResponse.state.chosenCardIdByPlayerId['seat-bob']).toEqual({ chosen: true, cardId: bobCard })
    expect(charlieResponse.state.chosenCardIdByPlayerId['seat-alice']).toEqual({ chosen: true, cardId: aliceCard })
  })

  it("doesn't change behavior for a game without hiddenInformationEnabled — apply-action's collapsed response still carries the real pick straight through", async () => {
    const setup = await reachSelectCardsPhase({ hiddenInformationEnabled: false })
    const bobCard = setup.players.find((p) => p.id === 'seat-bob')!.handCardIds[0]
    const aliceCard = setup.players.find((p) => p.id === 'seat-alice')!.handCardIds[0]

    const bobChose = await stack.applyAction(BOB, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-bob', cardId: bobCard })
    if (!bobChose.ok) throw new Error(bobChose.error)

    // gameApi.ts's applyActionEnforced (and this stack's applyAction, the
    // same way) always collapses the wire response back to a plain
    // GameState — for a non-opted-in game nothing was ever masked, so the
    // real cardId comes straight through exactly as it did before this fix.
    const aliceChose = await stack.applyAction(ALICE, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-alice', cardId: aliceCard })
    if (!aliceChose.ok) throw new Error(aliceChose.error)
    expect(aliceChose.state.chosenCardIdByPlayerId['seat-bob']).toBe(bobCard)
  })
})
