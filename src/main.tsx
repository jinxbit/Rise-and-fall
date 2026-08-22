import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const root = createRoot(document.getElementById('root')!)

// Dynamically imported so a missing Supabase env var (thrown from
// src/lib/supabase.ts at module load) shows a readable message instead of a
// blank white screen with only a console error.
import('./App.tsx')
  .then(({ default: App }) => {
    // A successful load means the current build is usable — clear the
    // reload-once guard from index.html so a future stale-asset error (after
    // the *next* deploy) can trigger a fresh auto-reload again.
    try {
      sessionStorage.removeItem('rf:reload-on-stale-asset')
    } catch {
      // storage access blocked (e.g. sandboxed iframe, strict privacy mode) — not fatal
    }
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
  .catch((error: unknown) => {
    // A dynamic import() rejection here is usually a stale-chunk 404 (e.g.
    // right after clicking the update banner's Reload button while a deploy
    // is still propagating) rather than a real configuration problem, but it
    // doesn't fire the <script>/<link> "error" event index.html's stale-asset
    // handler listens for (issue #247). Reuse that same guard to retry once
    // before dead-ending the user on this error screen.
    const reloadedOnce = (() => {
      try {
        const key = 'rf:reload-on-stale-asset'
        if (sessionStorage.getItem(key)) return true
        sessionStorage.setItem(key, '1')
        return false
      } catch {
        // storage access blocked — fall through to the error screen below
        return true
      }
    })()

    if (!reloadedOnce) {
      window.location.reload()
      return
    }

    root.render(
      <div className="mx-auto max-w-lg p-8 text-neutral-100">
        <h1 className="text-xl font-semibold text-red-400">Configuration error</h1>
        <p className="mt-2 text-neutral-400">{error instanceof Error ? error.message : String(error)}</p>
      </div>,
    )
  })
