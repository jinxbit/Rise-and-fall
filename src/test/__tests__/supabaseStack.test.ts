// @vitest-environment node
//
// Self-test for the production-simulating Supabase stack
// (src/test/supabaseStack/). Everything the production-game replays in
// ./productionGames.test.ts rely on is proven here against a game this file
// plays itself: that the real Edge Functions run, that their authorization
// branches fire, that game_state's compare-and-swap and RLS behave the way
// the migrations say, and that a game reconstructed from an export is the
// same game.
//
// Runs in the `node` environment rather than the project-wide jsdom one:
// nothing here touches the DOM, and the Edge Functions are Deno server code,
// so a browser-shaped global scope only adds noise (auth-js warns about
// multiple clients per "browser context", which is exactly what several
// simulated players are).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Action } from '../../engine/actions.ts'
import type { GameState } from '../../engine/types.ts'
import { resolveBoardGenerationContent } from '../../content/resolveContent.ts'
import { buildGenesisState } from '../../lib/gameGenesis.ts'
import type { GameRow, GameSettings, PlayerRow } from '../../lib/dbTypes.ts'
import { encodeGameStateExport, decodeGameStateExport } from '../../lib/gameStateExport.ts'
import { buildFixture, stripTimestamps } from '../fixtures/productionGames/loadFixtures.ts'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'
import { nextLegalAction, resolveGameContent } from '../supabaseStack/sampleGame.ts'
import { normalizeForComparison, replayFixtureThroughStack } from '../supabaseStack/replayFixture.ts'
import type { CompressedGameState } from '../../lib/gameStateCompression.ts'

const GAME_ID = '3f1c2d4e-0000-4000-8000-000000000001'
const ALICE = 'auth-user-alice'
const BOB = 'auth-user-bob'

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
    hiddenInformationEnabled: false,
    activeTaleIds: [],
    gameLength: 3,
    ...overrides,
  }
}

