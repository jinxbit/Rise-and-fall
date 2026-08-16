import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { GameLengthSelector } from '../components/GameLengthSelector'
import { MapTemplateSelector } from '../components/MapTemplateSelector'
import { PlayModeSelector } from '../components/PlayModeSelector'
import { TaleSelector } from '../components/TaleSelector'
import { useAuth } from '../hooks/useAuth'
import { useDisplayName } from '../hooks/useDisplayName'
import { createGame, MAX_PLAYERS } from '../lib/gameApi'
import { randomRoomName } from '../lib/randomRoomName'
import type { PlayMode } from '../engine/types'

export function CreateGamePage() {
  const { session, loading } = useAuth()
  const { displayName, loading: displayNameLoading } = useDisplayName(session?.user ?? null)
  const navigate = useNavigate()

  const [name, setName] = useState(() => randomRoomName())
  const [playMode, setPlayMode] = useState<PlayMode>('async')
  const [mapTemplateId, setMapTemplateId] = useState<string | null>(null)
  const [skipHotseatPassGate, setSkipHotseatPassGate] = useState(true)
  const [activeTaleIds, setActiveTaleIds] = useState<string[]>([])
  const [gameLength, setGameLength] = useState(4)
  const [minPlayersInput, setMinPlayersInput] = useState('2')
  const [maxPlayersInput, setMaxPlayersInput] = useState('8')
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const minPlayers = Number(minPlayersInput)
  const maxPlayers = Number(maxPlayersInput)
  const minPlayersValid = /^\d+$/.test(minPlayersInput.trim()) && minPlayers >= 1
  const maxPlayersValid = /^\d+$/.test(maxPlayersInput.trim()) && maxPlayers >= 1 && maxPlayers <= MAX_PLAYERS
  const playerCountValid = minPlayersValid && maxPlayersValid && maxPlayers >= minPlayers
  const playerCountError = !minPlayersValid
    ? `Min players must be a whole number of at least 1.`
    : !maxPlayersValid
      ? `Max players must be a whole number between 1 and ${MAX_PLAYERS}.`
      : maxPlayers < minPlayers
        ? `Max players can't be lower than min players.`
        : null

  if (loading) {
    return <div className="p-8 text-neutral-400">Loading…</div>
  }

  if (!session) {
    return (
      <div className="p-8 text-neutral-400">
        <Link to="/" className="underline hover:text-neutral-200">
          Sign in
        </Link>{' '}
        to create a game.
      </div>
    )
  }

  const user = session.user
  const avatarUrl = (user.user_metadata?.avatar_url as string | undefined) ?? null

  async function handleCreate() {
    setError(null)
    setBusy(true)
    try {
      const { game } = await createGame({
        name,
        playMode,
        userId: user.id,
        displayName,
        avatarUrl,
        mapTemplateId,
        skipHotseatPassGate,
        activeTaleIds,
        gameLength,
        minPlayers,
        maxPlayers,
        visibility,
      })
      navigate(`/lobby/${game.room_code}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create game')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Create a game</h1>
        <Link to="/" className="text-sm underline hover:text-neutral-200">
          Home
        </Link>
      </header>

      {error && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}

      <section className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm text-neutral-400">
          Room name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Friday night showdown"
            maxLength={60}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
          />
        </label>
        <p className="text-xs text-neutral-500">Choose carefully — the room name can&apos;t be changed later.</p>
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
        <h3 className="text-sm font-medium text-neutral-400">Players</h3>
        <div className="flex gap-4">
          <label className="flex flex-col gap-1 text-sm text-neutral-400">
            Min players
            <input
              type="number"
              inputMode="numeric"
              value={minPlayersInput}
              onChange={(e) => setMinPlayersInput(e.target.value)}
              className={`w-14 rounded-md border bg-neutral-900 px-3 py-2 text-center text-neutral-100 ${
                minPlayersValid ? 'border-neutral-700' : 'border-red-500'
              }`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-neutral-400">
            Max players
            <input
              type="number"
              inputMode="numeric"
              value={maxPlayersInput}
              onChange={(e) => setMaxPlayersInput(e.target.value)}
              className={`w-14 rounded-md border bg-neutral-900 px-3 py-2 text-center text-neutral-100 ${
                maxPlayersValid && maxPlayers >= minPlayers ? 'border-neutral-700' : 'border-red-500'
              }`}
            />
          </label>
        </div>
        {playerCountError && <p className="text-sm text-red-400">{playerCountError}</p>}
        <h3 className="text-sm font-medium text-neutral-400">Variants</h3>
        <div className="flex flex-col gap-3 rounded-md border border-neutral-800 p-3">
          <MapTemplateSelector value={mapTemplateId} onChange={setMapTemplateId} />
          <details>
            <summary className="cursor-pointer text-sm font-medium text-neutral-400">Tales</summary>
            <div className="mt-3">
              <TaleSelector value={activeTaleIds} onChange={setActiveTaleIds} />
            </div>
          </details>
        </div>
        <label className="flex items-center gap-2 text-sm text-neutral-400">
          <input
            type="checkbox"
            checked={visibility === 'public'}
            onChange={(e) => setVisibility(e.target.checked ? 'public' : 'private')}
            className="h-4 w-4 rounded border-neutral-700 bg-neutral-900"
          />
          List this room on the Public rooms screen
        </label>
        <button
          disabled={busy || displayNameLoading || name.trim().length === 0 || !playerCountValid}
          onClick={() => void handleCreate()}
          className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {displayNameLoading ? 'Loading…' : 'Create game'}
        </button>
      </section>
    </div>
  )
}
