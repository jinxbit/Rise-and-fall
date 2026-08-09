import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { BoardSetupView } from '../components/BoardSetupView'
import { RoundView } from '../components/RoundView'
import { resolveAchievementContent, resolveBoardGenerationContent, resolveUnitContent } from '../content/resolveContent'
import type { Action, UnitActionAssignment } from '../engine/actions'
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
  const achievementContent = useMemo(() => resolveAchievementContent(), [])

  async function submitAction(action: Action) {
    if (!game || !gameState || version === null) return

    const result = applyAction(gameState, action, unitContent, achievementContent, boardGenerationContent)
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

      {gameState?.status === 'completed' && (
        <div className="rounded-md border border-amber-700/50 bg-amber-500/10 p-4 text-amber-300">
          <p className="text-lg font-semibold">Game over</p>
          <p>Winner{gameState.winnerPlayerIds.length > 1 ? 's' : ''}: {gameState.winnerPlayerIds.map((id) => players.find((p) => p.id === id)?.display_name ?? id).join(', ') || 'none'}</p>
        </div>
      )}

      {gameState?.status === 'active' && (
        <RoundView
          state={gameState}
          players={players}
          myPlayerId={me?.id ?? null}
          unitContent={unitContent}
          achievementContent={achievementContent}
          onChooseCard={(cardId) => {
            if (!me) return
            void submitAction({ type: 'CHOOSE_CARD', playerId: me.id, cardId })
          }}
          onResolveUnitAction={(unitActions: UnitActionAssignment[]) => {
            if (!me) return
            void submitAction({ type: 'RESOLVE_UNIT_ACTION', playerId: me.id, unitActions })
          }}
          onMoveToDecline={(cardId) => {
            if (!me) return
            void submitAction({ type: 'MOVE_TO_DECLINE', playerId: me.id, cardId })
          }}
          onPurchaseCard={(cardId) => {
            if (!me) return
            void submitAction({ type: 'PURCHASE_CARD', playerId: me.id, cardId })
          }}
          onPassPurchase={() => {
            if (!me) return
            void submitAction({ type: 'PASS_PURCHASE', playerId: me.id })
          }}
        />
      )}
    </div>
  )
}
