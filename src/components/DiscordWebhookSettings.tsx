import type { User } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { getDiscordWebhookUrl, saveDiscordWebhookUrl } from '../lib/gameApi'
import { discordUserIdFromIdentities, isDiscordWebhookUrl, sendDiscordNotification, turnNotificationMessage } from '../lib/discordNotify'

/**
 * Account-level (not per-game) settings for async "your turn" Discord
 * notifications — each player creates their own webhook on a Discord
 * channel they control and pastes the URL in here. The actual ping is sent
 * server-side by the notify-discord-turn Edge Function (see
 * supabase/functions/notify-discord-turn), not by any player's browser.
 */
export function DiscordWebhookSettings({ user }: { user: User }) {
  const userId = user.id
  const [webhookUrl, setWebhookUrl] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testSent, setTestSent] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getDiscordWebhookUrl(userId).then((url) => {
      if (cancelled) return
      setWebhookUrl(url ?? '')
      setSaved(url)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [userId])

  async function handleSave() {
    const trimmed = webhookUrl.trim()
    if (trimmed.length > 0 && !isDiscordWebhookUrl(trimmed)) {
      setError("That doesn't look like a Discord webhook URL.")
      return
    }
    setError(null)
    setBusy(true)
    try {
      await saveDiscordWebhookUrl(userId, trimmed.length > 0 ? trimmed : null)
      setSaved(trimmed.length > 0 ? trimmed : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  async function handleTest() {
    if (!saved) return
    setBusy(true)
    setTestSent(false)
    try {
      await sendDiscordNotification(
        saved,
        turnNotificationMessage({
          displayName: 'Test Player',
          discordUserId: discordUserIdFromIdentities(user.identities),
          roomName: 'Test Room',
          roomCode: 'TEST',
          phase: 'take a test turn',
          round: 1,
          gameUrl: null,
        }),
      )
      setTestSent(true)
      setTimeout(() => setTestSent(false), 2000)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return null

  return (
    <details className="rounded-md border border-neutral-800 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-neutral-200">
        Discord notifications {saved ? '(on)' : '(off)'}
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-neutral-400">
          Paste in a Discord{' '}
          <a
            href="https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-neutral-200"
          >
            webhook URL
          </a>{' '}
          from a channel you control to get pinged there when it's your turn in an async game. Never shown to other
          players — only readable server-side.
        </p>
        {error && <p className="text-red-400">{error}</p>}
        <input
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/…"
          disabled={busy}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 disabled:opacity-50"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || webhookUrl.trim() === (saved ?? '')}
            onClick={() => void handleSave()}
            className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            disabled={busy || !saved}
            onClick={() => void handleTest()}
            className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 disabled:opacity-50"
          >
            {testSent ? 'Sent!' : 'Send test'}
          </button>
        </div>
      </div>
    </details>
  )
}
