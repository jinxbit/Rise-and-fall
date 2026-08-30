import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DiscordSignIn } from '../components/DiscordSignIn'
import { ErrorBanner } from '../components/ErrorBanner'
import { GameOverviewCard } from '../components/GameOverviewCard'
import { GoogleSignIn } from '../components/GoogleSignIn'
import { GuestSignIn } from '../components/GuestSignIn'
import { Pagination } from '../components/Pagination'
import { SupportBanner } from '../components/SupportBanner'
import { useAuth } from '../hooks/useAuth'
import { useDisplayName } from '../hooks/useDisplayName'
import { useIsAdmin } from '../hooks/useIsAdmin'
import { useRefetchOnVisible } from '../hooks/useRefetchOnVisible'
import { getGameByRoomCode, listAllRooms } from '../lib/gameApi'
import { buildGameCardSummary, describeGamePhase, formatFinishedAt, formatUpdatedAt, latestUpdatedAt } from '../lib/gameCardView'
import { paginate } from '../lib/pagination'
import { consumePendingRedirect } from '../lib/pendingRedirect'
import { simpleError, toAppError, type AppError } from '../lib/errors'
import {
  groupPublicRooms,
  isJoinable,
  isMine,
  isMyTurn,
  orderInProgressForUser,
  orderNotStartedForUser,
  pendingActorIds,
  publicRoomBucket,
  type PublicRoomEntry,
} from '../lib/publicRoomsView'

const PAGE_SIZE = 10

function gamePath(entry: PublicRoomEntry): string {
  return entry.gameState === null ? `/lobby/${entry.game.room_code}` : `/game/${entry.game.room_code}`
}

