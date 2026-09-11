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
import { resolveHistory } from '../../engine/historyFold.ts'
import { replayActions } from '../../engine/replay.ts'
import type { GameState } from '../../engine/types.ts'
import type { CompressedGameState, StoredGameState } from '../../lib/gameStateCompression.ts'
import { loadProductionGameFixtures } from '../fixtures/productionGames/loadFixtures.ts'
import { normalizeStateForComparison } from '../fixtures/productionGames/loadFixtures.ts'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'
import { expectedFinalState, normalizeForComparison, replayFixtureThroughStack } from '../supabaseStack/replayFixture.ts'

const fixtures = await loadProductionGameFixtures()

// A full replay submits every logged action through the real Edge Functions
// one at a time — hundreds of round trips for a full game — so it can
// legitimately run past vitest's 5000ms default `testTimeout` on a loaded CI
// runner even though nothing is hung. Generous on purpose: a bigger checked-in
// game should fail on a real regression, not on the clock.
const REPLAY_TIMEOUT_MS = 30_000

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

      const outcome = await replayFixtureThroughStack(stack, fixture)

      const stored = await stack.readGameState(fixture.players[0].user_id, fixture.game.id)
      expect(stored?.version).toBe(outcome.version)
      expect(normalizeForComparison(stored!.state)).toEqual(normalizeForComparison(expectedFinalState(fixture, outcome)))
      // Stated separately from the deep equality above so a divergence in how
      // the game *ended* reads as its own failure rather than a diff of the
      // entire board.
      expect(stored!.state.status).toBe(fixture.finalState.status)
      expect(stored!.state.winnerPlayerIds).toEqual(fixture.finalState.winnerPlayerIds)
      expect(stored!.state.claimedByAchievementId).toEqual(fixture.finalState.claimedByAchievementId)
    }, REPLAY_TIMEOUT_MS)

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
    }, REPLAY_TIMEOUT_MS)

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
    }, REPLAY_TIMEOUT_MS)

    // The tests above ask whether a real game still replays — whether its past
    // survives a rules change. A game that is still being played needs the
    // other half answered too: can the people in it carry on? That is the
    // question a pre-production deploy actually cares about (issue: exports
    // taken from live games before promoting `main`), and it exercises undo
    // through exactly the path the undo button takes — append a marker to the
    // stored log, re-derive from genesis — rather than through the replay
    // harness, which is where the folded-entry pointer skew lived.
    it('can still be carried on from where it stands: undo and redo round-trip', () => {
      const { unitContent, achievementContent, boardGenerationContent, taleContent } = fixture.content
      const derive = (history: GameState['actionHistory']): GameState =>
        replayActions(fixture.genesis, history, unitContent, achievementContent, boardGenerationContent, taleContent)
      // The log as stored, plus `depth` undo markers, then the same number of
      // redos: a player second-guessing themselves and changing their mind back.
      const marker = (type: 'UNDO_ACTION' | 'REDO_ACTION', turn: number) => ({ turn, action: { type, playerId: null }, timestamp: '' }) as GameState['actionHistory'][number]
      const depth = Math.min(5, resolveHistory(fixture.finalState.actionHistory).effective.length)

      let history = fixture.finalState.actionHistory
      for (let step = 0; step < depth; step += 1) history = [...history, marker('UNDO_ACTION', derive(history).turn)]
      const rewound = derive(history)
      for (let step = 0; step < depth; step += 1) history = [...history, marker('REDO_ACTION', derive(history).turn)]

      // Undo actually moved, and redo put the game back exactly as production
      // left it — everything but the log, which legitimately grew by the
      // markers themselves (they are entries, not a client-local stack).
      const game = (state: GameState) => {
        const { actionHistory: _log, ...rest } = normalizeStateForComparison(state)
        return rest
      }
      expect(game(rewound)).not.toEqual(game(fixture.finalState))
      expect(game(derive(history))).toEqual(game(fixture.finalState))
    })

    it('refuses the game’s first action from a signed-in user who is not seated in it', async () => {
      await seedGame()
      stack.addUser('auth-user-not-in-this-game')
      const first = fixture.finalState.actionHistory[0]

      if (fixture.game.settings.ruleEnforcementEnabled && first.action.type !== 'UNDO_ACTION' && first.action.type !== 'REDO_ACTION') {
        // §4.1: live/async needs an exact (game, seat, caller) match, and even
        // hotseat's blanket "any seat" only extends to players enrolled in
        // that game.
        const result = await stack.applyAction('auth-user-not-in-this-game', fixture.game.id, first.action)
        expect(result).toMatchObject({ ok: false, status: 403 })
      }

      // And the direct write path is closed to them too, enforced or not —
      // 0001_init_schema.sql's update policy has always required a seat.
      const { data } = await stack
        .clientFor('auth-user-not-in-this-game')
        .from('game_state')
        .update({ state: fixture.finalState, turn: fixture.finalState.turn, active_player_id: null, version: 1 })
        .eq('game_id', fixture.game.id)
        .eq('version', 0)
        .select('version')
      expect(data).toEqual([])
      expect((await stack.readGameState(fixture.players[0].user_id, fixture.game.id))?.version).toBe(0)
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
