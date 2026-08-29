import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DiscordSignIn } from '../components/DiscordSignIn'
import { ErrorBanner } from '../components/ErrorBanner'
import { GameOverviewCard } from '../components/GameOverviewCard'
import { GuestSignIn } from '../components/GuestSignIn'
import { Pagination } from '../components/Pagination'
import { SupportBanner } from '../components/SupportBanner'
import { useAuth } from '../hooks/useAuth'
import { useDisplayName } from '../hooks/useDisplayName'
import { useIsAdmin } from '../hooks/useIsAdmin'
import { useRefetchOnVisible } from '../hooks/useRefetchOnVisible'
import { getGameByRoomCode, listAllRooms, listMyGames } from '../lib/gameApi'
import { buildGameCardSummary } from '../lib/gameCardView'
import { paginate } from '../lib/pagination'
import { consumePendingRedirect } from '../lib/pendingRedirect'
import { simpleError, toAppError, type AppError } from '../lib/errors'
import {
  describeGamePhase,
  formatUpdatedAt,
  groupMyGames,
  isMyTurn,
  latestUpdatedAt,
  myGameStatus,
  pendingActorIds,
  type MyGameEntry,
} from '../lib/myGamesView'
import {
  groupPublicRooms,
  isJoinable,
  isMyTurn as isMyTurnInPublicRoom,
  pendingActorIds as pendingActorIdsInPublicRoom,
  publicRoomBucket,
  type PublicRoomEntry,
} from '../lib/publicRoomsView'

const PAGE_SIZE = 10

