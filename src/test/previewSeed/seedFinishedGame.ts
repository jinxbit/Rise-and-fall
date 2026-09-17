// Puts a real, finished game into a live Supabase project and LEAVES IT
// THERE, so the maintainer has something to open and poke at by hand
// (DELIVERY_PIPELINE_PLAN.md §6 step 3: "go and test it" should cost a click
// rather than fifteen minutes of setting a game up).
//
// This is the smoke test's provisioning and replay, with the two properties
// inverted that make a smoke run safe and a seed useless:
//
// - the room is **public**, not private, so it appears on the Public Rooms
//   screen and can actually be found;
// - nothing is torn down on success, so the room and the accounts that played
//   it survive the run.
//
// Everything else the smoke test's isolation rules ask for still holds, and
// for the same reasons (see ../productionSmoke/README.md): `play_mode: 'live'`
// so neither notification function can page anyone about a game nobody is
// really playing, and throwaway accounts rather than anyone's real one.
//
// The throwaway accounts are deliberately NOT deleted: `players.user_id`
// references `auth.users` with no cascade, so deleting them would either fail
// or strand the room. They are the cost of a seeded game, and the reason this
// is for pre-production only — see ../../../.github/workflows/seed-preview.yml,
// which refuses to run against production at all.

import { replayFixtureThroughStack } from '../supabaseStack/replayFixture.ts'
import type { ProductionGameFixture } from '../fixtures/productionGames/loadFixtures.ts'
import { fixtureForRoom } from '../productionSmoke/runSmoke.ts'
import { provisionLiveRoom, type LiveProjectConfig } from '../productionSmoke/liveProject.ts'

export interface SeededGame {
  gameId: string
  roomCode: string
  name: string
  /** Final score per display name, read back off the finished row. */
  finalScores: Record<string, number>
  /** `game_state.version` the finished row sits on — one per submitted action. */
  version: number
}

export type SeedLogger = (message: string) => void

function assertThat(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * Written as a plain async function rather than a test body for the same
 * reason `runProductionSmoke` is: one routine drives both the live entry
 * point (./seedFinishedGame.seed.ts) and a CI check against the in-process
 * stack (../__tests__/previewSeedRunner.test.ts), so this file stays honest
 * on every PR rather than only when someone runs it against Preview.
 */
export async function seedFinishedGame(
  config: LiveProjectConfig,
  fixture: ProductionGameFixture,
  log: SeedLogger = () => {},
): Promise<SeededGame> {
  log(`provisioning a public room for ${fixture.finalState.players.length} throwaway players`)
  const room = await provisionLiveRoom(config, fixture, { visibility: 'public', namePrefix: '[seed]' })

  try {
    const roomFixture = fixtureForRoom(fixture, room)
    log(`replaying ${roomFixture.finalState.actionHistory.length} actions through the deployed Edge Functions`)
    const outcome = await replayFixtureThroughStack(room, roomFixture)

    const stored = await room.readGameState()
    assertThat(stored !== null, 'the game_state row vanished mid-replay.')
    assertThat(
      stored.state.status === 'completed',
      `seeded game finished with status "${stored.state.status}", expected "completed" — it would be no use for testing a finished game.`,
    )

    const finalScores: Record<string, number> = {}
    for (const [playerId, score] of Object.entries(roomFixture.finalScores(stored.state))) {
      const player = stored.state.players.find((candidate) => candidate.id === playerId)
      finalScores[player?.displayName ?? playerId] = score
    }

    return {
      gameId: room.game.id,
      roomCode: room.game.room_code,
      name: room.game.name,
      finalScores,
      version: outcome.version,
    }
  } catch (error) {
    // Only on failure. A half-played room is noise nobody asked for, and
    // unlike the success case there is nothing in it worth keeping.
    log('seeding failed — removing the partial room')
    await room.teardown().catch(() => {})
    throw error
  }
}
