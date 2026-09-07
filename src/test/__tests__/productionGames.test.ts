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
import type { CompressedGameState, StoredGameState } from '../../lib/gameStateCompression.ts'
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

    it('stores the game the way its own write path stores it, with a matching meta projection', async () => {
      await seedGame()
      await replayFixtureThroughStack(stack, fixture)

      const stored = stack.db.table<{ state: StoredGameState; version: number }>('game_state')[0]
      if (fixture.game.settings.ruleEnforcementEnabled) {
        // Only writeGameStateCAS compresses (gameStateCompression.ts), and only
        // for these games.
        expect((stored.state as CompressedGameState).__gz).toBeTypeOf('string')
      } else {
        expect(stored.state).not.toHaveProperty('__gz')
      }

      // Either way the trigger has to be able to read status/turn straight off
      // the stored JSON — the plaintext keys beside the gzip blob exist for
      // exactly this (issue #451).
      const meta = stack.db.table<{ status: string; turn: number; version: number }>('game_state_meta')[0]
      expect(meta).toMatchObject({ status: fixture.finalState.status, turn: fixture.finalState.turn, version: stored.version })
    })

    it('ends on the final score production recorded', async () => {
      await seedGame()
      await replayFixtureThroughStack(stack, fixture)
      const stored = await stack.readGameState(fixture.players[0].user_id, fixture.game.id)
      const scores = fixture.finalScores(stored!.state)

      // Declared in the game's .room.json sidecar, from what a human read off
      // the end-of-game screen — a number that came from outside the code
      // under test, so a scoring change that moved every total in step would
      // still be caught here.
      const expected = fixture.expected.finalScoreByPlayerId
      if (expected) {
        for (const [playerId, score] of Object.entries(expected)) {
          expect(scores[playerId], `final score for ${fixture.describePlayer(playerId)}`).toBe(score)
        }
      }
      if (fixture.expected.winnerPlayerIds) {
        expect(stored!.state.winnerPlayerIds.map((id) => fixture.describePlayer(id)).sort()).toEqual(
          fixture.expected.winnerPlayerIds.map((id) => fixture.describePlayer(id)).sort(),
        )
      }

      // True of every game, declared or not: the replay scores what the export
      // scores, and whoever the game recorded as winning is whoever actually
      // has the most points (there is no tiebreaker — see determineWinners).
      expect(scores).toEqual(fixture.finalScores(fixture.finalState))
      if (stored!.state.status === 'completed') {
        const best = Math.max(...Object.values(scores))
        expect(stored!.state.winnerPlayerIds.map((id) => fixture.describePlayer(id)).sort()).toEqual(
          Object.entries(scores)
            .filter(([, score]) => score === best)
            .map(([playerId]) => fixture.describePlayer(playerId))
            .sort(),
        )
      }
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

    it('gates direct client writes on the game’s own enforcement setting (0026)', async () => {
      await seedGame()
      const { data, error } = await stack
        .clientFor(fixture.players[0].user_id)
        .from('game_state')
        .update({ state: fixture.finalState, turn: fixture.finalState.turn, active_player_id: null, version: 1 })
        .eq('game_id', fixture.game.id)
        .eq('version', 0)
        .select('version')
      expect(error).toBeNull()
      // A rule-enforced game's row is service-role-write-only, so RLS hides it
      // from the UPDATE and zero rows change; a client-trusted game's row is
      // still the seated player's to write, exactly as it always was.
      expect(data).toEqual(fixture.game.settings.ruleEnforcementEnabled ? [] : [{ version: 1 }])
    })
  })
})
