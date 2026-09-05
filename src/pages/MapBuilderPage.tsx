// Map Builder — a mode used only for map creation and saving (issue #23),
// distinct from every other page here: it's entirely local/client-side,
// no `games`/`players` row is ever created. One signed-in user drives
// interactive tile placement (reusing the exact same board-generation
// engine and BoardSetupView UI a real game's board setup uses) on behalf
// of a chosen player count, then saves the finished terrain layout to the
// map pool (src/lib/mapPoolApi.ts) for future games to pick up at random
// (see MapModeSelector.tsx) instead of building one from scratch.

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BoardSetupView } from '../components/BoardSetupView'
import { HexBoard } from '../components/HexBoard'
import { useAuth } from '../hooks/useAuth'
import { resolveBoardGenerationContent } from '../content/resolveContent'
import { applyAction } from '../engine/applyAction'
import { beginBoardSetup, currentTilePlacerId } from '../engine/boardSetup'
import { createEmptyBoard } from '../engine/board'
import { createNewGame } from '../engine/createGame'
import { MAX_PLAYERS } from '../lib/gameApi'
import { saveMapToPool } from '../lib/mapPoolApi'
import type { Coordinate, GameState } from '../engine/types'
import type { PlayerRow } from '../lib/dbTypes'

const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#06b6d4', '#ec4899']

/**
 * One placeholder "seat" per player count, purely to drive the board-setup
 * engine's turn cycling and starting-water-tile seeding (both keyed off
 * `turnOrder.length`) — never seen by anyone but this browser tab, and
 * thrown away the moment the board is saved (saveMapToPool only persists
 * the terrain, not these). The same local user places every tile,
 * regardless of whose nominal turn it is — see `myPlayerId` below.
 */
function builderPlayers(count: number): PlayerRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `builder-${i}`,
    game_id: 'map-builder',
    user_id: `builder-${i}`,
    display_name: `Player ${i + 1}`,
    avatar_url: null,
    seat_index: i,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length],
    is_active: true,
    joined_at: '',
    ready_for_version: 0,
  }))
}

export function MapBuilderPage() {
  const { session, loading } = useAuth()
  const [playerCountInput, setPlayerCountInput] = useState('2')
  const [state, setState] = useState<GameState | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const playerCount = Math.min(MAX_PLAYERS, Math.max(2, Number(playerCountInput) || 2))
  const players = useMemo(() => builderPlayers(playerCount), [playerCount])
  const boardGenerationContent = useMemo(() => resolveBoardGenerationContent(playerCount), [playerCount])

  if (loading) {
    return <div className="p-8 text-neutral-400">Loading…</div>
  }

  if (!session) {
    return (
      <div className="p-8 text-neutral-400">
        <Link to="/" className="underline hover:text-neutral-200">
          Sign in
        </Link>{' '}
        to build and save a map.
      </div>
    )
  }

  function start() {
    const lobbyState = createNewGame({
      gameId: 'map-builder',
      playMode: 'hotseat',
      board: createEmptyBoard('hex'),
      players: players.map((p) => ({ id: p.id, authUserId: null, displayName: p.display_name, color: p.color })),
    })
    setState(beginBoardSetup(lobbyState, boardGenerationContent))
    setSaved(false)
    setSaveError(null)
  }

  function reset() {
    setState(null)
    setSaved(false)
    setSaveError(null)
  }

  async function save() {
    if (!state || !session) return
    setSaveError(null)
    try {
      await saveMapToPool({ board: state.board, playerCount, userId: session.user.id })
      setSaved(true)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save map')
    }
  }

  const tilesRemain = state?.boardSetup ? state.boardSetup.tileTierQueue.length > 0 : false

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Map builder</h1>
        <Link to="/" className="text-sm underline hover:text-neutral-200">
          Home
        </Link>
      </header>
      <p className="text-sm text-neutral-400">
        Build a map by placing tiles exactly like the start of a real game, then save it to the map pool so a future
        game can start from it at random instead of building one from scratch.
      </p>

      {!state && (
        <div className="flex items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-neutral-400">
            Player count
            <input
              type="number"
              inputMode="numeric"
              min={2}
              max={MAX_PLAYERS}
              value={playerCountInput}
              onChange={(e) => setPlayerCountInput(e.target.value)}
              className="w-20 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-center text-neutral-100"
            />
          </label>
          <button onClick={start} className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500">
            Start building
          </button>
        </div>
      )}

      {state && tilesRemain && (
        <BoardSetupView
          state={state}
          players={players}
          myPlayerId={currentTilePlacerId(state)}
          boardGenerationContent={boardGenerationContent}
          onPlaceTile={(anchor: Coordinate, rotationSteps: number) => {
            const placerId = currentTilePlacerId(state)
            if (!placerId) return
            const result = applyAction(
              state,
              { type: 'PLACE_TILE', playerId: placerId, anchor, rotationSteps },
              undefined,
              undefined,
              boardGenerationContent,
            )
            if (result.ok) setState(result.state)
          }}
          onPlaceUnit={() => {}}
        />
      )}

      {state && !tilesRemain && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-300">Map complete — built for {playerCount} players.</p>
          <HexBoard board={state.board} interactive={false} />
          {saved ? (
            <p className="text-sm text-emerald-400">Saved to the map pool.</p>
          ) : (
            <button
              onClick={() => void save()}
              className="self-start rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500"
            >
              Save this map
            </button>
          )}
          {saveError && <p className="text-sm text-red-400">{saveError}</p>}
          <button onClick={reset} className="self-start text-sm underline hover:text-neutral-200">
            Build another map
          </button>
        </div>
      )}
    </div>
  )
}

