import { useEffect, useState } from 'react'
import { saveProfileChatNotificationsEnabled } from '../lib/gameApi'

/**
 * Lets a player opt out of a Discord webhook / Web Push notification when
 * someone posts in a game's chat (issue #658) — on by default as of issue
 * #668 (previously opt-in: a player who already set up either channel for
 * turn/lifecycle pings would otherwise start getting one per chat message
 * with no prior opt-out; that tradeoff still exists, it's just no longer the
 * default). In-game chat only, and only for async games (CHAT_PLAN.md §20):
 * a live player already sees new messages over Realtime, and hotseat has
 * nobody remote to ping. Sending itself still needs a Discord webhook URL /
 * push subscription already configured above on this page — this toggle
 * only controls whether *chat* uses either channel, not whether the channel
 * exists.
 */
export function ChatNotificationSettings({
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
      await saveProfileChatNotificationsEnabled(userId, next)
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
      <summary className="cursor-pointer font-medium text-neutral-200">Chat message notifications</summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-neutral-400">
          Ping me (via Discord/push, above) when someone else posts in an async game's chat. On by default. Live and
          hotseat games never send this — you already see new messages there directly.
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
          <span className="text-neutral-200">Notify me on chat messages</span>
        </label>
      </div>
    </details>
  )
}
