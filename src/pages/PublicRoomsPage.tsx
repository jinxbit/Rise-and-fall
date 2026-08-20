import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { GameOverviewCard } from '../components/GameOverviewCard'
import { useAuth } from '../hooks/useAuth'
import { listPublicRooms } from '../lib/gameApi'
import { formatUpdatedAt } from '../lib/gameCardView'
import {
  groupPublicRooms,
  isJoinable,
  isMyTurn,
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
  const [error, setError] = useState<string | null>(null)

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
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load public rooms')
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
        to browse public rooms.
      </div>
    )
  }

  const { notStarted, inProgress, finished } = groupPublicRooms(entries ?? [])

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Public rooms</h1>
        <Link to="/" className="text-sm underline hover:text-neutral-200">
          Home
        </Link>
      </header>

      {error && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}

      {entries === null && !error && <div className="text-neutral-400">Loading…</div>}

      {entries !== null && entries.length === 0 && (
        <div className="text-neutral-400">No public rooms right now.</div>
      )}

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
          renderAction={(entry) =>
            entry.players.some((p) => p.user_id === session.user.id) ? 'Continue' : 'Observe'
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
  renderAction: (entry: PublicRoomEntry) => string
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium text-neutral-200">{title}</h2>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <GameOverviewCard
            key={entry.game.id}
            name={entry.game.name}
            roomCode={entry.game.room_code}
            description={`${entry.game.play_mode} · ${entry.players.length}/${entry.game.max_players} players`}
            players={entry.players}
            pendingPlayerIds={pendingActorIds(entry)}
            isMyTurn={isMyTurn(entry, userId)}
            isFinished={publicRoomBucket(entry) === 'finished'}
            updatedAt={formatUpdatedAt(entry.game.updated_at)}
            action={renderAction(entry)}
            onOpen={() => onOpen(entry)}
          />
        ))}
      </ul>
    </section>
  )
}
