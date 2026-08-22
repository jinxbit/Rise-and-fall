// Admin screen (issue #185) for browsing and deleting saved maps
// (src/lib/mapPoolApi.ts's map_pool table, populated by MapBuilderPage.tsx).
// Gated the same way GamePage.tsx/LobbyPage.tsx gate their admin-only
// "delete any game" action (useIsAdmin, backed by 0017/0018's is_admin
// column) — there's no roles system beyond that single flag.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { HexBoard } from '../components/HexBoard'
import { Pagination } from '../components/Pagination'
import { useAuth } from '../hooks/useAuth'
import { useIsAdmin } from '../hooks/useIsAdmin'
import { deleteMapFromPool, listAllMapPool } from '../lib/mapPoolApi'
import { paginate } from '../lib/pagination'
import { toAppError, type AppError } from '../lib/errors'
import type { MapPoolRow } from '../lib/dbTypes'

const PAGE_SIZE = 12
const PREVIEW_SIZE = 14

export function AdminMapsPage() {
  const { session, loading: authLoading } = useAuth()
  const isAdmin = useIsAdmin(session?.user ?? null)

  const [maps, setMaps] = useState<MapPoolRow[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    listAllMapPool()
      .then((result) => {
        if (!cancelled) setMaps(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toAppError(err, 'Failed to load maps'))
      })
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  async function handleDelete(mapId: string) {
    setDeletingId(mapId)
    setError(null)
    try {
      await deleteMapFromPool(mapId)
      setMaps((prev) => prev?.filter((m) => m.id !== mapId) ?? prev)
    } catch (err) {
      setError(toAppError(err, 'Failed to delete map'))
    } finally {
      setDeletingId(null)
    }
  }

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>

  if (!session || !isAdmin) {
    return (
      <div className="p-8 text-neutral-400">
        <Link to="/" className="underline hover:text-neutral-200">
          Home
        </Link>
        {!session ? ' — sign in as an admin to manage saved maps.' : ' — you do not have access to this page.'}
      </div>
    )
  }

  const pageItems = paginate(maps ?? [], page, PAGE_SIZE)

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Saved maps</h1>
        <Link to="/" className="text-sm underline hover:text-neutral-200">
          Home
        </Link>
      </header>

      {error && <ErrorBanner message={error.message} details={error.details} onDismiss={() => setError(null)} />}

      {maps === null && !error && <div className="text-neutral-400">Loading…</div>}

      {maps !== null && maps.length === 0 && <div className="text-neutral-400">No saved maps in the pool.</div>}

      {maps !== null && maps.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {pageItems.map((map) => (
              <div key={map.id} className="flex flex-col items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 p-3">
                <HexBoard board={map.board} interactive={false} size={PREVIEW_SIZE} />
                <span className="text-sm text-neutral-400">{map.player_count} players</span>
                <span className="text-xs text-neutral-500">{new Date(map.created_at).toLocaleDateString()}</span>
                <button
                  type="button"
                  disabled={deletingId === map.id}
                  onClick={() => void handleDelete(map.id)}
                  className="rounded-md border border-red-900 px-3 py-1 text-xs text-red-400 hover:border-red-600 disabled:opacity-50"
                >
                  {deletingId === map.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            ))}
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={maps.length} onChange={setPage} />
        </>
      )}
    </div>
  )
}
