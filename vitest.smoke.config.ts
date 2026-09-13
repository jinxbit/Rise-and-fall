import { defineConfig } from 'vitest/config'

// Runs ONLY the smoke test (src/test/productionSmoke/*.smoke.ts), which talks
// to whichever real deployed Supabase project the SMOKE_* environment
// variables name. Kept in its own config rather than behind a flag in
// vite.config.ts so there is no path by which `npm run test` — the one CI
// runs on every PR — can reach a live project: that config's default
// `include` matches `*.test.*` only, and this one matches `*.smoke.ts` only.
//
// `node` environment (this is server-side work, no DOM), no jsdom setup file,
// and a long timeout: a full game is hundreds of sequential HTTPS round trips
// to Supabase.
//
// `fileParallelism: false` (issue #573): this directory has exactly two
// `.smoke.ts` files, and vitest otherwise runs them concurrently. Issue #570
// fixed the proven cause of one red (a deploy's migration reshaping the
// Realtime publication mid-run) but explicitly left this alone, since that
// run's failure overlapped no deploy and a second, unproven theory — the two
// files contending for the runner's ~2 CPUs — could equally explain it.
// #573 repeated the exact same "no Realtime payload" failure on a run whose
// timestamps rule out any deploy overlap (the Actions API shows the deploy
// finished ~25s before the replay step even started), while
// `productionSmoke.smoke.ts` was mid-replay of a 700+ action fixture the
// whole time — confirming the second theory rather than a third one.
// Serializing the two files trades a longer total run (they no longer
// overlap) for not starving `hiddenInformationWire.smoke.ts`'s Realtime
// subscription of event-loop/CPU time while it waits on its 60s window
// (issue #555).
export default defineConfig({
  test: {
    include: ['src/test/productionSmoke/**/*.smoke.ts'],
    environment: 'node',
    globals: true,
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // The Edge Functions' own `jsr:` specifier, mapped onto the npm package —
    // see src/test/supabaseStack/edgeFunctions.ts. Needed here too because the
    // fixture loader's module graph reaches gameEnforcement.ts.
    alias: { 'jsr:@supabase/supabase-js@2': '@supabase/supabase-js' },
  },
})
