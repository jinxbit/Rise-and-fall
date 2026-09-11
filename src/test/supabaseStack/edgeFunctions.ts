// Loads the real Edge Functions — supabase/functions/{apply,undo,redo}-action
// and get-game-state's index.ts, unmodified — into the vitest process.
//
// Each of those files ends in a top-level `Deno.serve(handler)`, so stubbing
// `Deno.serve` is all it takes to capture the handler and then call it with
// ordinary `Request`/`Response` objects. That's the difference between these
// tests and a unit test of the engine: the status codes, the JSON error
// bodies, the SET_ADMIN_MODE and per-seat authorization branches, the
// compare-and-swap 409 — all of it is the code that actually runs in
// production, not a re-implementation of it.
//
// The one thing that can't be stubbed away is the `jsr:@supabase/supabase-js@2`
// specifier the Edge Runtime resolves natively; vite.config.ts's `test.alias`
// maps it onto the npm package the app already depends on (same library, same
// major version), and src/test/supabaseStack/denoShim.d.ts declares both that
// module and the `Deno` global so `tsc -b` still type-checks this tree.

import { ANON_KEY, SERVICE_ROLE_KEY, STACK_URL, type EdgeFunctionHandler } from './httpServer.ts'

export const EDGE_FUNCTION_NAMES = ['apply-action', 'undo-action', 'redo-action', 'get-game-state', 'start-game'] as const
export type EdgeFunctionName = (typeof EDGE_FUNCTION_NAMES)[number]

const EDGE_FUNCTION_ENV: Record<string, string> = {
  SUPABASE_URL: STACK_URL,
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
}

const handlers = new Map<string, EdgeFunctionHandler>()

/**
 * Idempotent and cached: vite's module registry runs each function module's
 * top-level `Deno.serve` exactly once per test file, so the capture has to
 * happen on first load and be reused from then on.
 */
let loaded: Promise<Map<string, EdgeFunctionHandler>> | null = null

export function loadEdgeFunctions(): Promise<Map<string, EdgeFunctionHandler>> {
  loaded ??= captureHandlers()
  return loaded
}

async function captureHandlers(): Promise<Map<string, EdgeFunctionHandler>> {
  let loading: EdgeFunctionName | null = null

  globalThis.Deno = {
    env: { get: (key: string) => EDGE_FUNCTION_ENV[key] },
    serve: (handler: EdgeFunctionHandler) => {
      if (!loading) throw new Error('Deno.serve() was called outside of an Edge Function import — the test stack cannot tell which function it belongs to.')
      handlers.set(loading, handler)
    },
  }

  // Imported one at a time so the `Deno.serve` above knows which function it
  // is capturing. Static specifiers (not a computed path) so vite resolves
  // and transforms them, which is what applies the `jsr:` alias.
  loading = 'apply-action'
  await import('../../../supabase/functions/apply-action/index.ts')
  loading = 'undo-action'
  await import('../../../supabase/functions/undo-action/index.ts')
  loading = 'redo-action'
  await import('../../../supabase/functions/redo-action/index.ts')
  loading = 'get-game-state'
  await import('../../../supabase/functions/get-game-state/index.ts')
  loading = 'start-game'
  await import('../../../supabase/functions/start-game/index.ts')
  loading = null

  for (const name of EDGE_FUNCTION_NAMES) {
    if (!handlers.has(name)) throw new Error(`${name}/index.ts did not call Deno.serve() — the test stack has no handler for it.`)
  }
  return handlers
}
