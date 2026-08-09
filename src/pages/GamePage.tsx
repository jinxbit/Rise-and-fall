import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { BoardSetupView } from '../components/BoardSetupView'
import { RoundView } from '../components/RoundView'
import { resolveAchievementContent, resolveBoardGenerationContent, resolveUnitContent } from '../content/resolveContent'
import type { Action, UnitActionAssignment } from '../engine/actions'
import { applyAction } from '../engine/applyAction'
import { appendLog } from '../engine/log'
import { replayActions } from '../engine/replay'
import type { GameState as EngineGameState, Coordinate } from '../engine/types'
import { useAuth } from '../hooks/useAuth'
import type { GameRow, PlayerRow } from '../lib/dbTypes'
import { buildGenesisState } from '../lib/gameGenesis'
import { getGameByRoomCode, getGameState, listPlayers, subscribeToGameState, subscribeToPlayers, writeGameState } from '../lib/gameApi'

const ACTION_DESCRIPTION: Record<Action['type'], string> = {
  PLACE_TILE: 'placing a tile',
  PLACE_UNIT: 'placing a starting unit',
  CHOOSE_CARD: 'choosing a card',
  RESOLVE_UNIT_ACTION: 'resolving an action',
  MOVE_TO_DECLINE: 'moving a card to decline',
  PURCHASE_CARD: 'purchasing a card',
  PASS_PURCHASE: 'passing on purchasing',
}

export function GamePage() {
  const { roomCode } = useParams<{ roomCode: string }>()
  const { session, loading: authLoading } = useAuth()

  const [game, setGame] = useState<GameRow | null>(null)
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [gameState, setGameState] = useState<EngineGameState | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showStateJson, setShowStateJson] = useState(false)
  const [undoing, setUndoing] = useState(false)

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

  /**
   * Undo: any player, at any time, can roll the game back one action.
   * Genesis isn't stored anywhere (see GameState.actionHistory's doc
   * comment) — it's deterministically rebuilt from the game's row + seated
   * players (buildGenesisState, same logic LobbyPage.tsx used to start the
   * game) and every logged action except the last one is replayed on top of
   * it (replayActions), which is exactly what event sourcing buys us here:
   * "step back one action" needs no separate undo stack, just a shorter
   * replay. Logs a note about what got undone (not itself a logged action —
   * it doesn't re-enter actionHistory, so it can't itself be undone).
   */
  async function handleUndo() {
    if (!game || !gameState || version === null || gameState.actionHistory.length === 0 || !me) return
    setUndoing(true)
    try {
      const genesis = buildGenesisState(game, players)
      const undoneEntry = gameState.actionHistory[gameState.actionHistory.length - 1]
      const previousHistory = gameState.actionHistory.slice(0, -1)
      let undoneState = replayActions(genesis, previousHistory, unitContent, achievementContent, boardGenerationContent)
      undoneState = {
        ...undoneState,
        log: appendLog(
          undoneState,
          me.id,
          `Player ${me.id} undid the last action: Player ${undoneEntry.action.playerId} ${ACTION_DESCRIPTION[undoneEntry.action.type]}`,
        ),
      }

      const wrote = await writeGameState(game.id, undoneState, version)
      if (!wrote) {
        const fresh = await getGameState(game.id)
        if (fresh) {
          setGameState(fresh.state)
          setVersion(fresh.version)
        }
        setActionError('Someone else acted first — the board refreshed, please try again.')
        return
      }

      setActionError(null)
      setGameState(undoneState)
      setVersion(version + 1)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to undo')
    } finally {
      setUndoing(false)
    }
  }

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>
  if (!session) return <div className="p-8 text-neutral-400">Sign in from the home page first.</div>
  if (!game) return <div className="p-8 text-neutral-400">Looking for room {roomCode}…</div>

  const me = players.find((p) => p.user_id === session.user.id)

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Room {game.room_code}</h1>
        <div className="flex items-center gap-4">
          <ul className="flex gap-3 text-sm text-neutral-400">
            {players.map((p) => (
              <li key={p.id} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                {p.display_name}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={!me || undoing || !gameState || gameState.actionHistory.length === 0}
            onClick={() => void handleUndo()}
            title="Undo the last action — any player can do this, at any time."
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
          >
            {undoing ? 'Undoing…' : 'Undo last action'}
          </button>
          <button
            type="button"
            disabled={!gameState}
            onClick={() => setShowStateJson((v) => !v)}
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
          >
            {showStateJson ? 'Hide' : 'Show'} game state JSON
          </button>
        </div>
      </header>

      {showStateJson && gameState && (
        <pre className="max-h-96 overflow-auto rounded-md border border-neutral-800 bg-neutral-900 p-4 text-xs text-neutral-300">
          {JSON.stringify(gameState, null, 2)}
        </pre>
      )}

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
