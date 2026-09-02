import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { GameOverviewCard } from '../components/GameOverviewCard'
import { useAuth } from '../hooks/useAuth'
import { useRefetchOnVisible } from '../hooks/useRefetchOnVisible'
import { listMyGames } from '../lib/gameApi'
import { buildGameCardSummary, formatFinishedAt } from '../lib/gameCardView'
import { toAppError, type AppError } from '../lib/errors'
import {
  describeGamePhase,
  formatUpdatedAt,
  gamePath,
  groupMyGames,
  isMyTurn,
  latestUpdatedAt,
  myGameStatus,
  pendingActorIds,
  type MyGameEntry,
} from '../lib/myGamesView'

export function MyGamesPage() {
  const { session, loading: authLoading } = useAuth()
  const navigate = useNavigate()

  const [entries, setEntries] = useState<MyGameEntry[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)

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
        if (!cancelled) setError(toAppError(err, 'Failed to load games'))
      })
    return () => {
      cancelled = true
    }
  }, [session])

  useRefetchOnVisible(() => {
    if (!session) return
    listMyGames(session.user.id)
      .then(setEntries)
      .catch((err: unknown) => setError(toAppError(err, 'Failed to load games')))
  })

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

      {error && <ErrorBanner message={error.message} details={error.details} onDismiss={() => setError(null)} />}

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
  const finished = status === 'completed'
  const updatedAt = latestUpdatedAt(entry.game, entry.gameStateUpdatedAt)

  return (
    <GameOverviewCard
      name={entry.game.name}
      phase={describeGamePhase(entry.game, entry.gameState)}
      players={entry.players}
      pendingPlayerIds={pendingActorIds(entry)}
      isMyTurn={isMyTurn(entry)}
      isFinished={finished}
      updatedAt={finished ? formatFinishedAt(updatedAt) : formatUpdatedAt(updatedAt)}
      summary={buildGameCardSummary(entry.game, entry.gameState, entry.players)}
      onOpen={onOpen}
    />
  )
}
