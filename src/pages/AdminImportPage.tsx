// Admin screen (issue #676) for importing a pasted game state export
// (src/lib/gameStateExport.ts, GamePage.tsx's "Copy game export") into a
// brand-new hotseat room the importing admin owns — lets an admin reproduce
// a reported game without direct Supabase access or the reporter's account.
// Gated the same way AdminMapsPage.tsx/AdminRoomsPage.tsx gate (useIsAdmin,
// backed by the is_admin column) — there's no roles system beyond that
// single flag, and this is a UI-only restriction (see
// importGameExportAsHotseat's doc comment for the RLS it actually relies on).

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { useAuth } from '../hooks/useAuth'
import { useIsAdmin } from '../hooks/useIsAdmin'
import { importGameExportAsHotseat } from '../lib/gameApi'
import { toAppError, type AppError } from '../lib/errors'

export function AdminImportPage() {
  const { session, loading: authLoading } = useAuth()
  const isAdmin = useIsAdmin(session?.user ?? null)
  const navigate = useNavigate()

  const [exportText, setExportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  async function handleImport() {
    if (!session || !exportText.trim()) return
    setImporting(true)
    setError(null)
    try {
      const game = await importGameExportAsHotseat({ exportText, hostUserId: session.user.id })
      navigate(`/game/${game.room_code}`)
    } catch (err) {
      setError(toAppError(err, 'Failed to import game export'))
    } finally {
      setImporting(false)
    }
  }

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>

  if (!session || !isAdmin) {
    return (
      <div className="p-8 text-neutral-400">
        <Link to="/" className="underline hover:text-neutral-200">
          Home
        </Link>
        {!session ? ' — sign in as an admin to import a game export.' : ' — you do not have access to this page.'}
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Import game export</h1>
        <Link to="/" className="text-sm underline hover:text-neutral-200">
          Home
        </Link>
      </header>

      <p className="text-sm text-neutral-400">
        Paste a game state export — from a game page's "Copy game export" action, often attached to a bug report — to load
        it into a brand-new hot seat room you own. All seats become local pass-and-play players under your account; the
        game the export came from is untouched.
      </p>

      {error && <ErrorBanner message={error.message} details={error.details} onDismiss={() => setError(null)} />}

      <textarea
        value={exportText}
        onChange={(e) => setExportText(e.target.value)}
        placeholder='{"schema": "rise-and-fall/game-state-export", ...}'
        rows={10}
        className="w-full rounded-md border border-neutral-700 bg-neutral-900 p-3 font-mono text-xs text-neutral-200"
      />

      <button
        type="button"
        disabled={importing || !exportText.trim()}
        onClick={() => void handleImport()}
        className="self-start rounded-md border border-neutral-700 px-4 py-2 text-sm hover:border-neutral-500 disabled:opacity-50"
      >
        {importing ? 'Importing…' : 'Import as hot seat game'}
      </button>
    </div>
  )
}
