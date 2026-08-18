import { useEffect, useState } from 'react'
import { listMapPoolByPlayerCount, pickRandomMapFromPool } from '../lib/mapPoolApi'
import { MAX_PLAYERS } from '../lib/gameApi'
import { HexBoard } from './HexBoard'
import type { Board } from '../engine/types'

export interface MapPoolChoice {
  board: Board
  mapId: string
  /** The exact player count this map was picked for (see the "Player count" buttons below) — the room's min/max player bounds get locked to this while the choice is active, since a saved map is built for one specific headcount, not a range. */
  playerCount: number
}

export type MapMode = 'build' | 'select' | 'blind'

const MODES: Array<{ value: MapMode; title: string; description: string }> = [
  { value: 'build', title: 'Build on game start', description: 'Build the map together interactively once the game starts.' },
  { value: 'select', title: 'Select map', description: 'Pick a specific saved map now — locks the room to that map’s player count.' },
  { value: 'blind', title: 'Blindly select map', description: 'A random saved map matching the final seated player count is picked automatically when the game starts.' },
]

const PLAYER_COUNTS = Array.from({ length: MAX_PLAYERS - 1 }, (_, i) => i + 2)

/**
 * How a room's map is sourced (issue #168) — one of three mutually
 * exclusive modes, replacing the old separate "Pre set map" toggle and
 * "Random saved map" checkbox (whose "checked" state depended on an async
 * pool fetch resolving, which could silently fail to check the box). Mode
 * selection here is synchronous and doesn't depend on that fetch succeeding.
 *
 * - "build": the default — no board is picked; the usual interactive setup
 *   runs when the game starts.
 * - "select": resolves and previews a concrete saved board immediately, for
 *   an exact player count chosen via the buttons below. The parent locks
 *   the room's min/max players to that count.
 * - "blind" (GameSettings.mapPoolRandomAtStart): no board is picked yet —
 *   LobbyPage.tsx's handleStart() picks one matching the actual seated
 *   player count once the host starts the game, falling back to
 *   interactive board building if none fits.
 */
export function MapModeSelector(props: {
  mode: MapMode
  onModeChange: (mode: MapMode) => void
  mapChoice: MapPoolChoice | null
  onMapChoiceChange: (choice: MapPoolChoice | null) => void
  /** Seeds the "Player count" buttons the first time this switches into "select" mode. */
  initialPlayerCount?: number
}) {
  const { mode, onModeChange, mapChoice, onMapChoiceChange, initialPlayerCount } = props
  const [playerCount, setPlayerCount] = useState(() =>
    Math.min(MAX_PLAYERS, Math.max(2, mapChoice?.playerCount ?? initialPlayerCount ?? 2)),
  )
  const [poolSize, setPoolSize] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (mode !== 'select') return
    let cancelled = false
    listMapPoolByPlayerCount(playerCount)
      .then((maps) => {
        if (!cancelled) setPoolSize(maps.length)
      })
      .catch(() => {
        if (!cancelled) setPoolSize(null)
      })
    return () => {
      cancelled = true
    }
  }, [mode, playerCount])

  async function reroll(count: number) {
    setError(null)
    setBusy(true)
    try {
      const picked = await pickRandomMapFromPool(count)
      if (!picked) {
        setError(`No saved maps for ${count} players yet.`)
        onMapChoiceChange(null)
        return
      }
      onMapChoiceChange({ board: picked.board, mapId: picked.id, playerCount: count })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pick a map')
    } finally {
      setBusy(false)
    }
  }

  function handleModeChange(next: MapMode) {
    setError(null)
    onModeChange(next)
    if (next === 'select') {
      void reroll(playerCount)
    } else {
      onMapChoiceChange(null)
    }
  }

  function handlePlayerCountChange(count: number) {
    setPlayerCount(count)
    void reroll(count)
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-800 p-3 text-left">
      <h3 className="text-sm font-medium text-neutral-400">Map</h3>
      <div className="flex flex-col gap-2">
        {MODES.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 transition-colors ${
              mode === option.value ? 'border-indigo-500 bg-indigo-500/10' : 'border-neutral-700 hover:border-neutral-500'
            }`}
          >
            <input
              type="radio"
              name="map-mode"
              checked={mode === option.value}
              onChange={() => handleModeChange(option.value)}
              className="mt-1 h-4 w-4 border-neutral-700 bg-neutral-900"
            />
            <div>
              <div className="font-medium">{option.title}</div>
              <div className="text-sm text-neutral-400">{option.description}</div>
            </div>
          </label>
        ))}
      </div>

      {mode === 'select' && (
        <div className="flex flex-col gap-3 pl-6">
          <div>
            <p className="mb-1.5 text-sm text-neutral-400">Player count</p>
            <div className="flex flex-wrap gap-1.5">
              {PLAYER_COUNTS.map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => handlePlayerCountChange(count)}
                  className={`h-8 w-8 rounded-md border text-sm font-medium transition-colors ${
                    playerCount === count
                      ? 'border-indigo-500 bg-indigo-500/20 text-white'
                      : 'border-neutral-700 text-neutral-300 hover:border-neutral-500'
                  }`}
                >
                  {count}
                </button>
              ))}
            </div>
            {poolSize !== null && (
              <p className="mt-1.5 text-xs text-neutral-500">
                {poolSize} saved map{poolSize === 1 ? '' : 's'} available for {playerCount} players
              </p>
            )}
          </div>

          {mapChoice && (
            <div className="max-w-[220px]">
              <HexBoard board={mapChoice.board} size={10} />
            </div>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => void reroll(playerCount)}
            className="self-start rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
          >
            {busy ? 'Picking…' : 'Reroll'}
          </button>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      )}
    </div>
  )
}
