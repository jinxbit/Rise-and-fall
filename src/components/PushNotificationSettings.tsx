import type { User } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { deletePushSubscription, savePushSubscription } from '../lib/gameApi'
import { getExistingPushSubscription, isPushSupported, subscribeToPush, unsubscribeFromPush } from '../lib/pushNotify'

/**
 * Account-level opt-in for async "your turn" Web Push notifications —
 * parallel to DiscordWebhookSettings.tsx, but needs no external service:
 * the browser itself is the delivery channel. The actual ping is sent
 * server-side by the notify-web-push Edge Function (see
 * supabase/functions/notify-web-push), not by any player's browser.
 *
 * Hidden entirely when VITE_VAPID_PUBLIC_KEY isn't configured (the backend
 * half of Web Push isn't set up) or the browser doesn't support the Push API
 * at all (notably: iOS Safari before 16.4, and only after the app has been
 * installed to the home screen — see README).
 */
export function PushNotificationSettings({ user }: { user: User }) {
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
  const [subscription, setSubscription] = useState<PushSubscription | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getExistingPushSubscription().then((existing) => {
      if (!cancelled) {
        setSubscription(existing)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!vapidPublicKey || !isPushSupported()) return null
  if (loading) return null

  async function handleEnable() {
    if (!vapidPublicKey) return
    setError(null)
    setBusy(true)
    try {
      const sub = await subscribeToPush(vapidPublicKey)
      if (!sub) {
        setError('Notification permission was not granted.')
        return
      }
      await savePushSubscription(user.id, sub.toJSON())
      setSubscription(sub)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable notifications')
    } finally {
      setBusy(false)
    }
  }

  async function handleDisable() {
    if (!subscription) return
    setBusy(true)
    setError(null)
    try {
      await deletePushSubscription(subscription.endpoint)
      await unsubscribeFromPush(subscription)
      setSubscription(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable notifications')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="rounded-md border border-neutral-800 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-neutral-200">
        Push notifications {subscription ? '(on)' : '(off)'}
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-neutral-400">
          Get a system notification on this device when it's your turn in an async game — no Discord setup needed.
        </p>
        {error && <p className="text-red-400">{error}</p>}
        <div>
          {subscription ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleDisable()}
              className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 disabled:opacity-50"
            >
              Turn off
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleEnable()}
              className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 disabled:opacity-50"
            >
              Turn on
            </button>
          )}
        </div>
      </div>
    </details>
  )
}
