// The live entry point for ./seedFinishedGame.ts. Kept out of `npm run test`
// exactly the way the smoke test is (see ../productionSmoke/README.md): the
// default vitest config's `include` matches `*.test.*` only, this file is
// `*.seed.ts`, and ../../../vitest.seed.config.ts is the only config that
// matches it. Nothing that runs on a PR can reach a live project from here.
//
// SEED_FIXTURE names which recorded game to seed; omit it for the default.

import { describe, it } from 'vitest'
import { liveProjectConfigFromEnv } from '../productionSmoke/liveProject.ts'
import { loadProductionGameFixtures } from '../fixtures/productionGames/loadFixtures.ts'
import { seedFinishedGame } from './seedFinishedGame.ts'

// tsconfig.app.json's `types` is `["vite/client"]`, so node's globals are not
// in this program — the same reason ../productionSmoke/productionSmoke.smoke.ts
// declares this rather than widening the app's types for one file.
declare const process: { env: Record<string, string | undefined> }

const DEFAULT_FIXTURE = 'three-player-red-runaway'

describe('preview seed', () => {
  it('leaves one finished game on the project for manual testing', async () => {
    const wanted = process.env.SEED_FIXTURE?.trim() || DEFAULT_FIXTURE
    const fixtures = await loadProductionGameFixtures()
    const fixture = fixtures.find((candidate) => candidate.name === wanted)
    if (!fixture) {
      throw new Error(`No fixture named "${wanted}". Available: ${fixtures.map((f) => f.name).join(', ')}`)
    }

    const seeded = await seedFinishedGame(liveProjectConfigFromEnv(process.env), fixture, (message) => console.log(`      ${message}`))

    const scores = Object.entries(seeded.finalScores)
      .sort(([, a], [, b]) => b - a)
      .map(([name, score]) => `${name} ${score}`)
      .join(', ')
    console.log(`\nSeeded "${seeded.name}"`)
    console.log(`  room code: ${seeded.roomCode}`)
    console.log(`  game id:   ${seeded.gameId}`)
    console.log(`  final:     ${scores}`)
    console.log(`  It is a PUBLIC room, so it is on the Public Rooms screen — and it is not cleaned up.\n`)
  })
})
