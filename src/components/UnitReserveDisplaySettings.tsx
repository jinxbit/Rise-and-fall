import { useEffect, useState } from 'react'
import { saveProfileUnitReserveDisplay } from '../lib/gameApi'
import type { UnitReserveDisplayMode } from '../lib/unitReserveDisplay'

const OPTIONS: { value: UnitReserveDisplayMode; label: string; description: string }[] = [
  { value: 'remaining', label: 'Remaining', description: 'How many more of that unit you can still place (supply cap minus units on the board).' },
  { value: 'placed', label: 'Placed', description: 'How many of that unit you currently have on the board.' },
  { value: 'both', label: 'Placed / remaining', description: 'Both counts together, as "placed/remaining".' },
]

/**
 * Lets a player choose how PlayersStrip's per-kind unit badge (RoundView.tsx)
 * reports their unit supply (issue #346) — remaining, placed, or both.
 * Editable any time, like DisplayNameSettings; a new value only affects
 * boards rendered afterward.
 */
export function UnitReserveDisplaySettings({
  userId,
  value,
  loading,
  onSaved,
}: {
  userId: string
  value: UnitReserveDisplayMode
  loading: boolean
  onSaved: (mode: UnitReserveDisplayMode) => void
}) {
  const [input, setInput] = useState<UnitReserveDisplayMode>(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setInput(value)
  }, [value])

  async function handleChange(next: UnitReserveDisplayMode) {
    setInput(next)
    setError(null)
    setBusy(true)
    try {
      await saveProfileUnitReserveDisplay(userId, next)
      onSaved(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
      setInput(value)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return null

  return (
    <details className="rounded-md border border-neutral-800 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-neutral-200">Unit reserve display</summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-neutral-400">Controls what the unit-count badge next to each player's name shows.</p>
        {error && <p className="text-red-400">{error}</p>}
        <div className="flex flex-col gap-1.5">
          {OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-2">
              <input
                type="radio"
                name="unit-reserve-display"
                checked={input === option.value}
                disabled={busy}
                onChange={() => void handleChange(option.value)}
                className="mt-1 h-4 w-4 border-neutral-700 bg-neutral-900"
              />
              <span>
                <span className="text-neutral-200">{option.label}</span>
                <span className="block text-xs text-neutral-500">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </details>
  )
}
