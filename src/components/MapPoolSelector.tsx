import { useEffect, useState } from 'react'
import { listMapPoolByPlayerCount, pickRandomMapFromPool } from '../lib/mapPoolApi'
import { MAX_PLAYERS } from '../lib/gameApi'
import { HexBoard } from './HexBoard'
import type { Board } from '../engine/types'

export interface MapPoolChoice {
  board: Board
  mapId: string
  /** The exact player count this map was picked for (see this component's "Player count" field) — the room's min/max player bounds get locked to this while the choice is active, since a saved map is built for one specific headcount, not a range. */
  playerCount: number
}

/**
 * "Random saved map" toggle for CreateGamePage/LobbyPage's map-source
 * picker (issue #23, extended by issue #166) — mutually exclusive with
 * MapTemplateSelector in the parent (see GameSettings.mapPoolBoard's doc
 * comment for why the actual board, not just a reference, is what ends up
 * in settings). Offers two modes once active:
 *
 * - "Pick now": an explicit action (checking the box, changing the player
 *   count, or "Pick a different one") resolves and previews a concrete
 *   board immediately, same as before — the parent locks the room's
 *   min/max players to `playerCount` exactly, since the picked board was
 *   built for that headcount.
 * - "Random when the game starts" (GameSettings.mapPoolRandomAtStart): no
 *   board is picked yet — LobbyPage.tsx's handleStart() picks one matching
 *   the actual seated player count once the host starts the game, falling
 *   back to interactive board building if none fits.
 */
export function MapPoolSelector(props: {
  value: MapPoolChoice | null
  randomAtStart: boolean
  onChange: (choice: MapPoolChoice | null) => void
  onRandomAtStartChange: (randomAtStart: boolean) => void
  /** Seeds the "Player count" field the first time this is switched on — typically the parent's current max-players input. */
  initialPlayerCount?: number
}) {
  const { value, randomAtStart, onChange, onRandomAtStartChange, initialPlayerCount } = props
  const [playerCountInput, setPlayerCountInput] = useState(String(value?.playerCount ?? initialPlayerCount ?? 4))
  const [poolSize, setPoolSize] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = value !== null || randomAtStart
  const playerCount = Math.min(MAX_PLAYERS, Math.max(2, Number(playerCountInput) || 2))

  useEffect(() => {
    if (!active || randomAtStart) return
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
  }, [active, playerCount])

  async function reroll(count: number) {
    setError(null)
    setBusy(true)
    try {
      const picked = await pickRandomMapFromPool(count)
      if (!picked) {
        setError(`No saved maps for ${count} players yet.`)
        onChange(null)
        return
      }
      onChange({ board: picked.board, mapId: picked.id, playerCount: count })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pick a map')
    } finally {
      setBusy(false)
    }
  }

  function handleActivate() {
    onRandomAtStartChange(false)
    void reroll(playerCount)
  }

  function handleDeactivate() {
    onChange(null)
    onRandomAtStartChange(false)
    setError(null)
  }

  function handlePickNowMode() {
    onRandomAtStartChange(false)
    void reroll(playerCount)
  }

  function handleRandomAtStartMode() {
    onChange(null)
    onRandomAtStartChange(true)
    setError(null)
  }

  function handlePlayerCountChange(raw: string) {
    setPlayerCountInput(raw)
    const count = Math.min(MAX_PLAYERS, Math.max(2, Number(raw) || 2))
    if (!randomAtStart) void reroll(count)
  }

  return (
    <div className={`flex flex-col gap-2 rounded-md border p-3 text-left transition-colors ${active ? 'border-indigo-500 bg-indigo-500/10' : 'border-neutral-700 hover:border-neutral-500'}`}>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => (e.target.checked ? handleActivate() : handleDeactivate())}
          className="mt-1 h-4 w-4 rounded border-neutral-700 bg-neutral-900"
        />
        <div>
          <div className="font-medium">Random saved map</div>
          <div className="text-sm text-neutral-400">Use a map someone previously saved from Map Builder instead of building one interactively.</div>
        </div>
      </label>

      {active && (
        <div className="flex flex-col gap-3 pl-6">
          <div className="flex gap-4 text-sm text-neutral-300">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="radio" name="map-pool-mode" checked={!randomAtStart} onChange={handlePickNowMode} className="h-3.5 w-3.5" />
              Pick now
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="radio" name="map-pool-mode" checked={randomAtStart} onChange={handleRandomAtStartMode} className="h-3.5 w-3.5" />
              Random when the game starts
            </label>
          </div>

          {!randomAtStart && (
            <>
              <label className="flex items-center gap-2 text-sm text-neutral-400">
                Player count
                <input
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={MAX_PLAYERS}
                  value={playerCountInput}
                  onChange={(e) => handlePlayerCountChange(e.target.value)}
                  className="w-16 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-center text-neutral-100"
                />
                {poolSize !== null && <span>({poolSize} available)</span>}
              </label>
              <p className="text-xs text-neutral-500">This sets the room to exactly {playerCount} players — the saved map is built for that headcount.</p>

              {value && (
                <div className="max-w-[220px]">
                  <HexBoard board={value.board} size={10} />
                </div>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={() => void reroll(playerCount)}
                className="self-start rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
              >
                {busy ? 'Picking…' : 'Pick a different one'}
              </button>
            </>
          )}

          {randomAtStart && (
            <p className="text-sm text-neutral-400">
              A random saved map matching the final seated player count will be chosen the moment the game starts. If none exists for that count yet, the game falls back to building the map interactively.
            </p>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      )}
    </div>
  )
}