/** Same routing rule as MyGamesPage.tsx's gamePath — no game_state row yet means the room is still in the lobby. */
function gamePath(entry: MyGameEntry): string {
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

  const [myEntries, setMyEntries] = useState<MyGameEntry[] | null>(null)
  // All rooms, public and private (issue #363) — a private room's
  // not-started/lobby state is filtered back out below, before rendering,
  // since only "Your games" or the room's own link should ever surface that.
  const [roomEntries, setRoomEntries] = useState<PublicRoomEntry[] | null>(null)
  const [loadError, setLoadError] = useState<AppError | null>(null)

  const [myGamesPage, setMyGamesPage] = useState(0)
  const [joinablePage, setJoinablePage] = useState(0)
  const [inProgressPage, setInProgressPage] = useState(0)
  const [finishedPage, setFinishedPage] = useState(0)
  const [publicFinishedPage, setPublicFinishedPage] = useState(0)

  useEffect(() => {
    if (!session) return
    const redirect = consumePendingRedirect()
    if (redirect) navigate(redirect, { replace: true })
  }, [session, navigate])

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setLoadError(null)
    Promise.all([listMyGames(session.user.id), listAllRooms()])
      .then(([myGames, rooms]) => {
        if (cancelled) return
        setMyEntries(myGames)
        setRoomEntries(rooms)
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
    Promise.all([listMyGames(session.user.id), listAllRooms()])
      .then(([myGames, rooms]) => {
        setMyEntries(myGames)
        setRoomEntries(rooms)
      })
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
          Sign in with Discord to create or join a game with your friends.
        </p>
        {error && <ErrorBanner message={error.message} details={error.details} onDismiss={() => setError(null)} />}
        <div className="flex flex-col items-center gap-3">
          <DiscordSignIn onError={setError} />
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

  const { active: myGamesInProgress, finished: myFinishedGames } = groupMyGames(myEntries ?? [])
  // In-progress/finished include both public and private rooms (issue #363:
  // private games stay listed for everyone once they're underway) — only
  // the notStarted bucket needs a visibility filter, since a private lobby
  // must never be discoverable/joinable from here, unlike its in-progress or
  // finished state.
  const { notStarted, inProgress: roomsInProgress, finished: roomsFinished } = groupPublicRooms(roomEntries ?? [])
  // "Latest" here means most-recently created — unlike the in-progress list
  // below, a fresh lobby's updated_at rarely differs from its created_at, but
  // created_at is the literal reading of "the latest 10 joinable games".
  const joinablePublic = notStarted
    .filter((entry) => entry.game.visibility === 'public')
    .filter(isJoinable)
    .sort((a, b) => new Date(b.game.created_at).getTime() - new Date(a.game.created_at).getTime())

  const myGamesPageItems = paginate(myGamesInProgress, myGamesPage, PAGE_SIZE)
  const joinablePageItems = paginate(joinablePublic, joinablePage, PAGE_SIZE)
  const inProgressPageItems = paginate(roomsInProgress, inProgressPage, PAGE_SIZE)
  const finishedPageItems = paginate(myFinishedGames, finishedPage, PAGE_SIZE)
  const publicFinishedPageItems = paginate(roomsFinished, publicFinishedPage, PAGE_SIZE)

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

      {myEntries === null && !loadError && <div className="text-neutral-400">Loading your games…</div>}

      {myEntries !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Your games in progress</h2>
          {myGamesInProgress.length === 0 ? (
            <p className="text-sm text-neutral-500">No games in progress.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {myGamesPageItems.map((entry) => (
                <MyGameRow key={entry.game.id} entry={entry} onOpen={() => navigate(gamePath(entry))} />
              ))}
            </ul>
          )}
          <Pagination page={myGamesPage} pageSize={PAGE_SIZE} total={myGamesInProgress.length} onChange={setMyGamesPage} />
        </section>
      )}

      {roomEntries !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Public games — joinable</h2>
          {joinablePublic.length === 0 ? (
            <p className="text-sm text-neutral-500">No joinable public games right now.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {joinablePageItems.map((entry) => (
                <RoomRow
                  key={entry.game.id}
                  entry={entry}
                  userId={session.user.id}
                  action="Join"
                  onOpen={() => navigate(`/lobby/${entry.game.room_code}`)}
                />
              ))}
            </ul>
          )}
          <Pagination page={joinablePage} pageSize={PAGE_SIZE} total={joinablePublic.length} onChange={setJoinablePage} />
        </section>
      )}

      {roomEntries !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Games in progress</h2>
          {roomsInProgress.length === 0 ? (
            <p className="text-sm text-neutral-500">No games in progress right now.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {inProgressPageItems.map((entry) => (
                <RoomRow
                  key={entry.game.id}
                  entry={entry}
                  userId={session.user.id}
                  action={entry.players.some((p) => p.user_id === session.user.id) ? undefined : 'Observe'}
                  onOpen={() => navigate(`/game/${entry.game.room_code}`)}
                />
              ))}
            </ul>
          )}
          <Pagination page={inProgressPage} pageSize={PAGE_SIZE} total={roomsInProgress.length} onChange={setInProgressPage} />
        </section>
      )}

      {myEntries !== null && myFinishedGames.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Your finished games</h2>
          <ul className="flex flex-col gap-2">
            {finishedPageItems.map((entry) => (
              <MyGameRow key={entry.game.id} entry={entry} onOpen={() => navigate(gamePath(entry))} />
            ))}
          </ul>
          <Pagination page={finishedPage} pageSize={PAGE_SIZE} total={myFinishedGames.length} onChange={setFinishedPage} />
        </section>
      )}

      {roomEntries !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Finished games</h2>
          {roomsFinished.length === 0 ? (
            <p className="text-sm text-neutral-500">No finished games yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {publicFinishedPageItems.map((entry) => (
                <RoomRow
                  key={entry.game.id}
                  entry={entry}
                  userId={session.user.id}
                  action="View"
                  onOpen={() => navigate(`/game/${entry.game.room_code}`)}
                />
              ))}
            </ul>
          )}
          <Pagination page={publicFinishedPage} pageSize={PAGE_SIZE} total={roomsFinished.length} onChange={setPublicFinishedPage} />
        </section>
      )}
    </div>
  )
}

function MyGameRow({ entry, onOpen }: { entry: MyGameEntry; onOpen: () => void }) {
  const status = myGameStatus(entry)

  return (
    <GameOverviewCard
      name={entry.game.name}
      phase={describeGamePhase(entry.game, entry.gameState)}
      players={entry.players}
      pendingPlayerIds={pendingActorIds(entry)}
      isMyTurn={isMyTurn(entry)}
      isFinished={status === 'completed'}
      updatedAt={formatUpdatedAt(latestUpdatedAt(entry.game, entry.gameStateUpdatedAt))}
      summary={buildGameCardSummary(entry.game, entry.gameState, entry.players)}
      onOpen={onOpen}
    />
  )
}

/** Renders a room from the mixed public+private list (issue #363) — notStarted entries are always public by the time they reach here (see joinablePublic's filter above), so only the in-progress/finished buckets ever need the "Private" tag. */
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
      pendingPlayerIds={pendingActorIdsInPublicRoom(entry)}
      isMyTurn={isMyTurnInPublicRoom(entry, userId)}
      isFinished={bucket === 'finished'}
      isJoinable={isJoinable(entry)}
      updatedAt={formatUpdatedAt(latestUpdatedAt(entry.game, entry.gameStateUpdatedAt))}
      action={action}
      summary={buildGameCardSummary(entry.game, entry.gameState, entry.players)}
      onOpen={onOpen}
    />
  )
}
