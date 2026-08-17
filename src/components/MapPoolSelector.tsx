import { useEffect, useState } from 'react'
import { listMapPoolByPlayerCount, pickRandomMapFromPool } from '../lib/mapPoolApi'
import type { Board } from '../engine/types'

export interface MapPoolChoice {
  board: Board
  mapId: string
}

/**
 * "Random saved map" toggle for CreateGamePage/LobbyPage's map-source
 * picker (issue #23) — mutually exclusive with MapTemplateSelector in the
 * parent (see GameSettings.mapPoolBoard's doc comment for why the actual
 * board, not just a reference, is what ends up in settings). Picking a map
 * is an explicit action (checking the box, or "Pick a different one")
 * rather than something re-rolled on every render, since it's a real
 * network call and the parent only wants the *result* embedded, not a
 * live reference that would need re-resolving later.
 */
export function MapPoolSelector(props: { playerCount: number; value: MapPoolChoice | null; onChange: (choice: MapPoolChoice | null) => void }) {
  const { playerCount, value, onChange } = props
  const [poolSize, setPoolSize] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
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
  }, [playerCount])

  async function reroll() {
    setError(null)
    setBusy(true)
    try {
      const picked = await pickRandomMapFromPool(playerCount)
      if (!picked) {
        setError(`No saved maps for ${playerCount} players yet.`)
        onChange(null)
        return
      }
      onChange({ board: picked.board, mapId: picked.id })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pick a map')
    } finally {
      setBusy(false)
    }
  }

  const active = value !== null

  return (
    <div className={`flex flex-col gap-2 rounded-md border p-3 text-left transition-colors ${active ? 'border-indigo-500 bg-indigo-500/10' : 'border-neutral-700 hover:border-neutral-500'}`}>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => {
            if (e.target.checked) {
              void reroll()
            } else {
              onChange(null)
              setError(null)
            }
          }}
          className="mt-1 h-4 w-4 rounded border-neutral-700 bg-neutral-900"
        />
        <div>
          <div className="font-medium">Random saved map</div>
          <div className="text-sm text-neutral-400">
            Skip the map-building phase and start from a random map someone saved for {playerCount} players
            {poolSize !== null ? ` (${poolSize} available)` : ''}.
          </div>
        </div>
      </label>
      {active && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void reroll()}
          className="self-start rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
        >
          {busy ? 'Picking…' : 'Pick a different one'}
        </button>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  )
}
