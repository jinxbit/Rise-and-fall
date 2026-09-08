import { defineConfig } from 'vitest/config'

// Runs ONLY the production smoke test (src/test/productionSmoke/*.smoke.ts),
// which talks to the real deployed Supabase project. Kept in its own config
// rather than behind a flag in vite.config.ts so there is no path by which
// `npm run test` — the one CI runs on every PR — can reach production: that
// config's default `include` matches `*.test.*` only, and this one matches
// `*.smoke.ts` only.
//
// `node` environment (this is server-side work, no DOM), no jsdom setup file,
// and a long timeout: a full game is hundreds of sequential HTTPS round trips
// to Supabase.
export default defineConfig({
  test: {
    include: ['src/test/productionSmoke/**/*.smoke.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // The Edge Functions' own `jsr:` specifier, mapped onto the npm package —
    // see src/test/supabaseStack/edgeFunctions.ts. Needed here too because the
    // fixture loader's module graph reaches gameEnforcement.ts.
    alias: { 'jsr:@supabase/supabase-js@2': '@supabase/supabase-js' },
  },
})
