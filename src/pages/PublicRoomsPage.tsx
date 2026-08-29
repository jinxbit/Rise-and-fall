import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { GameOverviewCard } from '../components/GameOverviewCard'
import { useAuth } from '../hooks/useAuth'
import { useRefetchOnVisible } from '../hooks/useRefetchOnVisible'
import { listPublicRooms } from '../lib/gameApi'
import { buildGameCardSummary, describeGamePhase, formatFinishedAt, formatUpdatedAt, latestUpdatedAt } from '../lib/gameCardView'
import { toAppError, type AppError } from '../lib/errors'
import {
  groupPublicRooms,
  isJoinable,
  isMyTurn,
  orderInProgressForUser,
  orderNotStartedForUser,
  pendingActorIds,
  publicRoomBucket,
  type PublicRoomEntry,
} from '../lib/publicRoomsView'

/**
 * The Public Rooms discovery screen (issue #40 section 5): every room whose
 * Owner opted into 'public' visibility, grouped into the three buckets the
 * spec lists — joinable (Active-Not Started), observable (Active-In
 * Progress), and read-only history (Finished). Canceled/deleted rooms never
 * appear here (listPublicRooms already excludes them).
 */
export function PublicRoomsPage() {
  const { session, loading: authLoading } = useAuth()
  const navigate = useNavigate()

  const [entries, setEntries] = useState<PublicRoomEntry[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setEntries(null)
    setError(null)
    listPublicRooms()
      .then((result) => {
        if (!cancelled) setEntries(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toAppError(err, 'Failed to load public rooms'))
      })
    return () => {
      cancelled = true
    }
  }, [session])

  useRefetchOnVisible(() => {
    if (!session) return
    listPublicRooms()
      .then(setEntries)
      .catch((err: unknown) => setError(toAppError(err, 'Failed to load public rooms')))
  })

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>
  if (!session) {
    return (
      <div className="p-8 text-neutral-400">
        <Link to="/" className="underline hover:text-neutral-200">
          Sign in
        </Link>{' '}
        to browse public rooms.
      </div>
    )
  }

  const { notStarted, inProgress, finished } = groupPublicRooms(entries ?? [])
  // Section 2: the viewer's own rooms first. Section 1/3: whichever rooms
  // need the viewer's input first, oldest-waiting first, then the rest.
  const notStartedOrdered = orderNotStartedForUser(notStarted, session.user.id)
  const inProgressOrdered = orderInProgressForUser(inProgress, session.user.id)

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Public rooms</h1>
        <Link to="/" className="text-sm underline hover:text-neutral-200">
          Home
        </Link>
      </header>

      {error && <ErrorBanner message={error.message} details={error.details} onDismiss={() => setError(null)} />}

      {entries === null && !error && <div className="text-neutral-400">Loading…</div>}

      {entries !== null && entries.length === 0 && (
        <div className="text-neutral-400">No public rooms right now.</div>
      )}

      {notStartedOrdered.length > 0 && (
        <RoomSection
          title="Joinable"
          entries={notStartedOrdered}
          userId={session.user.id}
          onOpen={(entry) => navigate(`/lobby/${entry.game.room_code}`)}
          renderAction={(entry) => (isJoinable(entry) ? 'Join' : 'Full')}
        />
      )}

      {inProgressOrdered.length > 0 && (
        <RoomSection
          title="In progress"
          entries={inProgressOrdered}
          userId={session.user.id}
          onOpen={(entry) => navigate(`/game/${entry.game.room_code}`)}
          renderAction={(entry) =>
            entry.players.some((p) => p.user_id === session.user.id) ? undefined : 'Observe'
          }
        />
      )}

      {finished.length > 0 && (
        <RoomSection
          title="Finished"
          entries={finished}
          userId={session.user.id}
          onOpen={(entry) => navigate(`/game/${entry.game.room_code}`)}
          renderAction={() => 'View'}
        />
      )}
    </div>
  )
}

function RoomSection({
  title,
  entries,
  userId,
  onOpen,
  renderAction,
}: {
  title: string
  entries: PublicRoomEntry[]
  userId: string
  onOpen: (entry: PublicRoomEntry) => void
  renderAction: (entry: PublicRoomEntry) => string | undefined
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium text-neutral-200">{title}</h2>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => {
          const finished = publicRoomBucket(entry) === 'finished'
          const updatedAt = latestUpdatedAt(entry.game, entry.gameStateUpdatedAt)
          return (
            <GameOverviewCard
              key={entry.game.id}
              name={entry.game.name}
              description={publicRoomBucket(entry) === 'notStarted' ? `${entry.players.length}/${entry.game.max_players} players` : undefined}
              phase={describeGamePhase(entry.game, entry.gameState)}
              players={entry.players}
              pendingPlayerIds={pendingActorIds(entry)}
              isMyTurn={isMyTurn(entry, userId)}
              isFinished={finished}
              isJoinable={isJoinable(entry)}
              updatedAt={finished ? formatFinishedAt(updatedAt) : formatUpdatedAt(updatedAt)}
              action={renderAction(entry)}
              summary={buildGameCardSummary(entry.game, entry.gameState, entry.players)}
              onOpen={() => onOpen(entry)}
            />
          )
        })}
      </ul>
    </section>
  )
}
