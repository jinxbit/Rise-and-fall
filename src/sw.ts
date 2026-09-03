/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa `injectManifest` strategy — see
// vite.config.ts). Two jobs:
//  1. Precache the hashed build assets vite-plugin-pwa injects below, purely
//     so the app is installable and usable offline once loaded.
//  2. Show a system notification when a Web Push message arrives (see
//     supabase/functions/notify-web-push and src/lib/pushNotify.ts) — the
//     "native notifications" half of PWA support.
//
// Deliberately does NOT precache/serve index.html or intercept navigations:
// the app already has its own "a newer build is live" detector
// (src/hooks/useAppUpdateAvailable.ts, issue #247) that depends on
// `/version.json` and the document always coming straight from the network.
// Letting Workbox own navigation requests here would fight that mechanism.
import { precacheAndRoute, cleanupOutdatedCaches, type PrecacheEntry } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | PrecacheEntry)[] }

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Take over immediately on activate instead of waiting for every old tab to
// close, so a deploy's precached assets stop being stale as soon as possible.
self.skipWaiting()
self.clients.claim()

interface TurnPushPayload {
  title: string
  body: string
  url: string
}

self.addEventListener('push', (event: PushEvent) => {
  let payload: TurnPushPayload = { title: 'Rise & Fall', body: "It's your turn.", url: '/' }
  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    // Malformed payload — fall back to the generic message above.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url },
    }),
  )
})

// Focuses an already-open tab on the target game instead of always opening a
// new one, since a player likely already has the app open in another tab.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/'

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const target = new URL(url, self.location.origin).href
      for (const client of clientsList) {
        if (client.url === target && 'focus' in client) {
          await client.focus()
          // The tab was already open, possibly backgrounded long enough for
          // its Supabase Realtime socket to drop — `focus()` alone doesn't
          // tell the page anything changed, so nudge it to refetch rather
          // than trust the page to notice on its own (issue #405).
          client.postMessage({ type: 'REFRESH_DATA' })
          return
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})
