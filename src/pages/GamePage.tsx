import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { BoardSetupView } from '../components/BoardSetupView'
import { HexBoard } from '../components/HexBoard'
import { resolveBoardGenerationContent, resolveUnitContent } from '../content/resolveContent'
import type { Action } from '../engine/actions'
import { applyAction } from '../engine/applyAction'
import type { GameState as EngineGameState, Coordinate } from '../engine/types'
import { useAuth } from '../hooks/useAuth'
import type { GameRow, PlayerRow } from '../lib/dbTypes'
import { getGameByRoomCode, getGameState, listPlayers, subscribeToGameState, subscribeToPlayers, writeGameState } from '../lib/gameApi'

export function GamePage() {
  const { roomCode } = useParams<{ roomCode: string }>()
  const { session, loading: authLoading } = useAuth()

  const [game, setGame] = useState<GameRow | null>(null)
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [gameState, setGameState] = useState<EngineGameState | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!roomCode) return
    void (async () => {
      const foundGame = await getGameByRoomCode(roomCode)
      setGame(foundGame)
      if (foundGame) setPlayers(await listPlayers(foundGame.id))
    })()
  }, [roomCode])

  useEffect(() => {
    if (!game) return
    let cancelled = false

    void (async () => {
      const snapshot = await getGameState(game.id)
      if (!cancelled && snapshot) {
        setGameState(snapshot.state)
        setVersion(snapshot.version)
      }
    })()

    const unsubscribeGameState = subscribeToGameState(game.id, (snapshot) => {
      setGameState(snapshot.state)
      setVersion(snapshot.version)
    })
    const unsubscribePlayers = subscribeToPlayers(game.id, () => {
      void listPlayers(game.id).then(setPlayers)
    })

    return () => {
      cancelled = true
      unsubscribeGameState()
      unsubscribePlayers()
    }
  }, [game])

  const boardGenerationContent = useMemo(() => resolveBoardGenerationContent(players.length), [players.length])
  const unitContent = useMemo(() => resolveUnitContent(players.length), [players.length])

  async function submitAction(action: Action) {
    if (!game || !gameState || version === null) return

    const result = applyAction(gameState, action, unitContent, undefined, boardGenerationContent)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setActionError(null)

    const wrote = await writeGameState(game.id, result.state, version)
    if (!wrote) {
      const fresh = await getGameState(game.id)
      if (fresh) {
        setGameState(fresh.state)
        setVersion(fresh.version)
      }
      setActionError('Someone else acted first — the board refreshed, please try again.')
      return
    }

    setGameState(result.state)
    setVersion(version + 1)
  }

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>
  if (!session) return <div className="p-8 text-neutral-400">Sign in from the home page first.</div>
  if (!game) return <div className="p-8 text-neutral-400">Looking for room {roomCode}…</div>

  const me = players.find((p) => p.user_id === session.user.id)

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Room {game.room_code}</h1>
        <ul className="flex gap-3 text-sm text-neutral-400">
          {players.map((p) => (
            <li key={p.id} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
              {p.display_name}
            </li>
          ))}
        </ul>
      </header>

      {actionError && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{actionError}</div>}

      {!gameState && <p className="text-neutral-400">Setting up the game…</p>}

      {gameState?.status === 'boardSetup' && (
        <BoardSetupView
          state={gameState}
          players={players}
          myPlayerId={me?.id ?? null}
          boardGenerationContent={boardGenerationContent}
          onPlaceTile={(anchor: Coordinate, rotationSteps: number) => {
            if (!me) return
            void submitAction({ type: 'PLACE_TILE', playerId: me.id, anchor, rotationSteps })
          }}
          onPlaceUnit={(unitKind: string, coord: Coordinate) => {
            if (!me) return
            void submitAction({ type: 'PLACE_UNIT', playerId: me.id, unitKind, coord })
          }}
        />
      )}

      {gameState && gameState.status !== 'boardSetup' && (
        <div className="flex flex-col gap-3">
          <p className="rounded-md border border-dashed border-neutral-700 p-3 text-sm text-neutral-500">
            Board setup is complete. Round-by-round play (card selection, unit actions) doesn&apos;t have UI yet —
            this is a read-only view of the board.
          </p>
          <HexBoard
            board={gameState.board}
            units={gameState.units.map((u) => ({
              coord: u.coord,
              color: players.find((p) => p.id === u.ownerId)?.color ?? '#a3a3a3',
              label: u.kind.slice(0, 1).toUpperCase(),
            }))}
          />
        </div>
      )}
    </div>
  )
}
