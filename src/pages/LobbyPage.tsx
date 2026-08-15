import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useDisplayName } from '../hooks/useDisplayName'
import { GameLengthSelector } from '../components/GameLengthSelector'
import { MapTemplateSelector } from '../components/MapTemplateSelector'
import { TaleSelector } from '../components/TaleSelector'
import { listMapTemplates, listTales } from '../content/resolveContent'
import { buildGenesisState } from '../lib/gameGenesis'
import {
  addLocalPlayer,
  cancelGame,
  deleteGame,
  getGameByRoomCode,
  getGameState,
  insertGameState,
  joinGame,
  listPlayers,
  markReady,
  MAX_PLAYERS,
  removePlayer,
  setGameStatus,
  setGameVisibility,
  subscribeToGame,
  subscribeToPlayers,
  updateGameSettings,
} from '../lib/gameApi'
import { allPlayersReady, canStartGame, isPlayerReady } from '../lib/roomReadiness'
import type { GameRow, GameSettings, PlayerRow } from '../lib/dbTypes'

export function LobbyPage() {
  const { roomCode } = useParams<{ roomCode: string }>()
  const { session, loading: authLoading } = useAuth()
  const { displayName } = useDisplayName(session?.user ?? null)
  const navigate = useNavigate()

  const [game, setGame] = useState<GameRow | null>(null)
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newPlayerName, setNewPlayerName] = useState('')

  const [configOpen, setConfigOpen] = useState(false)
  const [draftSettings, setDraftSettings] = useState<GameSettings | null>(null)
  const [draftMinPlayersInput, setDraftMinPlayersInput] = useState('2')
  const [draftMaxPlayersInput, setDraftMaxPlayersInput] = useState('4')

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

  const gameId = game?.id ?? null

  useEffect(() => {
    if (!gameId) return
    const unsubPlayers = subscribeToPlayers(gameId, () => void load())
    const unsubGame = subscribeToGame(gameId, (updated) => {
      setGame(updated)
      if (updated.status === 'active') navigate(`/game/${updated.room_code}`)
    })
    // Re-fetch once the subscriptions are live in case the game already
    // transitioned to 'active' in the gap between the initial load() and
    // subscribe() taking effect (e.g. the host started the game right as
    // this client was loading the room) — otherwise that update would never
    // be observed since these are the only two ways `game` gets set.
    void load()
    return () => {
      unsubPlayers()
      unsubGame()
    }
    // Deliberately keyed on gameId (not the whole `game` object): `game` is
    // replaced by both subscribeToPlayers' onChange (via load()) and this
    // effect's own subscribeToGame callback, so depending on it would tear
    // down and recreate these realtime channels on almost every update —
    // and Supabase Realtime doesn't replay events published in the gap
    // between unsubscribing and the new channel's SUBSCRIBED ack, so the
    // 'active' transition could be silently dropped for a non-host client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, load, navigate])

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>
  if (!session) return <div className="p-8 text-neutral-400">Sign in from the home page first.</div>
  if (!game) return <div className="p-8 text-neutral-400">Looking for room {roomCode}…</div>

  const user = session.user
  const me = players.find((p) => p.user_id === user.id) ?? null
  const isSeated = me !== null
  const isCreator = game.created_by === user.id
  const isHotseat = game.play_mode === 'hotseat'
  const canStart = isCreator && canStartGame(game, players)
  const canAddPlayer = isHotseat && isCreator && game.status === 'lobby' && players.length < game.max_players
  // Owner-only lifecycle actions (0008_room_lifecycle.sql's RLS is the real
  // guard; these just decide what to render — see the room lifecycle spec's
  // sections 3/12 for the deletable/cancelable states).
  const canCancel = isCreator && game.status === 'lobby'
  const canDelete = isCreator && (game.status === 'lobby' || game.status === 'canceled')
  // Configuration editing (issue section 9): Owner-only, and only pre-start —
  // 0009_config_versioning.sql's trigger rejects it once the room isn't lobby.
  const canEditConfig = isCreator && game.status === 'lobby'
  // Non-host seated players can unjoin while the room hasn't started; the
  // host leaves by canceling/deleting the room instead (see canCancel/
  // canDelete below), since removing their own row would orphan it.
  const canLeave = isSeated && !isCreator && game.status === 'lobby'
  // Visibility (issue section 4): Owner-only, any time short of canceled —
  // unlike settings/min-max players this isn't gameplay configuration, so
  // it's not locked once the room leaves the lobby (see setGameVisibility).
  const canEditVisibility = isCreator && game.status !== 'canceled'
  const meNeedsReady = isSeated && !isCreator && game.status === 'lobby' && me !== null && !isPlayerReady(game, me)

  function openConfigEditor() {
    if (!game) return
    setDraftSettings(game.settings)
    setDraftMinPlayersInput(String(game.min_players))
    setDraftMaxPlayersInput(String(game.max_players))
    setConfigOpen(true)
  }

  function closeConfigEditor() {
    setConfigOpen(false)
    setDraftSettings(null)
  }

  async function handleJoin() {
    if (!game) return
    setError(null)
    setBusy(true)
    try {
      await joinGame({
        game,
        userId: user.id,
        displayName,
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

  /** A non-host player unjoins a room they're seated in, before it starts (RLS lets anyone delete their own player row, same as handleRemovePlayer). Unlike removing someone else, leaving takes you back to the home page — there's nothing left to look at here. */
  async function handleLeave() {
    if (!game || !me) return
    setError(null)
    setBusy(true)
    try {
      await removePlayer(me.id)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave game')
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

  async function handleCancel() {
    if (!game) return
    setBusy(true)
    try {
      await cancelGame(game.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel room')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!game) return
    setBusy(true)
    try {
      await deleteGame(game.id)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete room')
      setBusy(false)
    }
  }

  async function handleToggleVisibility() {
    if (!game) return
    setError(null)
    setBusy(true)
    try {
      await setGameVisibility(game.id, game.visibility === 'public' ? 'private' : 'public')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update visibility')
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveConfig() {
    if (!game || !draftSettings) return
    setError(null)
    setBusy(true)
    try {
      await updateGameSettings(game.id, { settings: draftSettings, minPlayers: draftMinPlayers, maxPlayers: draftMaxPlayers })
      closeConfigEditor()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update configuration')
    } finally {
      setBusy(false)
    }
  }

  async function handleReady() {
    if (!game || !me) return
    setError(null)
    setBusy(true)
    try {
      await markReady(me.id, game.config_version)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark ready')
    } finally {
      setBusy(false)
    }
  }

  const draftMinPlayers = Number(draftMinPlayersInput)
  const draftMaxPlayers = Number(draftMaxPlayersInput)
  const draftMinPlayersValid = /^\d+$/.test(draftMinPlayersInput.trim()) && draftMinPlayers >= 1
  const draftMaxPlayersValid =
    /^\d+$/.test(draftMaxPlayersInput.trim()) && draftMaxPlayers >= 1 && draftMaxPlayers <= MAX_PLAYERS
  const draftConfigValid =
    draftSettings !== null &&
    draftMinPlayersValid &&
    draftMaxPlayersValid &&
    draftMaxPlayers >= draftMinPlayers &&
    draftMaxPlayers >= players.length
  const draftPlayerCountError = !draftMinPlayersValid
    ? `Min players must be a whole number of at least 1.`
    : !draftMaxPlayersValid
      ? `Max players must be a whole number between 1 and ${MAX_PLAYERS}.`
      : draftMaxPlayers < draftMinPlayers
        ? `Max players can't be lower than min players.`
        : draftMaxPlayers < players.length
          ? `Max players can't go below the ${players.length} already seated.`
          : null

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">{game.name}</h1>
        <p className="text-sm text-neutral-500">Room {game.room_code}</p>
        <p className="text-neutral-400">
          {game.play_mode} · {players.length}/{game.max_players} players · {game.settings.gameLength} achievements ·{' '}
          {game.settings.mapTemplateId
            ? (listMapTemplates().find((t) => t.id === game.settings.mapTemplateId)?.name ?? game.settings.mapTemplateId)
            : 'interactive map'}
        </p>
        {game.settings.activeTaleIds.length > 0 && (
          <p className="text-sm text-neutral-500">
            Tales:{' '}
            {game.settings.activeTaleIds
              .map((id) => listTales().find((t) => t.id === id)?.name ?? id)
              .join(', ')}
          </p>
        )}
        <p className="mt-1 text-sm text-neutral-500">
          {game.visibility === 'public' ? 'Public — listed on the Public rooms screen' : 'Private — only reachable via this room’s link/code'}
          {canEditVisibility && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleToggleVisibility()}
              className="ml-2 text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
            >
              Make {game.visibility === 'public' ? 'private' : 'public'}
            </button>
          )}
        </p>
        {canEditConfig && !configOpen && (
          <button
            type="button"
            onClick={openConfigEditor}
            className="mt-2 text-sm text-indigo-400 hover:text-indigo-300"
          >
            Edit configuration
          </button>
        )}
      </header>

      {error && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}

      {game.status === 'canceled' && (
        <div className="rounded-md bg-neutral-800/60 p-3 text-sm text-neutral-300">
          This room was canceled{isCreator ? '' : ' by the host'}. It stays here for reference until{' '}
          {isCreator ? 'you delete it.' : 'the host deletes it.'}
        </div>
      )}

      {configOpen && draftSettings && (
        <div className="flex flex-col gap-4 rounded-md border border-neutral-800 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium text-neutral-200">Edit configuration</h2>
            <p className="text-xs text-neutral-500">Changing this will ask everyone to confirm Ready again.</p>
          </div>

          <div className="flex gap-4">
            <label className="flex flex-1 flex-col gap-1 text-sm text-neutral-400">
              Min players
              <input
                type="number"
                inputMode="numeric"
                value={draftMinPlayersInput}
                onChange={(e) => setDraftMinPlayersInput(e.target.value)}
                className={`rounded-md border bg-neutral-900 px-3 py-2 text-neutral-100 ${
                  draftMinPlayersValid ? 'border-neutral-700' : 'border-red-500'
                }`}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm text-neutral-400">
              Max players
              <input
                type="number"
                inputMode="numeric"
                value={draftMaxPlayersInput}
                onChange={(e) => setDraftMaxPlayersInput(e.target.value)}
                className={`rounded-md border bg-neutral-900 px-3 py-2 text-neutral-100 ${
                  draftMaxPlayersValid && draftMaxPlayers >= draftMinPlayers && draftMaxPlayers >= players.length
                    ? 'border-neutral-700'
                    : 'border-red-500'
                }`}
              />
            </label>
          </div>
          {draftPlayerCountError && <p className="text-sm text-red-400">{draftPlayerCountError}</p>}

          <div>
            <h3 className="mb-2 text-sm font-medium text-neutral-400">Game length</h3>
            <GameLengthSelector
              value={draftSettings.gameLength}
              onChange={(gameLength) => setDraftSettings({ ...draftSettings, gameLength })}
            />
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-neutral-400">Map</h3>
            <MapTemplateSelector
              value={draftSettings.mapTemplateId}
              onChange={(mapTemplateId) => setDraftSettings({ ...draftSettings, mapTemplateId })}
            />
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-neutral-400">Tales (variant)</h3>
            <TaleSelector
              value={draftSettings.activeTaleIds}
              onChange={(activeTaleIds) => setDraftSettings({ ...draftSettings, activeTaleIds })}
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !draftConfigValid}
              onClick={() => void handleSaveConfig()}
              className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={closeConfigEditor}
              className="rounded-md border border-neutral-700 px-4 py-2 font-medium hover:border-neutral-500 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {players.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-md border border-neutral-800 p-2">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: p.color }} />
            {p.avatar_url && <img src={p.avatar_url} alt="" className="h-6 w-6 rounded-full" />}
            <span className="flex-1">{p.display_name}</span>
            {!isHotseat && p.user_id === game.created_by && <span className="text-xs text-neutral-500">(host)</span>}
            {!isHotseat && game.status === 'lobby' && p.user_id !== game.created_by && (
              <span className={`text-xs ${isPlayerReady(game, p) ? 'text-green-400' : 'text-amber-400'}`}>
                {isPlayerReady(game, p) ? 'Ready' : 'Not ready'}
              </span>
            )}
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

      {!isHotseat && !isSeated && game.status === 'lobby' && (
        <button
          disabled={busy}
          onClick={() => void handleJoin()}
          className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Join this game
        </button>
      )}

      {meNeedsReady && (
        <button
          disabled={busy}
          onClick={() => void handleReady()}
          className="rounded-md bg-green-600 px-4 py-2 font-medium text-white hover:bg-green-500 disabled:opacity-50"
        >
          Ready up (the host changed the configuration)
        </button>
      )}

      {isSeated && game.status === 'lobby' && (
        <button
          disabled={busy || !canStart}
          onClick={() => void handleStart()}
          className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {isCreator
            ? players.length < game.min_players
              ? `Start game (needs ${game.min_players}+ players)`
              : !allPlayersReady(game, players)
                ? 'Start game (waiting for all players to be ready)'
                : 'Start game'
            : 'Waiting for host to start…'}
        </button>
      )}

      {canLeave && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleLeave()}
          className="rounded-md border border-neutral-700 px-4 py-2 font-medium text-neutral-300 hover:border-red-400 hover:text-red-400 disabled:opacity-50"
        >
          Leave game
        </button>
      )}

      {(canCancel || canDelete) && (
        <div className="flex gap-2 border-t border-neutral-800 pt-4">
          {canCancel && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleCancel()}
              title="Cancel this room — it stays visible for reference until deleted, but nobody can join or start it anymore."
              className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:border-red-400 hover:text-red-400 disabled:opacity-50"
            >
              Cancel room
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleDelete()}
              title="Permanently delete this room."
              className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:border-red-400 hover:text-red-400 disabled:opacity-50"
            >
              Delete room
            </button>
          )}
        </div>
      )}
    </div>
  )
}
