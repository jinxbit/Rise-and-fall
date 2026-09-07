// @vitest-environment node
//
// Replays real games, exported from production, against the
// production-simulating Supabase stack (src/test/supabaseStack/).
//
// Every game export dropped into src/test/fixtures/productionGames/ becomes a
// suite here automatically — no registration step. What each one asserts is
// that the game *replays*: submitted action by action, by the seat that
// actually submitted it, through the real apply-action/undo-action/
// redo-action Edge Functions, against a database that enforces the same RLS
// and the same optimistic-concurrency contract production does — and that the
// state that lands in `game_state` at the end is the state production
// finished with, down to the winner.
//
// That makes these regression tests for the whole write path at once. A rules
// change that alters how an old game resolves, an enforcement check that
// starts rejecting a move real players made, a compression or trigger change
// that corrupts what gets stored: each shows up here as a specific action
// number in a specific real game, which is a much better bug report than
// "some test failed".

import { afterEach, describe, expect, it } from 'vitest'
import type { CompressedGameState } from '../../lib/gameStateCompression.ts'
import { loadProductionGameFixtures } from '../fixtures/productionGames/loadFixtures.ts'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'
import { normalizeForComparison, replayFixtureThroughStack } from '../supabaseStack/replayFixture.ts'

const fixtures = await loadProductionGameFixtures()

describe('production game replays', () => {
  it('loads every checked-in game export', () => {
    // Nothing to replay yet is a legitimate state for this suite — see
    // src/test/fixtures/productionGames/README.md for how to add a game. The
    // stack itself is covered either way by ./supabaseStack.test.ts.
    for (const fixture of fixtures) {
      expect(fixture.finalState.actionHistory.length, `${fixture.name} has an empty action history`).toBeGreaterThan(0)
    }
  })

  describe.each(fixtures.map((fixture) => [fixture.name, fixture] as const))('%s', (_name, fixture) => {
    let stack: ProductionStack

    /** A fresh stack with this game seeded at genesis, ready to be replayed into. */
    async function seedGame(): Promise<void> {
      stack = await createProductionStack()
      await stack.seedStartedGame({
        game: fixture.game,
        players: fixture.players,
        genesis: fixture.genesis,
        admins: [fixture.game.created_by],
      })
    }

    afterEach(() => stack?.dispose())

    it('replays the whole game through the Edge Functions and ends where production ended', async () => {
      await seedGame()

      const version = await replayFixtureThroughStack(stack, fixture)

      const stored = await stack.readGameState(fixture.players[0].user_id, fixture.game.id)
      expect(stored?.version).toBe(version)
      expect(normalizeForComparison(stored!.state)).toEqual(normalizeForComparison(fixture.finalState))
      // Stated separately from the deep equality above so a divergence in how
      // the game *ended* reads as its own failure rather than a diff of the
      // entire board.
      expect(stored!.state.status).toBe(fixture.finalState.status)
      expect(stored!.state.winnerPlayerIds).toEqual(fixture.finalState.winnerPlayerIds)
      expect(stored!.state.claimedByAchievementId).toEqual(fixture.finalState.claimedByAchievementId)
    })

    it('stores the replayed game compressed, with a meta projection that matches', async () => {
      await seedGame()
      await replayFixtureThroughStack(stack, fixture)

      const stored = stack.db.table<{ state: CompressedGameState; version: number }>('game_state')[0]
      expect(stored.state.__gz).toBeTypeOf('string')
      const meta = stack.db.table<{ status: string; turn: number; version: number }>('game_state_meta')[0]
      expect(meta).toMatchObject({ status: fixture.finalState.status, turn: fixture.finalState.turn, version: stored.version })
    })

    it("refuses the game's first action from a seat that did not make it", async () => {
      await seedGame()
      const first = fixture.finalState.actionHistory[0]
      const submitter = first.action.playerId === null ? fixture.game.created_by : fixture.userIdForPlayer(first.action.playerId)
      const impostor = fixture.players.find((player) => player.user_id !== submitter && player.user_id !== fixture.game.created_by)
      const isSeatAction = first.action.type !== 'UNDO_ACTION' && first.action.type !== 'REDO_ACTION' && first.action.type !== 'SET_ADMIN_MODE'
      if (!impostor || !isSeatAction) {
        // A hotseat game (every seat is one auth user) has nobody to
        // impersonate — §4.1 explicitly scopes hotseat out — and a first entry
        // that isn't a seat's own action is authorized by a different rule
        // (any seated player may move the pointer; only the owner/an admin may
        // toggle admin mode). Nothing to assert either way.
        return
      }
      const result = await stack.applyAction(impostor.user_id, fixture.game.id, first.action)
      expect(result).toMatchObject({ ok: false, status: 403 })
      expect((await stack.readGameState(impostor.user_id, fixture.game.id))?.version).toBe(0)
    })

    it('refuses a direct client write to the game state', async () => {
      await seedGame()
      const { data, error } = await stack
        .clientFor(fixture.players[0].user_id)
        .from('game_state')
        .update({ state: fixture.finalState, turn: fixture.finalState.turn, active_player_id: null, version: 1 })
        .eq('game_id', fixture.game.id)
        .eq('version', 0)
        .select('version')
      expect(error).toBeNull()
      expect(data).toEqual([])
    })
  })
})
