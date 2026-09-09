// The production entry point for HIDDEN_INFORMATION_PLAN.md §8 phase 9: runs
// ./hiddenInformationWire.ts's full suite (get-game-state, apply-action, and
// a real Realtime subscription) against the real, deployed Supabase project
// named by the environment — see that file's own doc comment for what it
// checks and why it's a headless supabase-js check rather than a Playwright
// browser test.
//
// `.smoke.ts` rather than `.test.ts` for the same reason productionSmoke.
// smoke.ts is: vitest's default `include` only matches `*.test.*`, so
// `npm run test`/CI never reaches a live project. Runs only through
// `npm run test:smoke` (vitest.smoke.config.ts), alongside the existing
// fixture-replay smoke test — same workflow (.github/workflows/smoke.yml),
// same throwaway-user/private-room isolation (liveProject.ts), no separate
// wiring needed since that workflow already runs every `*.smoke.ts` file
// here.
//
// Everything this creates is deleted by checkHiddenInformationWire's own
// `finally` (room first, then users, same order/reasoning as
// provisionLiveRoom's doc comment).

import { describe, expect, it } from 'vitest'
import { liveProjectConfigFromEnv } from './liveProject.ts'
import { runHiddenInformationWireSuite } from './hiddenInformationWire.ts'

// tsconfig.app.json's `types` is `["vite/client"]` — see productionSmoke.
// smoke.ts's own doc comment for why this file declares `process` itself.
declare const process: { env: Record<string, string | undefined> }

describe('hidden-information wire check (issue #480)', () => {
  it('never hands a still-pending opponent a secret pick over get-game-state, apply-action, or Realtime — for selectCards and decline', async () => {
    const config = liveProjectConfigFromEnv(process.env)
    const reports = await runHiddenInformationWireSuite(config, { includeRealtime: true }, (message) => console.log(message))

    expect(reports).toHaveLength(2)
    for (const report of reports) {
      console.log(`- ${report.phase}: ok (game ${report.gameId}, ${report.realtimePayloadsObserved ?? 0} Realtime payload(s) inspected)`)
      expect(report.realtimeChecked).toBe(true)
      // A run that captured zero Realtime payloads proved nothing — the
      // subscription would have to have silently failed to connect.
      expect(report.realtimePayloadsObserved ?? 0).toBeGreaterThan(0)
    }
  }, 300_000)
})
