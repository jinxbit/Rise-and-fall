// One production smoke run: for each eligible game fixture, open an isolated
// room on a real Supabase project, replay the whole recorded game through the
// deployed Edge Functions, check it finishes exactly where it finished in
// production, and delete everything it made.
//
// What this catches that `npm run test` cannot: a migration that didn't apply,
// an Edge Function that didn't deploy or won't boot, an RLS policy edited in
// the dashboard, an expired key, a Supabase platform change. The in-process
// stack (src/test/supabaseStack/) proves the *code* is right; this proves the
// *deployment* is.
//
// Deliberately written as a plain async function rather than a test body, so
// the identical run drives two entry points: ./productionSmoke.smoke.ts
// against the real project, and ../__tests__/productionSmokeRunner.test.ts
// against the in-process stack, which is what keeps this file itself honest
// in CI rather than only when it fails at 3am against production.

import { calculateVPBreakdown } from '../../engine/victoryPoints.ts'
import type { GameState } from '../../engine/types.ts'
import type { CompressedGameState } from '../../lib/gameStateCompression.ts'
import { divergentStateFields, type ProductionGameFixture } from '../fixtures/productionGames/loadFixtures.ts'
import { expectedFinalState, normalizeForComparison, replayFixtureThroughStack } from '../supabaseStack/replayFixture.ts'
import { provisionLiveRoom, type LiveProjectConfig, type LiveRoom } from './liveProject.ts'

export interface SmokeReport {
  fixture: string
  /** Absent when the fixture was skipped — `skippedReason` says why. */
  gameId?: string
  skippedReason?: string
  actionsSubmitted?: number
  foldedEntries?: number
  durationMs?: number
}

export type SmokeLogger = (message: string) => void

/**
 * Rebuilds `fixture` as one describing the live room, so the shared replay
 * routine can drive it unchanged. Exported for
 * ./hiddenInformationWire.ts (HIDDEN_INFORMATION_PLAN.md §8 phase 9), which
 * reuses this same provisioning rather than a second path to a live project,
 * then keeps driving the same room past where a fixture replay would stop.
 */
export function fixtureForRoom(fixture: ProductionGameFixture, room: LiveRoom): ProductionGameFixture {
  const { remapped } = room
  // The smoke room is deliberately 'live' even when the recorded game was
  // 'async' (see provisionLiveRoom's doc comment: only 'async' games page
  // anyone). Play mode is carried on GameState but never read by the engine,
  // and the enforcement path treats live and async identically, so this is the
  // one field the replay is expected to differ on — stated here rather than
  // left to surface as a mystery diff.
  const finalState: GameState = { ...remapped.expectedFinalState, playMode: room.game.play_mode }
  return {
    ...fixture,
    game: room.game,
    players: room.players,
    genesis: room.genesis,
    finalState,
    expected: { finalScoreByPlayerId: remapped.expectedScoreByPlayerId, winnerPlayerIds: remapped.expectedWinnerPlayerIds },
    userIdForPlayer: remapped.userIdForPlayer,
    finalScores(state: GameState) {
      const breakdown = calculateVPBreakdown(state, fixture.content.achievementContent, fixture.content.taleContent)
      return Object.fromEntries(state.players.map((player) => [player.id, breakdown[player.id]?.total ?? 0]))
    },
    describePlayer(playerId: string) {
      const player = finalState.players.find((candidate) => candidate.id === playerId)
      return player ? `${player.displayName} (${player.color})` : playerId
    },
  }
}

