import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

const root = createRoot(document.getElementById('root')!)

// Dynamically imported so a missing Supabase env var (thrown from
// src/lib/supabase.ts at module load) shows a readable message instead of a
// blank white screen with only a console error.
import('./App.tsx')
  .then(({ default: App }) => {
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    )
  })
  .catch((error: unknown) => {
    root.render(
      <div className="mx-auto max-w-lg p-8 text-neutral-100">
        <h1 className="text-xl font-semibold text-red-400">Configuration error</h1>
        <p className="mt-2 text-neutral-400">{error instanceof Error ? error.message : String(error)}</p>
      </div>,
    )
  })
