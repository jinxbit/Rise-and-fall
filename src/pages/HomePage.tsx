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
import { getGameByRoomCode, listMyGames, listPublicRooms } from '../lib/gameApi'
import { signOut } from '../lib/auth'
import { paginate } from '../lib/pagination'
import {
  formatUpdatedAt,
  groupMyGames,
  isMyTurn,
  myGameStatus,
  pendingActorIds,
  type MyGameEntry,
  type MyGameStatus,
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

const STATUS_LABEL: Record<MyGameStatus, string> = {
  lobby: 'Waiting in lobby',
  boardSetup: 'Setting up board',
  active: 'In progress',
  completed: 'Finished',
  canceled: 'Canceled',
}

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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [myEntries, setMyEntries] = useState<MyGameEntry[] | null>(null)
  const [publicEntries, setPublicEntries] = useState<PublicRoomEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [myGamesPage, setMyGamesPage] = useState(0)
  const [joinablePage, setJoinablePage] = useState(0)
  const [inProgressPage, setInProgressPage] = useState(0)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    setLoadError(null)
    Promise.all([listMyGames(session.user.id), listPublicRooms()])
      .then(([myGames, publicRooms]) => {
        if (cancelled) return
        setMyEntries(myGames)
        setPublicEntries(publicRooms)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load games')
      })
    return () => {
      cancelled = true
    }
  }, [session])

  if (loading) {
    return <div className="p-8 text-neutral-400">Loading…</div>
  }

  if (!session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <SupportBanner />
        <h1 className="text-3xl font-semibold">Rise &amp; Fall</h1>
        <p className="max-w-sm text-neutral-400">
          Sign in with Discord to create or join a game with your friends.
        </p>
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
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
        setError('No game found with that room code.')
        return
      }
      navigate(`/lobby/${game.room_code}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join game')
    } finally {
      setBusy(false)
    }
  }

  const { active: myGamesInProgress } = groupMyGames(myEntries ?? [])
  const { notStarted, inProgress: publicInProgress } = groupPublicRooms(publicEntries ?? [])
  // "Latest" here means most-recently created — unlike the in-progress list
  // below, a fresh lobby's updated_at rarely differs from its created_at, but
  // created_at is the literal reading of "the latest 10 joinable games".
  const joinablePublic = notStarted
    .filter(isJoinable)
    .sort((a, b) => new Date(b.game.created_at).getTime() - new Date(a.game.created_at).getTime())

  const myGamesPageItems = paginate(myGamesInProgress, myGamesPage, PAGE_SIZE)
  const joinablePageItems = paginate(joinablePublic, joinablePage, PAGE_SIZE)
  const inProgressPageItems = paginate(publicInProgress, inProgressPage, PAGE_SIZE)

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-8">
      <SupportBanner />
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Rise &amp; Fall</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          {avatarUrl && <img src={avatarUrl} alt="" className="h-8 w-8 rounded-full" />}
          <span>{displayName}</span>
          <Link to="/profile" className="underline hover:text-neutral-200">
            Profile
          </Link>
          <Link to="/games" className="underline hover:text-neutral-200">
            My games
          </Link>
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
          <button onClick={() => void signOut()} className="underline hover:text-neutral-200">
            Sign out
          </button>
        </div>
      </header>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {loadError && <ErrorBanner message={loadError} onDismiss={() => setLoadError(null)} />}

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

      {publicEntries !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Public games — joinable</h2>
          {joinablePublic.length === 0 ? (
            <p className="text-sm text-neutral-500">No joinable public games right now.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {joinablePageItems.map((entry) => (
                <PublicGameRow
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

      {publicEntries !== null && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-neutral-200">Public games — in progress</h2>
          {publicInProgress.length === 0 ? (
            <p className="text-sm text-neutral-500">No public games in progress right now.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {inProgressPageItems.map((entry) => (
                <PublicGameRow
                  key={entry.game.id}
                  entry={entry}
                  userId={session.user.id}
                  action={entry.players.some((p) => p.user_id === session.user.id) ? 'Continue' : 'Observe'}
                  onOpen={() => navigate(`/game/${entry.game.room_code}`)}
                />
              ))}
            </ul>
          )}
          <Pagination page={inProgressPage} pageSize={PAGE_SIZE} total={publicInProgress.length} onChange={setInProgressPage} />
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
      roomCode={entry.game.room_code}
      description={STATUS_LABEL[status]}
      players={entry.players}
      pendingPlayerIds={pendingActorIds(entry)}
      isMyTurn={isMyTurn(entry)}
      isFinished={status === 'completed'}
      updatedAt={formatUpdatedAt(entry.game.updated_at)}
      onOpen={onOpen}
    />
  )
}

function PublicGameRow({
  entry,
  userId,
  action,
  onOpen,
}: {
  entry: PublicRoomEntry
  userId: string
  action: string
  onOpen: () => void
}) {
  return (
    <GameOverviewCard
      name={entry.game.name}
      roomCode={entry.game.room_code}
      description={`${entry.game.play_mode} · ${entry.players.length}/${entry.game.max_players} players`}
      players={entry.players}
      pendingPlayerIds={pendingActorIdsInPublicRoom(entry)}
      isMyTurn={isMyTurnInPublicRoom(entry, userId)}
      isFinished={publicRoomBucket(entry) === 'finished'}
      updatedAt={formatUpdatedAt(entry.game.updated_at)}
      action={action}
      onOpen={onOpen}
    />
  )
}
