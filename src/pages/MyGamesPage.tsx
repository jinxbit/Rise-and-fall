import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { listMyGames } from '../lib/gameApi'
import {
  formatUpdatedAt,
  groupMyGames,
  isMyTurn,
  myGameStatus,
  pendingActorIds,
  type MyGameEntry,
  type MyGameStatus,
} from '../lib/myGamesView'

const STATUS_LABEL: Record<MyGameStatus, string> = {
  lobby: 'Waiting in lobby',
  boardSetup: 'Setting up board',
  active: 'In progress',
  completed: 'Finished',
  canceled: 'Canceled',
}

/**
 * Where clicking a game row should go. Keyed off whether a game_state row
 * exists yet, not `games.status === 'lobby'` — a room canceled before it
 * ever started has `status: 'canceled'` with no `gameState`, and still
 * belongs on the lobby screen (LobbyPage shows the canceled banner/Delete
 * there), not GamePage.
 */
function gamePath(entry: MyGameEntry): string {
  return entry.gameState === null ? `/lobby/${entry.game.room_code}` : `/game/${entry.game.room_code}`
}

export function MyGamesPage() {
  const { session, loading: authLoading } = useAuth()
  const navigate = useNavigate()

  const [entries, setEntries] = useState<MyGameEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setEntries(null)
    setError(null)
    listMyGames(session.user.id)
      .then((result) => {
        if (!cancelled) setEntries(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load games')
      })
    return () => {
      cancelled = true
    }
  }, [session])

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>
  if (!session) {
    return (
      <div className="p-8 text-neutral-400">
        <Link to="/" className="underline hover:text-neutral-200">
          Sign in
        </Link>{' '}
        to see your games.
      </div>
    )
  }

  const { active, finished, canceled } = groupMyGames(entries ?? [])

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">My games</h1>
        <Link to="/" className="text-sm underline hover:text-neutral-200">
          Home
        </Link>
      </header>

      {error && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}

      {entries === null && !error && <div className="text-neutral-400">Loading…</div>}

      {entries !== null && entries.length === 0 && (
        <div className="text-neutral-400">You haven&apos;t joined any games yet.</div>
      )}

      {active.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Active</h2>
          <ul className="flex flex-col gap-2">
            {active.map((entry) => (
              <GameRowItem key={entry.game.id} entry={entry} onOpen={() => navigate(gamePath(entry))} />
            ))}
          </ul>
        </section>
      )}

      {finished.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Finished</h2>
          <ul className="flex flex-col gap-2">
            {finished.map((entry) => (
              <GameRowItem key={entry.game.id} entry={entry} onOpen={() => navigate(gamePath(entry))} />
            ))}
          </ul>
        </section>
      )}

      {canceled.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Canceled</h2>
          <ul className="flex flex-col gap-2">
            {canceled.map((entry) => (
              <GameRowItem key={entry.game.id} entry={entry} onOpen={() => navigate(gamePath(entry))} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function GameRowItem({ entry, onOpen }: { entry: MyGameEntry; onOpen: () => void }) {
  const myTurn = isMyTurn(entry)
  const status = myGameStatus(entry)
  const finished = status === 'completed'
  const pending = pendingActorIds(entry)

  return (
    <li>
      <button
        onClick={onOpen}
        className={`flex w-full flex-col gap-1 rounded-md border px-4 py-3 text-left ${
          myTurn
            ? 'border-indigo-500 bg-indigo-950/40 hover:border-indigo-400'
            : finished
              ? 'border-neutral-800/60 bg-neutral-900/40 text-neutral-500 hover:border-neutral-700'
              : 'border-neutral-800 bg-neutral-900 hover:border-neutral-600'
        }`}
      >
        <span className={`font-medium ${finished ? 'text-neutral-500' : ''}`}>{entry.game.name}</span>
        <span className={`text-sm ${finished ? 'text-neutral-600' : 'text-neutral-400'}`}>
          {STATUS_LABEL[status]} ·{' '}
          {entry.players.map((p, i) => (
            <span key={p.id} className={pending.includes(p.id) ? 'font-semibold text-neutral-100' : undefined}>
              {i > 0 && ', '}
              {p.display_name}
            </span>
          ))}
        </span>
        <span className={`text-xs ${finished ? 'text-neutral-600' : 'text-neutral-500'}`}>
          {formatUpdatedAt(entry.game.updated_at)}
        </span>
      </button>
    </li>
  )
}
