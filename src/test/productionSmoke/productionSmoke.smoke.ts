// The production entry point: runs ./runSmoke.ts against the real, deployed
// Supabase project named by the environment.
//
// Named `.smoke.ts` rather than `.test.ts` on purpose — vitest's default
// `include` only matches `*.test.*`/`*.spec.*`, so `npm run test` and CI never
// pick this up and never touch production. It runs only through
// `npm run test:production` (vitest.production.config.ts), which is what
// .github/workflows/production-smoke.yml invokes after a Supabase deploy and
// nightly.
//
// Required environment (see that workflow for how they're supplied):
//   SMOKE_SUPABASE_URL               https://<project-ref>.supabase.co
//   SMOKE_SUPABASE_ANON_KEY          the project's anon/public key
//   SMOKE_SUPABASE_SERVICE_ROLE_KEY  service role key — used ONLY to create
//                                    and delete the run's throwaway users
//
// Everything this creates is deleted again by `runProductionSmoke`'s `finally`
// (room first, then users — `games.created_by` and `players.user_id` reference
// `auth.users` with no cascade). If a run is killed hard enough to skip that,
// the leftovers are one `[smoke] …` private room and its throwaway accounts.

import { describe, expect, it } from 'vitest'
import { loadProductionGameFixtures } from '../fixtures/productionGames/loadFixtures.ts'
import { liveProjectConfigFromEnv } from './liveProject.ts'
import { runProductionSmoke } from './runSmoke.ts'

// tsconfig.app.json's `types` is `["vite/client"]` — this is the one file in
// `src` that reads the process environment, so it declares what it needs
// rather than pulling node's globals into the whole app program.
declare const process: { env: Record<string, string | undefined> }

const fixtures = await loadProductionGameFixtures()

describe('production smoke', () => {
  it('replays every eligible game against the deployed project and it finishes as recorded', async () => {
    const config = liveProjectConfigFromEnv(process.env)
    const reports = await runProductionSmoke(config, fixtures, (message) => console.log(message))

    const ran = reports.filter((report) => !report.skippedReason)
    for (const report of reports) {
      console.log(
        report.skippedReason
          ? `- ${report.fixture}: skipped (${report.skippedReason})`
          : `- ${report.fixture}: ${report.actionsSubmitted} actions in ${report.durationMs}ms (game ${report.gameId})`,
      )
    }

    // A run where every fixture was skipped is a green tick that verified
    // nothing — the most dangerous shape a smoke test can take.
    expect(ran.length, 'no fixture was eligible to run against production').toBeGreaterThan(0)
  }, 900_000)
})
