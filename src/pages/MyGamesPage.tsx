import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { listMyGames } from '../lib/gameApi'
import { groupMyGames, isMyTurn, myGameStatus, type MyGameEntry, type MyGameStatus } from '../lib/myGamesView'

const STATUS_LABEL: Record<MyGameStatus, string> = {
  lobby: 'Waiting in lobby',
  boardSetup: 'Setting up board',
  active: 'In progress',
  completed: 'Finished',
}

/** Where clicking a game row should go — the DB row's status (not the richer GameState one) is what actually gates the lobby route, see LobbyPage's own navigate-on-'active' check. */
function gamePath(entry: MyGameEntry): string {
  return entry.game.status === 'lobby' ? `/lobby/${entry.game.room_code}` : `/game/${entry.game.room_code}`
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

  const { active, finished } = groupMyGames(entries ?? [])

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
    </div>
  )
}

function GameRowItem({ entry, onOpen }: { entry: MyGameEntry; onOpen: () => void }) {
  const myTurn = isMyTurn(entry)
  const status = myGameStatus(entry)

  return (
    <li>
      <button
        onClick={onOpen}
        className="flex w-full items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3 text-left hover:border-neutral-600"
      >
        <div className="flex flex-col gap-1">
          <span className="font-medium">Room {entry.game.room_code}</span>
          <span className="text-sm text-neutral-400">
            {STATUS_LABEL[status]} · {entry.players.map((p) => p.display_name).join(', ')}
          </span>
        </div>
        {myTurn && <span className="shrink-0 rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white">Your turn</span>}
      </button>
    </li>
  )
}
