import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { GameOverviewCard } from '../components/GameOverviewCard'
import { useAuth } from '../hooks/useAuth'
import { useIsAdmin } from '../hooks/useIsAdmin'
import { useRefetchOnVisible } from '../hooks/useRefetchOnVisible'
import { listAllRooms } from '../lib/gameApi'
import { buildGameCardSummary, describeGamePhase, formatUpdatedAt, latestUpdatedAt } from '../lib/gameCardView'
import { toAppError, type AppError } from '../lib/errors'
import {
  groupPublicRooms,
  isJoinable,
  isMyTurn,
  pendingActorIds,
  publicRoomBucket,
  type PublicRoomEntry,
} from '../lib/publicRoomsView'

/**
 * Admin "all rooms" screen (issue #361) — same three-bucket layout as
 * PublicRoomsPage.tsx, but sourced from listAllRooms() so private rooms
 * show up too, with a visibility tag since that's otherwise invisible here.
 * Gated by useIsAdmin the same way AdminMapsPage.tsx is; listAllRooms()'s
 * own doc comment explains this isn't an RLS boundary, just a UI one.
 */
export function AdminRoomsPage() {
  const { session, loading: authLoading } = useAuth()
  const isAdmin = useIsAdmin(session?.user ?? null)
  const navigate = useNavigate()

  const [entries, setEntries] = useState<PublicRoomEntry[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    setEntries(null)
    setError(null)
    listAllRooms()
      .then((result) => {
        if (!cancelled) setEntries(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toAppError(err, 'Failed to load rooms'))
      })
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  useRefetchOnVisible(() => {
    if (!isAdmin) return
    listAllRooms()
      .then(setEntries)
      .catch((err: unknown) => setError(toAppError(err, 'Failed to load rooms')))
  })

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>

  if (!session || !isAdmin) {
    return (
      <div className="p-8 text-neutral-400">
        <Link to="/" className="underline hover:text-neutral-200">
          Home
        </Link>
        {!session ? ' — sign in as an admin to view all rooms.' : ' — you do not have access to this page.'}
      </div>
    )
  }

  const { notStarted, inProgress, finished } = groupPublicRooms(entries ?? [])

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">All rooms</h1>
        <Link to="/" className="text-sm underline hover:text-neutral-200">
          Home
        </Link>
      </header>

      {error && <ErrorBanner message={error.message} details={error.details} onDismiss={() => setError(null)} />}

      {entries === null && !error && <div className="text-neutral-400">Loading…</div>}

      {entries !== null && entries.length === 0 && <div className="text-neutral-400">No rooms right now.</div>}

      {notStarted.length > 0 && (
        <RoomSection
          title="Joinable"
          entries={notStarted}
          userId={session.user.id}
          onOpen={(entry) => navigate(`/lobby/${entry.game.room_code}`)}
          renderAction={(entry) => (isJoinable(entry) ? 'Join' : 'Full')}
        />
      )}

      {inProgress.length > 0 && (
        <RoomSection
          title="In progress"
          entries={inProgress}
          userId={session.user.id}
          onOpen={(entry) => navigate(`/game/${entry.game.room_code}`)}
          renderAction={() => 'Observe'}
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
        {entries.map((entry) => (
          <GameOverviewCard
            key={entry.game.id}
            name={entry.game.name}
            description={
              publicRoomBucket(entry) === 'notStarted'
                ? `${entry.players.length}/${entry.game.max_players} players · ${entry.game.visibility}`
                : entry.game.visibility
            }
            phase={describeGamePhase(entry.game, entry.gameState)}
            players={entry.players}
            pendingPlayerIds={pendingActorIds(entry)}
            isMyTurn={isMyTurn(entry, userId)}
            isFinished={publicRoomBucket(entry) === 'finished'}
            isJoinable={isJoinable(entry)}
            updatedAt={formatUpdatedAt(latestUpdatedAt(entry.game, entry.gameStateUpdatedAt))}
            action={renderAction(entry)}
            summary={buildGameCardSummary(entry.game, entry.gameState, entry.players)}
            onOpen={() => onOpen(entry)}
          />
        ))}
      </ul>
    </section>
  )
}
