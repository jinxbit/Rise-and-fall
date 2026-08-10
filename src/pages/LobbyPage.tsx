import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { listMapTemplates } from '../content/resolveContent'
import { buildGenesisState } from '../lib/gameGenesis'
import {
  addLocalPlayer,
  getGameByRoomCode,
  getGameState,
  insertGameState,
  joinGame,
  listPlayers,
  removePlayer,
  setGameStatus,
  subscribeToGame,
  subscribeToPlayers,
} from '../lib/gameApi'
import type { GameRow, PlayerRow } from '../lib/dbTypes'

export function LobbyPage() {
  const { roomCode } = useParams<{ roomCode: string }>()
  const { session, loading: authLoading } = useAuth()
  const navigate = useNavigate()

  const [game, setGame] = useState<GameRow | null>(null)
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newPlayerName, setNewPlayerName] = useState('')

  const load = useCallback(async () => {
    if (!roomCode) return
    const foundGame = await getGameByRoomCode(roomCode)
    setGame(foundGame)
    if (foundGame) {
      setPlayers(await listPlayers(foundGame.id))
    }
  }, [roomCode])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!game) return
    const unsubPlayers = subscribeToPlayers(game.id, () => void load())
    const unsubGame = subscribeToGame(game.id, (updated) => {
      setGame(updated)
      if (updated.status === 'active') navigate(`/game/${updated.room_code}`)
    })
    return () => {
      unsubPlayers()
      unsubGame()
    }
  }, [game, load, navigate])

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>
  if (!session) return <div className="p-8 text-neutral-400">Sign in from the home page first.</div>
  if (!game) return <div className="p-8 text-neutral-400">Looking for room {roomCode}…</div>

  const user = session.user
  const isSeated = players.some((p) => p.user_id === user.id)
  const isCreator = game.created_by === user.id
  const isHotseat = game.play_mode === 'hotseat'
  const canStart = isCreator && players.length >= game.min_players && game.status === 'lobby'
  const canAddPlayer = isHotseat && isCreator && game.status === 'lobby' && players.length < game.max_players

  async function handleJoin() {
    if (!game) return
    setError(null)
    setBusy(true)
    try {
      await joinGame({
        game,
        userId: user.id,
        displayName:
          (user.user_metadata?.full_name as string | undefined) ??
          (user.user_metadata?.name as string | undefined) ??
          user.email ??
          'Player',
        avatarUrl: (user.user_metadata?.avatar_url as string | undefined) ?? null,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join')
    } finally {
      setBusy(false)
    }
  }

  /** Hotseat: the host seats another local player under their own account — see gameApi.ts's addLocalPlayer for why this needs no separate sign-in. */
  async function handleAddLocalPlayer() {
    if (!game) return
    const displayName = newPlayerName.trim()
    if (displayName.length === 0) return
    setError(null)
    setBusy(true)
    try {
      await addLocalPlayer({ game, hostUserId: user.id, displayName })
      setNewPlayerName('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add player')
    } finally {
      setBusy(false)
    }
  }

  async function handleRemovePlayer(playerId: string) {
    setError(null)
    setBusy(true)
    try {
      await removePlayer(playerId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove player')
    } finally {
      setBusy(false)
    }
  }

  async function handleStart() {
    if (!game) return
    setBusy(true)
    try {
      // The `games` row's own status stays the coarse lobby/active/completed
      // (see dbTypes.ts) — the engine's finer-grained status (boardSetup ->
      // active) lives only in the game_state row's GameState.status, and
      // GamePage branches its rendering on that instead. So starting a game
      // means: build the real initial GameState (createNewGame + startGame,
      // which kicks off board setup), persist it, then flip `games.status`
      // to 'active' just to move everyone out of the lobby screen.
      const existingState = await getGameState(game.id)
      if (!existingState) {
        await insertGameState(game.id, buildGenesisState(game, players))
      }
      await setGameStatus(game.id, 'active')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start game')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Room {game.room_code}</h1>
        <p className="text-neutral-400">
          {game.play_mode} · {players.length}/{game.max_players} players ·{' '}
          {game.map_template_id
            ? (listMapTemplates().find((t) => t.id === game.map_template_id)?.name ?? game.map_template_id)
            : 'interactive map'}
        </p>
      </header>

      {error && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}

      <ul className="flex flex-col gap-2">
        {players.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-md border border-neutral-800 p-2">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: p.color }} />
            {p.avatar_url && <img src={p.avatar_url} alt="" className="h-6 w-6 rounded-full" />}
            <span className="flex-1">{p.display_name}</span>
            {!isHotseat && p.user_id === game.created_by && <span className="text-xs text-neutral-500">(host)</span>}
            {isHotseat && isCreator && game.status === 'lobby' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleRemovePlayer(p.id)}
                title={`Remove ${p.display_name}`}
                className="text-xs text-neutral-500 hover:text-red-400 disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      {isHotseat && isCreator && game.status === 'lobby' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleAddLocalPlayer()
          }}
          className="flex gap-2"
        >
          <input
            value={newPlayerName}
            onChange={(e) => setNewPlayerName(e.target.value)}
            placeholder="Local player name"
            disabled={busy || !canAddPlayer}
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !canAddPlayer || newPlayerName.trim().length === 0}
            className="rounded-md border border-neutral-700 px-4 py-2 font-medium hover:border-neutral-500 disabled:opacity-50"
          >
            Add player
          </button>
        </form>
      )}

      {isHotseat && !isCreator && !isSeated && (
        <p className="text-sm text-neutral-500">
          This is a hotseat game, played from a single device — ask the host to add you as a local player from their
          screen.
        </p>
      )}

      {!isHotseat && !isSeated && (
        <button
          disabled={busy}
          onClick={() => void handleJoin()}
          className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Join this game
        </button>
      )}

      {isSeated && game.status === 'lobby' && (
        <button
          disabled={busy || !canStart}
          onClick={() => void handleStart()}
          className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {isCreator ? `Start game (needs ${game.min_players}+ players)` : 'Waiting for host to start…'}
        </button>
      )}
    </div>
  )
}
