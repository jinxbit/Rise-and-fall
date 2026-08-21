// Web Push "your turn" notifications. Mirrors the Discord webhook design
// (src/lib/discordNotify.ts): a player opts in once from their browser, and
// the actual ping is sent server-side by the notify-web-push Edge Function
// (supabase/functions/notify-web-push) — not this tab, so it still fires
// even if every tab is closed. The service worker that receives the push
// and shows the notification lives in src/sw.ts.

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/**
 * Requests notification permission (if not already granted/denied) and
 * subscribes this browser via the service worker's PushManager. Returns
 * null if the user declines permission — callers should treat that the
 * same as "subscription failed" rather than an error.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscription | null> {
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') return null

  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  if (existing) return existing

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  })
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager.getSubscription()
}

export async function unsubscribeFromPush(subscription: PushSubscription): Promise<void> {
  await subscription.unsubscribe()
}