function gameRow(settings: GameSettings): GameRow {
  return {
    id: GAME_ID,
    room_code: 'TESTS',
    name: 'Stack self-test',
    play_mode: 'live',
    status: 'active',
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

const userIdForSeat: Record<string, string> = { 'seat-alice': ALICE, 'seat-bob': BOB }

async function seed(stack: ProductionStack, settings = settingsFor()): Promise<GameState> {
  const game = gameRow(settings)
  const genesis = buildGenesisState(game, PLAYERS)
  await stack.seedStartedGame({ game, players: PLAYERS, genesis })
  return genesis
}

/**
 * Plays the game forward through the real apply-action Edge Function, one
 * legal action at a time, each submitted by the signed-in user who actually
 * holds that seat — i.e. the way a live game is played, not the way a test
 * fixture is assembled.
 */
async function playThroughStack(stack: ProductionStack, from: GameState, maxActions: number): Promise<{ state: GameState; version: number; actions: Action[] }> {
  const content = resolveGameContent(from)
  let state = from
  let version = 0
  const actions: Action[] = []
  for (let i = 0; i < maxActions; i++) {
    const action = nextLegalAction(state, content)
    if (!action) break
    // nextLegalAction only ever returns seat-owned actions, never the
    // nullable-playerId pointer moves.
    const result = await stack.applyAction(userIdForSeat[action.playerId ?? ''], GAME_ID, action)
    if (!result.ok) throw new Error(`apply-action rejected ${action.type} by ${action.playerId}: ${result.error}`)
    expect(result.version).toBe(version + 1)
    state = result.state
    version = result.version
    actions.push(action)
  }
  return { state, version, actions }
}

describe('production Supabase stack', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
  })
  afterEach(() => {
    stack.dispose()
  })

  it('plays a whole game through the real Edge Functions, and the stored state stays the authority', async () => {
    const genesis = await seed(stack)
    const { state, version, actions } = await playThroughStack(stack, genesis, 60)

    // Board setup finished and the round cycle actually got going.
    // Board setup ran to completion (three starting units each) and the round
    // cycle then carried on for several rounds — every one of those actions a
    // separate authenticated call into apply-action.
    expect(actions.filter((action) => action.type === 'PLACE_UNIT')).toHaveLength(PLAYERS.length * 3)
    expect(state.status).toBe('active')
    expect(state.turn).toBeGreaterThanOrEqual(2)
    expect(state.actionHistory).toHaveLength(actions.length)

    // What the function returned is what a fresh client read gets back.
    const read = await stack.readGameState(BOB, GAME_ID)
    expect(read?.version).toBe(version)
    expect(stripTimestamps(read!.state)).toEqual(stripTimestamps(state))
  })

  it('stores an enforced game gzipped, with the plaintext keys game_state_sync_meta reads', async () => {
    const genesis = await seed(stack)
    const { state, version } = await playThroughStack(stack, genesis, 12)

    // Written by writeGameStateCAS, so compressed — issue #451's plaintext
    // duplication has to survive, or the meta trigger goes blind.
    const stored = stack.db.table<{ state: CompressedGameState }>('game_state')[0].state
    expect(stored.__gz).toBeTypeOf('string')
    expect(stored.status).toBe(state.status)
    expect(stored.turn).toBe(state.turn)

    const meta = stack.db.table<{ status: string; turn: number; version: number; pending_player_ids: string[] }>('game_state_meta')[0]
    expect(meta.version).toBe(version)
    expect(meta.status).toBe(state.status)
    expect(meta.turn).toBe(state.turn)
    // Never 'unknown' — that was the symptom when the trigger couldn't read a gzipped state.
    expect(meta.status).not.toBe('unknown')
  })

  it("refuses one player's attempt to act on another's behalf", async () => {
    const genesis = await seed(stack)
    const action = nextLegalAction(genesis, resolveGameContent(genesis))!
    expect(action.playerId).toBe('seat-alice')

    const result = await stack.applyAction(BOB, GAME_ID, action)
    expect(result).toMatchObject({ ok: false, status: 403 })
    expect((await stack.readGameState(ALICE, GAME_ID))?.version).toBe(0)
  })

  it('refuses an unauthenticated caller', async () => {
    const genesis = await seed(stack)
    const action = nextLegalAction(genesis, resolveGameContent(genesis))!

    const { error } = await stack.anonClient().functions.invoke('apply-action', { body: { gameId: GAME_ID, action } })
    expect((error as { context?: Response }).context?.status).toBe(401)
  })

  it('rejects an illegal action with the engine’s own message, and leaves the row untouched', async () => {
    await seed(stack)
    // A starting unit on a hex that does not exist on the board.
    const result = await stack.applyAction(ALICE, GAME_ID, { type: 'PLACE_UNIT', playerId: 'seat-alice', unitKind: 'city', coord: { q: 999, r: 999 } })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect((await stack.readGameState(ALICE, GAME_ID))?.version).toBe(0)
  })

  it('serializes concurrent submissions of the same action with a 409, not a lost update', async () => {
    const genesis = await seed(stack)
    const action = nextLegalAction(genesis, resolveGameContent(genesis))!

    const [first, second] = await Promise.all([
      stack.applyAction(ALICE, GAME_ID, action),
      stack.applyAction(ALICE, GAME_ID, action),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])
    // Exactly one of them landed.
    expect((await stack.readGameState(ALICE, GAME_ID))?.version).toBe(1)
  })

  // issue #519: a reported 2-player game's boardSetup.tilesRemainingInTier
  // for its second tile tier ended up permanently set to the *3*-player
  // pool size, even though the game only ever had 2 seated players — the
  // `players` table had picked up a stray extra row somehow, and apply-action
  // used its live row count (ctx.players.length) instead of the genesis
  // roster already fixed on GameState.players. Reproduces exactly that: a
  // 2-player genesis, but a `players` table with 3 rows.
  it("a stray extra players-table row doesn't corrupt board-generation content (issue #519)", async () => {
    const game = gameRow(settingsFor({ mapTemplateId: null }))
    const genesis = buildGenesisState(game, PLAYERS)
    const strayPlayer: PlayerRow = {
      id: 'seat-stray',
      game_id: GAME_ID,
      user_id: 'auth-user-stray',
      display_name: 'Stray',
      avatar_url: null,
      seat_index: 2,
      color: '#1e1',
      is_active: true,
    } as PlayerRow
    await stack.seedStartedGame({ game, players: [...PLAYERS, strayPlayer], genesis })

    const waterPoolSize = resolveBoardGenerationContent(PLAYERS.length).tiers.find((t) => t.terrain === 'water')!.poolSize
    const { state } = await playThroughStack(stack, genesis, waterPoolSize)

    // The water tier (genesis's own doing, unaffected by this bug) should
    // have exhausted its 2-player pool and moved on to plain.
    expect(state.boardSetup?.tileTierQueue[0]).toBe('plain')
    expect(state.boardSetup?.tilesRemainingInTier).toBe(resolveBoardGenerationContent(PLAYERS.length).tiers.find((t) => t.terrain === 'plain')!.poolSize)
  })

  it('undoes and redoes through the real undo-action/redo-action functions', async () => {
    const genesis = await seed(stack)
    const { state, version } = await playThroughStack(stack, genesis, 4)

    const undone = await stack.undoAction(BOB, GAME_ID)
    if (!undone.ok) throw new Error(undone.error)
    expect(undone.version).toBe(version + 1)
    expect(undone.state.actionHistory.at(-1)?.action.type).toBe('UNDO_ACTION')

    const redone = await stack.redoAction(BOB, GAME_ID)
    if (!redone.ok) throw new Error(redone.error)
    expect(redone.state.actionHistory.at(-1)?.action.type).toBe('REDO_ACTION')
    // Redo puts the game back exactly where it was, modulo the two markers
    // the undo/redo pair appended to the log.
    expect(stripTimestamps({ ...redone.state, actionHistory: state.actionHistory })).toEqual(stripTimestamps(state))
  })

  describe('row level security', () => {
    it('blocks a seated player from writing an enforced game’s state directly (0026)', async () => {
      const genesis = await seed(stack)
      const { state, version } = await playThroughStack(stack, genesis, 3)

      // gameApi.ts's writeGameState, verbatim in shape. RLS hides the row from
      // the UPDATE rather than erroring, so this reads as "someone else got
      // there first" — zero rows changed.
      const { data, error } = await stack
        .clientFor(ALICE)
        .from('game_state')
        .update({ state: { ...state, turn: 999 }, turn: 999, active_player_id: null, version: version + 1 })
        .eq('game_id', GAME_ID)
        .eq('version', version)
        .select('version')
      expect(error).toBeNull()
      expect(data).toEqual([])
      expect((await stack.readGameState(ALICE, GAME_ID))?.state.turn).toBe(state.turn)
    })

    it('still allows a direct write when the game did not opt into enforcement', async () => {
      const genesis = await seed(stack, settingsFor({ ruleEnforcementEnabled: false }))

      const { data, error } = await stack
        .clientFor(ALICE)
        .from('game_state')
        .update({ state: { ...genesis, turn: 7 }, turn: 7, active_player_id: null, version: 1 })
        .eq('game_id', GAME_ID)
        .eq('version', 0)
        .select('version')
      expect(error).toBeNull()
      expect(data).toEqual([{ version: 1 }])
    })

    it('lets a signed-in stranger read a started game’s state, but not a lobby one (0021)', async () => {
      await seed(stack)
      stack.addUser('auth-user-carol')
      // 0021_remove_observers.sql: any signed-in user may read a non-lobby
      // game's state, seated or not — that is what makes a room spectatable.
      expect(await stack.readGameState('auth-user-carol', GAME_ID)).not.toBeNull()

      // The same row is invisible to that stranger while the room is still in
      // the lobby, and stays readable for the players seated in it.
      const lobbyGame = stack.db.table<{ id: string; status: string }>('games').find((row) => row.id === GAME_ID)!
      lobbyGame.status = 'lobby'
      stack.db.replaceRow('games', lobbyGame)
      expect(await stack.readGameState('auth-user-carol', GAME_ID)).toBeNull()
      expect(await stack.readGameState(ALICE, GAME_ID)).not.toBeNull()
    })

    it('blocks direct game_state reads entirely for a hiddenInformationEnabled game — seated player included (0028, issue #488)', async () => {
      await seed(stack, settingsFor({ hiddenInformationEnabled: true }))
      stack.addUser('auth-user-carol')
      stack.addUser('auth-user-admin', { isAdmin: true })

      // A seated player gets nothing beyond what get-game-state would give
      // them: RLS can't redact within a row, so the raw row is off-limits to
      // everyone but the service role, not just to a non-seated stranger.
      expect(await stack.readGameState(ALICE, GAME_ID)).toBeNull()
      expect(await stack.readGameState(BOB, GAME_ID)).toBeNull()
      expect(await stack.readGameState('auth-user-carol', GAME_ID)).toBeNull()

      // The redacted read path is untouched — it's the service role client
      // underneath, which bypasses RLS regardless of this policy.
      const viaRedactedPath = await stack.getGameState(ALICE, GAME_ID)
      expect(viaRedactedPath.ok).toBe(true)

      // 0024_admin_read_all_game_state.sql's admin policy is a separate,
      // additive permissive policy — untouched by this lockdown.
      expect(await stack.readGameState('auth-user-admin', GAME_ID)).not.toBeNull()
    })

    it('leaves direct game_state reads unchanged for a game that has not opted into hidden information', async () => {
      await seed(stack, settingsFor({ hiddenInformationEnabled: false }))
      stack.addUser('auth-user-carol')

      expect(await stack.readGameState(ALICE, GAME_ID)).not.toBeNull()
      expect(await stack.readGameState('auth-user-carol', GAME_ID)).not.toBeNull()
    })
  })

  /**
   * Found by replaying blue-beats-red (a real hotseat game) under server-side
   * enforcement: it used to be refused at its second-to-last action.
   *
   * §4.1 deliberately scopes hotseat out of the enforcement model — one shared
   * `auth.uid()` covers every local seat, so `isAuthorizedToActAs`
   * (supabase/functions/_shared/gameEnforcement.ts) lets any seated player act
   * for any seat in a hotseat game. §4.4/§4.5's owner-override check used to
   * have no such carve-out, even though it exists only to protect one *human*
   * from another human discarding their undone move — in hotseat there is
   * only one human, so it had nothing to protect and instead blocked ordinary
   * play: undo a seat's pick during a simultaneous phase, then act for the
   * other seat, and the submission was refused unless room admin mode
   * happened to be on.
   *
   * Fixed by issue #486: apply-action/index.ts now skips the owner-override
   * check entirely for a hotseat game (`ctx.game.play_mode === 'hotseat'`),
   * the same condition `isAuthorizedToActAs` and `redactedResponseState`
   * already key their own hotseat carve-outs on. This test now pins the fix
   * — invert it again if this game (or hotseat in general) should ever need
   * the override back.
   */
  it('lets a hotseat player act for their other seat after undoing the first one’s pick', async () => {
    const genesis = await seed(stack, settingsFor({ mapTemplateId: 'classic' }))
    // Both seats belong to one signed-in human, which is what hotseat means.
    const hotseat = { ...gameRow(settingsFor()), play_mode: 'hotseat' as const }
    stack.db.replaceRow('games', hotseat as unknown as Record<string, unknown>)

    // Board setup, then the simultaneous card-selection phase both seats are
    // pending in at once.
    const { state: afterSetup } = await playThroughStack(stack, genesis, PLAYERS.length * 3)
    expect(afterSetup.roundPhase).toBe('selectCards')
    expect(afterSetup.pendingPlayerIds).toEqual(expect.arrayContaining(['seat-alice', 'seat-bob']))

    const chose = await stack.applyAction(ALICE, GAME_ID, {
      type: 'CHOOSE_CARD',
      playerId: 'seat-alice',
      cardId: afterSetup.players.find((player) => player.id === 'seat-alice')!.handCardIds[0],
    })
    if (!chose.ok) throw new Error(chose.error)

    const undone = await stack.undoAction(ALICE, GAME_ID)
    if (!undone.ok) throw new Error(undone.error)

    // The same human, now playing their other seat. Nobody else's move is
    // being discarded — there is nobody else.
    const bob = undone.state.players.find((player) => player.id === 'seat-bob')!
    const bobCardId = bob.handCardIds[0]
    const accepted = await stack.applyAction(ALICE, GAME_ID, { type: 'CHOOSE_CARD', playerId: 'seat-bob', cardId: bobCardId })
    if (!accepted.ok) throw new Error(accepted.error)
    expect(accepted.state.chosenCardIdByPlayerId['seat-bob']).toBe(bobCardId)
    expect(accepted.state.pendingPlayerIds).not.toContain('seat-bob')
  })

  describe('fixture reconstruction', () => {
    it('rebuilds a preset-board game’s room and genesis from nothing but its export', async () => {
      const genesis = await seed(stack)
      const { state } = await playThroughStack(stack, genesis, 20)

      const fixture = buildFixture('self-test-preset', await decodeGameStateExport(await encodeGameStateExport(state)))
      expect(fixture.game.settings.mapPoolBoard).not.toBeNull()
      expect(stripTimestamps(fixture.genesis)).toEqual(stripTimestamps(genesis))
    })

    it('replays a game from its own export, exactly as a production fixture is replayed', async () => {
      const genesis = await seed(stack)
      const { state } = await playThroughStack(stack, genesis, 24)
      // Put a pointer move in the history too, so the replay exercises
      // undo-action/redo-action and not just apply-action.
      const undone = await stack.undoAction(ALICE, GAME_ID)
      if (!undone.ok) throw new Error(undone.error)
      const redone = await stack.redoAction(ALICE, GAME_ID)
      if (!redone.ok) throw new Error(redone.error)
      const finalState = redone.state
      expect(finalState.actionHistory).toHaveLength(state.actionHistory.length + 2)

      const fixture = buildFixture('self-test-roundtrip', await decodeGameStateExport(await encodeGameStateExport(finalState)))

      // A second, empty stack — the game is rebuilt from its export alone,
      // with nothing carried over from the stack that played it.
      stack.dispose()
      const replay = await createProductionStack()
      try {
        await replay.seedStartedGame({ game: fixture.game, players: fixture.players, genesis: fixture.genesis, admins: [fixture.game.created_by] })
        const outcome = await replayFixtureThroughStack(replay, fixture)
        // A game played by this file is played against today's engine, so
        // nothing in its log is a stale forced follow-up — every entry is a
        // real submission.
        expect(outcome.foldedEntryIndices).toEqual([])
        expect(outcome.version).toBe(finalState.actionHistory.length)
        const stored = await replay.readGameState(fixture.players[0].user_id, fixture.game.id)
        expect(normalizeForComparison(stored!.state)).toEqual(normalizeForComparison(finalState))
      } finally {
        replay.dispose()
      }
    })

    it('rebuilds an interactively-built game’s room and genesis from its export', async () => {
      const genesis = await seed(stack, settingsFor({ mapTemplateId: null }))
      expect(genesis.boardSetup?.tileTierQueue.length).toBeGreaterThan(0)
      const { state } = await playThroughStack(stack, genesis, 6)
      expect(state.actionHistory.some((entry) => entry.action.type === 'PLACE_TILE')).toBe(true)

      const fixture = buildFixture('self-test-interactive', await decodeGameStateExport(await encodeGameStateExport(state)))
      expect(fixture.game.settings.mapPoolBoard).toBeNull()
      expect(fixture.game.settings.soloBuildMap).toBe(false)
      expect(stripTimestamps(fixture.genesis)).toEqual(stripTimestamps(genesis))
    })
  })
})