export function HomePage() {
  const { session, loading } = useAuth()
  const { displayName } = useDisplayName(session?.user ?? null)
  const isAdmin = useIsAdmin(session?.user ?? null)
  const navigate = useNavigate()

  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [error, setError] = useState<AppError | null>(null)
  const [busy, setBusy] = useState(false)

  // All rooms, public and private (issue #363) — a private room's
  // not-started/lobby state is filtered back out below, before rendering,
  // since only the room's owner/players or the room's own link should ever
  // surface that.
  const [roomEntries, setRoomEntries] = useState<PublicRoomEntry[] | null>(null)
  const [loadError, setLoadError] = useState<AppError | null>(null)

  const [myGamesPage, setMyGamesPage] = useState(0)
  const [notStartedPage, setNotStartedPage] = useState(0)
  const [inProgressPage, setInProgressPage] = useState(0)
  const [finishedPage, setFinishedPage] = useState(0)

  useEffect(() => {
    if (!session) return
    const redirect = consumePendingRedirect()
    if (redirect) navigate(redirect, { replace: true })
  }, [session, navigate])

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setLoadError(null)
    listAllRooms()
      .then((rooms) => {
        if (!cancelled) setRoomEntries(rooms)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(toAppError(err, 'Failed to load games'))
      })
    return () => {
      cancelled = true
    }
  }, [session])

  useRefetchOnVisible(() => {
    if (!session) return
    listAllRooms()
      .then(setRoomEntries)
      .catch((err: unknown) => setLoadError(toAppError(err, 'Failed to load games')))
  })

  if (loading) {
    return <div className="p-8 text-neutral-400">Loading…</div>
  }

  if (!session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-3xl font-semibold">Rise &amp; Fall</h1>
        <SupportBanner />
        <p className="max-w-sm text-neutral-400">
          Sign in with Discord or Google to create or join a game with your friends.
        </p>
        {error && <ErrorBanner message={error.message} details={error.details} onDismiss={() => setError(null)} />}
        <div className="flex flex-col items-center gap-3">
          <DiscordSignIn onError={setError} />
          <GoogleSignIn onError={setError} />
          {import.meta.env.VITE_ALLOW_GUEST_AUTH === 'true' && <GuestSignIn onError={setError} />}
        </div>
      </div>
    )
  }

  const user = session.user
  const avatarUrl = (user.user_metadata?.avatar_url as string | undefined) ?? null

  async function handleJoin() {
    setError(null)
    setBusy(true)
    try {
      const game = await getGameByRoomCode(roomCodeInput.trim())
      if (!game) {
        setError(simpleError('No game found with that room code.'))
        return
      }
      navigate(`/lobby/${game.room_code}`)
    } catch (err) {
      setError(toAppError(err, 'Failed to join game'))
    } finally {
      setBusy(false)
    }
  }

  // The four groups from issue #364, in priority order:
  //  1. My in-progress games — needing my input first (longest-waiting
  //     first), then the rest most-recently-updated first.
  //  2. Rooms not started — mine first, then other public joinable rooms.
  //  3. In-progress games I'm not seated in.
  //  4. Finished games.
  const { notStarted, inProgress, finished } = groupPublicRooms(roomEntries ?? [])
  const myGamesInProgress = orderInProgressForUser(
    inProgress.filter((entry) => isMine(entry, user.id)),
    user.id,
  )
  const otherGamesInProgress = inProgress.filter((entry) => !isMine(entry, user.id))
  const notStartedRooms = orderNotStartedForUser(
    notStarted.filter((entry) => isMine(entry, user.id) || (entry.game.visibility === 'public' && isJoinable(entry))),
    user.id,
  )

  const myGamesPageItems = paginate(myGamesInProgress, myGamesPage, PAGE_SIZE)
  const notStartedPageItems = paginate(notStartedRooms, notStartedPage, PAGE_SIZE)
  const inProgressPageItems = paginate(otherGamesInProgress, inProgressPage, PAGE_SIZE)
  const finishedPageItems = paginate(finished, finishedPage, PAGE_SIZE)

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Rise &amp; Fall</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          {isAdmin && (
            <Link to="/admin/rooms" className="underline hover:text-neutral-200">
              All rooms
            </Link>
          )}
          <Link to="/public" className="underline hover:text-neutral-200">
            Public rooms
          </Link>
          <Link to="/map-builder" className="underline hover:text-neutral-200">
            Map builder
          </Link>
          {isAdmin && (
            <Link to="/admin/maps" className="underline hover:text-neutral-200">
              Saved maps
            </Link>
          )}
          <Link to="/profile" className="flex flex-col items-center gap-1 hover:text-neutral-200">
            {avatarUrl && <img src={avatarUrl} alt="" className="h-8 w-8 rounded-full" />}
            <span>{displayName}</span>
          </Link>
        </div>
      </header>

      <SupportBanner />

      {error && <ErrorBanner message={error.message} details={error.details} onDismiss={() => setError(null)} />}
      {loadError && <ErrorBanner message={loadError.message} details={loadError.details} onDismiss={() => setLoadError(null)} />}

      <section className="flex flex-col gap-3">
        <Link
          to="/create"
          className="rounded-md bg-indigo-600 px-4 py-2 text-center font-medium text-white hover:bg-indigo-500"
        >
          Create a game
        </Link>
        <div className="flex gap-2">
          <input
            value={roomCodeInput}
            onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
            placeholder="Room code"
            maxLength={5}
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 uppercase tracking-widest"
          />
          <button
            disabled={busy || roomCodeInput.trim().length === 0}
            onClick={() => void handleJoin()}
            className="rounded-md border border-neutral-700 px-4 py-2 font-medium hover:border-neutral-500 disabled:opacity-50"
          >
            Join
          </button>
        </div>
      </section>

      {roomEntries === null && !loadError && <div className="text-neutral-400">Loading your games…</div>}

      {roomEntries !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Your games in progress</h2>
          {myGamesInProgress.length === 0 ? (
            <p className="text-sm text-neutral-500">No games in progress.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {myGamesPageItems.map((entry) => (
                <RoomRow key={entry.game.id} entry={entry} userId={user.id} onOpen={() => navigate(gamePath(entry))} />
              ))}
            </ul>
          )}
          <Pagination page={myGamesPage} pageSize={PAGE_SIZE} total={myGamesInProgress.length} onChange={setMyGamesPage} />
        </section>
      )}

      {roomEntries !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Rooms not started</h2>
          {notStartedRooms.length === 0 ? (
            <p className="text-sm text-neutral-500">No rooms waiting to start right now.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {notStartedPageItems.map((entry) => (
                <RoomRow
                  key={entry.game.id}
                  entry={entry}
                  userId={user.id}
                  action={isMine(entry, user.id) ? undefined : 'Join'}
                  onOpen={() => navigate(`/lobby/${entry.game.room_code}`)}
                />
              ))}
            </ul>
          )}
          <Pagination page={notStartedPage} pageSize={PAGE_SIZE} total={notStartedRooms.length} onChange={setNotStartedPage} />
        </section>
      )}

      {roomEntries !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Games in progress</h2>
          {otherGamesInProgress.length === 0 ? (
            <p className="text-sm text-neutral-500">No games in progress right now.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {inProgressPageItems.map((entry) => (
                <RoomRow key={entry.game.id} entry={entry} userId={user.id} action="Observe" onOpen={() => navigate(`/game/${entry.game.room_code}`)} />
              ))}
            </ul>
          )}
          <Pagination page={inProgressPage} pageSize={PAGE_SIZE} total={otherGamesInProgress.length} onChange={setInProgressPage} />
        </section>
      )}

      {roomEntries !== null && finished.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Finished games</h2>
          <ul className="flex flex-col gap-2">
            {finishedPageItems.map((entry) => (
              <RoomRow key={entry.game.id} entry={entry} userId={user.id} action="View" onOpen={() => navigate(`/game/${entry.game.room_code}`)} />
            ))}
          </ul>
          <Pagination page={finishedPage} pageSize={PAGE_SIZE} total={finished.length} onChange={setFinishedPage} />
        </section>
      )}
    </div>
  )
}

/** Renders a room from the mixed public+private list (issue #363) — notStartedRooms is filtered to public-or-mine before it gets here, so only the in-progress/finished buckets ever need the "Private" tag. */
function RoomRow({
  entry,
  userId,
  action,
  onOpen,
}: {
  entry: PublicRoomEntry
  userId: string
  action?: string
  onOpen: () => void
}) {
  const bucket = publicRoomBucket(entry)
  const finished = bucket === 'finished'
  const updatedAt = latestUpdatedAt(entry.game, entry.gameStateUpdatedAt)
  const description =
    bucket === 'notStarted'
      ? `${entry.players.length}/${entry.game.max_players} players`
      : entry.game.visibility === 'private'
        ? 'Private'
        : undefined
  return (
    <GameOverviewCard
      name={entry.game.name}
      description={description}
      phase={describeGamePhase(entry.game, entry.gameState)}
      players={entry.players}
      pendingPlayerIds={pendingActorIds(entry)}
      isMyTurn={isMyTurn(entry, userId)}
      isFinished={finished}
      isJoinable={isJoinable(entry)}
      updatedAt={finished ? formatFinishedAt(updatedAt) : formatUpdatedAt(updatedAt)}
      action={action}
      summary={buildGameCardSummary(entry.game, entry.gameState, entry.players)}
      onOpen={onOpen}
    />
  )
}
