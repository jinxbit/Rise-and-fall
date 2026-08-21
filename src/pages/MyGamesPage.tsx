import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { GameOverviewCard } from '../components/GameOverviewCard'
import { useAuth } from '../hooks/useAuth'
import { listMyGames } from '../lib/gameApi'
import { buildGameCardSummary } from '../lib/gameCardView'
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

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

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
  const status = myGameStatus(entry)

  return (
    <GameOverviewCard
      name={entry.game.name}
      phase={STATUS_LABEL[status]}
      players={entry.players}
      pendingPlayerIds={pendingActorIds(entry)}
      isMyTurn={isMyTurn(entry)}
      isFinished={status === 'completed'}
      updatedAt={formatUpdatedAt(entry.game.updated_at)}
      summary={buildGameCardSummary(entry.game, entry.gameState, entry.players)}
      onOpen={onOpen}
    />
  )
}
