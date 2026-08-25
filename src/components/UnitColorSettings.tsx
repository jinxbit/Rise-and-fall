import { useEffect, useState } from 'react'
import { saveProfileUnitColors } from '../lib/gameApi'
import type { UnitPlateColorOverrides } from '../lib/unitColors'
import { DEFAULT_UNIT_PLATE_COLORS, isValidHexColor, resolveUnitPlateColors } from '../lib/unitColors'

const ROWS: { key: keyof UnitPlateColorOverrides; label: string; description: string }[] = [
  { key: 'hand', label: 'In hand', description: 'A card sitting untouched in your hand.' },
  { key: 'selected', label: 'Selected to play', description: "The card you've chosen to play this round, before your turn resolves it." },
  { key: 'discard', label: 'In discard', description: "Already played this round — also covers another player's pick once their turn passes." },
]

/**
 * Lets a player customize the map's unit-plate fill for each of the 3
 * card-zone states a unit's card can be in (issue #311 follow-up — see
 * HexBoard.tsx's UnitMarker.cardState). Editable any time, like
 * DisplayNameSettings; a new value only affects boards rendered afterward.
 */
export function UnitColorSettings({
  userId,
  overrides,
  loading,
  onSaved,
}: {
  userId: string
  overrides: UnitPlateColorOverrides
  loading: boolean
  onSaved: (overrides: UnitPlateColorOverrides) => void
}) {
  const [input, setInput] = useState<UnitPlateColorOverrides>(overrides)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setInput(overrides)
  }, [overrides])

  const resolved = resolveUnitPlateColors(input)
  const dirty = ROWS.some((row) => input[row.key] !== overrides[row.key])

  async function handleSave() {
    for (const row of ROWS) {
      const value = input[row.key]
      if (value !== null && !isValidHexColor(value)) {
        setError(`${row.label} must be a valid colour.`)
        return
      }
    }
    setError(null)
    setBusy(true)
    try {
      await saveProfileUnitColors(userId, input)
      onSaved(input)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return null

  return (
    <details className="rounded-md border border-neutral-800 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-neutral-200">Unit plate colours</summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-neutral-400">
          Customizes the map's unit-plate fill for a unit whose card is in your hand, chosen to play this round, or already in discard.
        </p>
        {error && <p className="text-red-400">{error}</p>}
        {ROWS.map((row) => (
          <div key={row.key} className="flex items-center gap-3">
            <input
              type="color"
              value={resolved[row.key]}
              disabled={busy}
              onChange={(e) => setInput((prev) => ({ ...prev, [row.key]: e.target.value }))}
              className="h-8 w-10 shrink-0 cursor-pointer rounded border border-neutral-700 bg-transparent disabled:opacity-50"
              aria-label={`${row.label} colour`}
            />
            <div className="flex flex-1 flex-col">
              <span className="text-neutral-200">{row.label}</span>
              <span className="text-xs text-neutral-500">{row.description}</span>
            </div>
            {input[row.key] !== null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setInput((prev) => ({ ...prev, [row.key]: null }))}
                className="text-xs text-neutral-400 underline hover:text-neutral-200 disabled:opacity-50"
                title={`Reset to the default (${DEFAULT_UNIT_PLATE_COLORS[row.key]})`}
              >
                Reset
              </button>
            )}
          </div>
        ))}
        <div>
          <button
            type="button"
            disabled={busy || !dirty}
            onClick={() => void handleSave()}
            className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </details>
  )
}
