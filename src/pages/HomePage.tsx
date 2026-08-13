import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DiscordSignIn } from '../components/DiscordSignIn'
import { DiscordWebhookSettings } from '../components/DiscordWebhookSettings'
import { GameLengthSelector } from '../components/GameLengthSelector'
import { GuestSignIn } from '../components/GuestSignIn'
import { MapTemplateSelector } from '../components/MapTemplateSelector'
import { PlayModeSelector } from '../components/PlayModeSelector'
import { TaleSelector } from '../components/TaleSelector'
import { useAuth } from '../hooks/useAuth'
import { createGame, getGameByRoomCode } from '../lib/gameApi'
import { signOut } from '../lib/auth'
import type { PlayMode } from '../engine/types'

export function HomePage() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()

  const [playMode, setPlayMode] = useState<PlayMode>('live')
  const [mapTemplateId, setMapTemplateId] = useState<string | null>(null)
  const [skipHotseatPassGate, setSkipHotseatPassGate] = useState(false)
  const [activeTaleIds, setActiveTaleIds] = useState<string[]>([])
  const [gameLength, setGameLength] = useState(4)
  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (loading) {
    return <div className="p-8 text-neutral-400">Loading…</div>
  }

  if (!session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-3xl font-semibold">Rise &amp; Fall</h1>
        <p className="max-w-sm text-neutral-400">
          Sign in with Discord to create or join a game with your friends.
        </p>
        {error && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}
        <div className="flex flex-col items-center gap-3">
          <DiscordSignIn onError={setError} />
          {import.meta.env.VITE_ALLOW_GUEST_AUTH === 'true' && <GuestSignIn onError={setError} />}
        </div>
      </div>
    )
  }

  const user = session.user
  const displayName =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    user.email ??
    'Player'
  const avatarUrl = (user.user_metadata?.avatar_url as string | undefined) ?? null

  async function handleCreate() {
    setError(null)
    setBusy(true)
    try {
      const { game } = await createGame({
        playMode,
        userId: user.id,
        displayName,
        avatarUrl,
        mapTemplateId,
        skipHotseatPassGate,
        activeTaleIds,
        gameLength,
      })
      navigate(`/lobby/${game.room_code}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create game')
    } finally {
      setBusy(false)
    }
  }

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

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Rise &amp; Fall</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          {avatarUrl && <img src={avatarUrl} alt="" className="h-8 w-8 rounded-full" />}
          <span>{displayName}</span>
          <Link to="/games" className="underline hover:text-neutral-200">
            My games
          </Link>
          <button onClick={() => void signOut()} className="underline hover:text-neutral-200">
            Sign out
          </button>
        </div>
      </header>

      {error && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}

      <DiscordWebhookSettings userId={user.id} />

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-neutral-200">Create a game</h2>
        <PlayModeSelector value={playMode} onChange={setPlayMode} />
        {playMode === 'hotseat' && (
          <label className="flex items-center gap-2 text-sm text-neutral-400">
            <input
              type="checkbox"
              checked={skipHotseatPassGate}
              onChange={(e) => setSkipHotseatPassGate(e.target.checked)}
              className="h-4 w-4 rounded border-neutral-700 bg-neutral-900"
            />
            Don&apos;t show a &quot;pass the device&quot; message every turn
          </label>
        )}
        <h3 className="text-sm font-medium text-neutral-400">Game length</h3>
        <GameLengthSelector value={gameLength} onChange={setGameLength} />
        <h3 className="text-sm font-medium text-neutral-400">Map</h3>
        <MapTemplateSelector value={mapTemplateId} onChange={setMapTemplateId} />
        <h3 className="text-sm font-medium text-neutral-400">Tales (variant)</h3>
        <TaleSelector value={activeTaleIds} onChange={setActiveTaleIds} />
        <button
          disabled={busy}
          onClick={() => void handleCreate()}
          className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Create game
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-neutral-200">Join a game</h2>
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
    </div>
  )
}