function assertThat(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * A fixture is eligible only if it was played on the rule-enforced path.
 * Forcing enforcement onto a client-trusted game would replay it against
 * rules it was never played under — and at least one checked-in game
 * genuinely cannot survive that (see the hotseat owner-override gap pinned in
 * ../__tests__/supabaseStack.test.ts). Skipping is reported, not silent.
 */
function eligibility(fixture: ProductionGameFixture): string | null {
  if (!fixture.game.settings.ruleEnforcementEnabled) {
    return 'played on the client-trusted write path, so it never exercised the deployed Edge Functions'
  }
  if (fixture.finalState.status !== 'completed') {
    return 'the exported game never finished, so there is no end state to verify against'
  }
  return null
}

export async function runProductionSmoke(
  config: LiveProjectConfig,
  fixtures: ProductionGameFixture[],
  log: SmokeLogger = () => {},
): Promise<SmokeReport[]> {
  const reports: SmokeReport[] = []

  for (const fixture of fixtures) {
    const skippedReason = eligibility(fixture)
    if (skippedReason) {
      log(`skip  ${fixture.name}: ${skippedReason}`)
      reports.push({ fixture: fixture.name, skippedReason })
      continue
    }

    const startedAt = Date.now()
    log(`start ${fixture.name}: provisioning a room for ${fixture.finalState.players.length} throwaway players`)
    const room = await provisionLiveRoom(config, fixture)
    try {
      const roomFixture = fixtureForRoom(fixture, room)

      // The game starts: genesis is on the row, untouched, at version 0.
      const seeded = await room.readGameState()
      assertThat(seeded !== null, `[${fixture.name}] the room has no game_state row after starting.`)
      assertThat(seeded.version === 0, `[${fixture.name}] genesis landed at version ${seeded.version}, expected 0.`)
      assertThat(
        seeded.state.status === room.genesis.status,
        `[${fixture.name}] genesis stored as status "${seeded.state.status}", expected "${room.genesis.status}".`,
      )

      log(`      replaying ${roomFixture.finalState.actionHistory.length} actions through the deployed Edge Functions`)
      const outcome = await replayFixtureThroughStack(room, roomFixture)

      // And it finishes where production finished it.
      const stored = await room.readGameState()
      assertThat(stored !== null, `[${fixture.name}] the game_state row vanished mid-replay.`)
      assertThat(
        stored.version === outcome.version,
        `[${fixture.name}] finished at version ${stored.version}, expected ${outcome.version} — something else wrote this row.`,
      )
      assertThat(
        stored.state.status === 'completed',
        `[${fixture.name}] finished with status "${stored.state.status}", expected "completed".`,
      )

      const scores = roomFixture.finalScores(stored.state)
      for (const [playerId, expected] of Object.entries(roomFixture.expected.finalScoreByPlayerId ?? {})) {
        assertThat(
          scores[playerId] === expected,
          `[${fixture.name}] ${roomFixture.describePlayer(playerId)} finished on ${scores[playerId]} points, expected ${expected}.`,
        )
      }
      const winners = [...stored.state.winnerPlayerIds].sort()
      const expectedWinners = [...(roomFixture.expected.winnerPlayerIds ?? stored.state.winnerPlayerIds)].sort()
      assertThat(
        JSON.stringify(winners) === JSON.stringify(expectedWinners),
        `[${fixture.name}] winners were ${winners.map(roomFixture.describePlayer).join(', ')}, expected ${expectedWinners.map(roomFixture.describePlayer).join(', ')}.`,
      )

      // Everything else about the game, not just the bottom line. Compared
      // field by field with keys sorted — a state assembled by the deployed
      // engine and one parsed from an export are never in the same key order.
      const expectedState = expectedFinalState(roomFixture, outcome)
      const diverged = divergentStateFields(normalizeForComparison(stored.state), normalizeForComparison(expectedState))
      assertThat(
        diverged.length === 0,
        `[${fixture.name}] the finished state differs from the one this game ended on in production (on ${diverged.join(', ')}).`,
      )

      log(`ok    ${fixture.name}: ${outcome.version} actions, finished ${winners.map(roomFixture.describePlayer).join(', ')} ahead`)
      reports.push({
        fixture: fixture.name,
        gameId: room.game.id,
        actionsSubmitted: outcome.version,
        foldedEntries: outcome.foldedEntryIndices.length,
        durationMs: Date.now() - startedAt,
      })
    } finally {
      await room.teardown()
    }
  }

  return reports
}

/** Reads `game_state.state` without decompressing it, to check the enforced path really stored it gzipped. */
export function isCompressed(stored: unknown): stored is CompressedGameState {
  return typeof stored === 'object' && stored !== null && '__gz' in stored
}
