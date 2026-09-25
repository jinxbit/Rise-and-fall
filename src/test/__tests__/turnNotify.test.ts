// @vitest-environment node
//
// Pins who the turn pings (notify-discord-turn, notify-web-push) decide to
// notify, against the engine's own answer, on the rows a Database Webhook
// actually delivers.
//
// The functions can't see a full GameState: a webhook's `record`/
// `old_record` carry the stored `game_state` row, and a rule-enforced game
// stores its state gzipped with only a few fields in plaintext
// (src/lib/gameStateCompression.ts). todo.md #150 was exactly that gap —
// `activePlayerId` isn't one of the plaintext fields, so every action-phase
// turn in an enforced game went unpinged while every test of the engine
// passed. So the sweep below walks every state of every checked-in production
// game, stores each one both ways (compressed, as the Edge Functions write
// it, and plain, as a client-trusted game's direct write does), round-trips
// the row through JSON as the webhook does, and requires
// ../../../supabase/functions/_shared/turnNotify.ts to name exactly the
// players the engine's pendingActorIds() newly owes a turn.

import { describe, expect, it } from 'vitest'
import type { LoggedAction } from '../../engine/actions.ts'
import { extendReplay } from '../../engine/replay.ts'
import { pendingActorIds as enginePendingActorIds } from '../../engine/turnOrder.ts'
import type { GameState } from '../../engine/types.ts'
import { compressGameStateForStorage } from '../../lib/gameStateCompression.ts'
import { loadProductionGameFixtures, type ProductionGameFixture } from '../fixtures/productionGames/loadFixtures.ts'
import { type GameStateRow, justFinished, newlyPendingActorIds, phaseLabel } from '../../../supabase/functions/_shared/turnNotify.ts'

const fixtures = await loadProductionGameFixtures()

type Encoding = 'compressed' | 'plain'

/** The row as the webhook delivers it: the stored `state` plus the `active_player_id` column both write paths set. */
async function webhookRow(gameId: string, state: GameState, encoding: Encoding): Promise<GameStateRow> {
  const stored = encoding === 'compressed' ? await compressGameStateForStorage(state) : state
  return JSON.parse(JSON.stringify({ game_id: gameId, state: stored, active_player_id: state.activePlayerId })) as GameStateRow
}

/** What the engine says a write from `before` to `after` newly owes — the answer the functions have to reproduce. */
function engineNewlyPending(before: GameState, after: GameState): string[] {
  const wasPending = new Set(enginePendingActorIds(before))
  return enginePendingActorIds(after).filter((id) => !wasPending.has(id))
}

/** Every consecutive pair of states the game went through, one per logged entry. */
function* statePairs(fixture: ProductionGameFixture): Generator<[GameState, GameState, LoggedAction]> {
  const { unitContent, achievementContent, boardGenerationContent, taleContent } = fixture.content
  let state = fixture.genesis
  for (const entry of fixture.finalState.actionHistory) {
    const next = extendReplay(fixture.genesis, state, [entry], unitContent, achievementContent, boardGenerationContent, taleContent)
    yield [state, next, entry]
    state = next
  }
}

describe('turn-ping decision (supabase/functions/_shared/turnNotify.ts)', () => {
  it('has checked-in games to sweep', () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  describe.each(fixtures.map((fixture) => [fixture.name, fixture] as const))('%s', (_name, fixture) => {
    it.each<Encoding>(['compressed', 'plain'])('pings exactly the players the engine newly owes a turn, from a %s row', async (encoding) => {
      let actionPhaseHandoffs = 0
      let index = 0
      for (const [before, after, entry] of statePairs(fixture)) {
        const oldRow = await webhookRow(fixture.game.id, before, encoding)
        const newRow = await webhookRow(fixture.game.id, after, encoding)
        const where = `${fixture.name} entry #${index} (${entry.action.type}, ${after.status}/${after.roundPhase})`

        expect(newlyPendingActorIds(oldRow, newRow), where).toEqual(engineNewlyPending(before, after))
        expect(justFinished(oldRow.state, newRow.state), where).toBe(before.status !== 'completed' && after.status === 'completed')
        if (after.status === 'active' && after.roundPhase === 'actions' && after.activePlayerId !== before.activePlayerId && after.activePlayerId) {
          actionPhaseHandoffs++
        }
        index++
      }
      // The case todo.md #150 missed has to actually occur in the sweep, or
      // the equality above proves nothing about it.
      expect(actionPhaseHandoffs, `${fixture.name} never hands the action phase to a new player`).toBeGreaterThan(0)
    })

    it('labels the phase the same from a compressed row as from the full state', async () => {
      for (const [, after] of statePairs(fixture)) {
        const compressed = await webhookRow(fixture.game.id, after, 'compressed')
        const plain = await webhookRow(fixture.game.id, after, 'plain')
        expect(phaseLabel(compressed.state)).toBe(phaseLabel(plain.state))
      }
    })
  })

  describe('rows built by hand', () => {
    const actions = {
      __gz: 'irrelevant',
      status: 'active',
      roundPhase: 'actions',
      turn: 3,
      pendingPlayerIds: [],
      turnOrder: ['a', 'b'],
      boardSetup: null,
    }

    it('reads the action-phase player from active_player_id when the state is compressed (todo.md #150)', () => {
      const oldRow = { game_id: 'g', state: actions, active_player_id: 'a' } as unknown as GameStateRow
      const newRow = { game_id: 'g', state: actions, active_player_id: 'b' } as unknown as GameStateRow
      expect(newlyPendingActorIds(oldRow, newRow)).toEqual(['b'])
    })

    it('falls back to state.activePlayerId when the column is null', () => {
      const oldRow = { game_id: 'g', state: { ...actions, activePlayerId: 'a' }, active_player_id: null } as unknown as GameStateRow
      const newRow = { game_id: 'g', state: { ...actions, activePlayerId: 'b' }, active_player_id: null } as unknown as GameStateRow
      expect(newlyPendingActorIds(oldRow, newRow)).toEqual(['b'])
    })

    it('pings the one builder in "Build alone" mode, not the turn-order tile placer', () => {
      const boardSetup = (tilePlacerIndex: number) => ({
        status: 'boardSetup',
        roundPhase: 'selectCards',
        turn: 0,
        pendingPlayerIds: [],
        turnOrder: ['a', 'b'],
        boardSetup: { tileTierQueue: [1], tilePlacerIndex, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0, builderId: 'b' },
      })
      const lobby = { game_id: 'g', state: { ...boardSetup(0), status: 'lobby' }, active_player_id: null } as unknown as GameStateRow
      const setup = { game_id: 'g', state: boardSetup(0), active_player_id: null } as unknown as GameStateRow
      expect(newlyPendingActorIds(lobby, setup)).toEqual(['b'])
    })
  })
})
