import { useEffect, useState } from 'react'
import { saveProfileDisplayName } from '../lib/gameApi'

/**
 * Lets a player pick a custom display name, overriding the one otherwise
 * derived from their Discord account (see resolveDisplayName). Editable any
 * time — a new value only affects games created/joined/observed afterward,
 * same as how a Discord name change wouldn't retroactively rename a player
 * already seated in an in-progress game.
 */
export function DisplayNameSettings({
  userId,
  value,
  fallback,
  loading,
  onSaved,
}: {
  userId: string
  value: string | null
  fallback: string
  loading: boolean
  onSaved: (name: string | null) => void
}) {
  const [input, setInput] = useState(value ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setInput(value ?? '')
  }, [value])

  async function handleSave() {
    const trimmed = input.trim()
    if (trimmed.length > 40) {
      setError('Display name must be 40 characters or fewer.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const next = trimmed.length > 0 ? trimmed : null
      await saveProfileDisplayName(userId, next)
      onSaved(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return null

  return (
    <details className="rounded-md border border-neutral-800 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-neutral-200">Display name</summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-neutral-400">
          Shown to other players instead of your Discord name (<span className="text-neutral-300">{fallback}</span>).
          Leave blank to use your Discord name.
        </p>
        {error && <p className="text-red-400">{error}</p>}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={fallback}
          maxLength={40}
          disabled={busy}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 disabled:opacity-50"
        />
        <div>
          <button
            type="button"
            disabled={busy || input.trim() === (value ?? '')}
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
