import { useEffect, useState } from 'react'
import { saveProfileConfirmBeforeRevealingCards } from '../lib/gameApi'

/**
 * Lets a player opt out of issue #528's "Reveal all cards" confirmation
 * step — RoundView.tsx's select-cards/decline panels, when this is on
 * (the default), hold a player's own pick behind that button instead of
 * submitting it immediately whenever it would be the one that reveals
 * every player's simultaneous choice. Editable any time, like
 * UnitReserveDisplaySettings; a new value only affects panels rendered
 * afterward.
 */
export function ConfirmBeforeRevealingCardsSettings({
  userId,
  value,
  loading,
  onSaved,
}: {
  userId: string
  value: boolean
  loading: boolean
  onSaved: (value: boolean) => void
}) {
  const [input, setInput] = useState<boolean>(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setInput(value)
  }, [value])

  async function handleChange(next: boolean) {
    setInput(next)
    setError(null)
    setBusy(true)
    try {
      await saveProfileConfirmBeforeRevealingCards(userId, next)
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
      <summary className="cursor-pointer font-medium text-neutral-200">Confirm before revealing cards</summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-neutral-400">
          When your pick would be the last one and would reveal everyone's card-selection or decline choice, hold it behind a
          &ldquo;Reveal all cards&rdquo; button instead of revealing it the instant you click.
        </p>
        {error && <p className="text-red-400">{error}</p>}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={input}
            disabled={busy}
            onChange={(e) => void handleChange(e.target.checked)}
            className="mt-1 h-4 w-4 border-neutral-700 bg-neutral-900"
          />
          <span className="text-neutral-200">Ask me to confirm</span>
        </label>
      </div>
    </details>
  )
}
