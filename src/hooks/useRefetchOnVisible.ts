import { useEffect, useRef } from 'react'

/**
 * Re-runs `refetch` whenever the tab regains visibility. The games list
 * screens (HomePage.tsx/MyGamesPage.tsx/PublicRoomsPage.tsx) otherwise only
 * fetch once per mount, so a card can go stale — e.g. still showing "your
 * turn" (blue, bolded name) after you've already acted and moved to another
 * tab/app while waiting on an opponent — issue #293 section 2. Same
 * visibilitychange approach as useAppUpdateAvailable.ts. `refetch` is called
 * through a ref so callers can pass a fresh closure every render without
 * re-subscribing the listener.
 *
 * Also re-runs on a `{ type: 'REFRESH_DATA' }` postMessage from the service
 * worker (see `notificationclick` in sw.ts) — tapping a push notification to
 * foreground an already-open tab doesn't reliably fire `visibilitychange` in
 * every browser/PWA install, so the SW nudges the page directly instead of
 * relying on it to notice (issue #405).
 */
export function useRefetchOnVisible(refetch: () => void): void {
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') refetchRef.current()
    }
    function onMessage(event: MessageEvent) {
      if ((event.data as { type?: string } | undefined)?.type === 'REFRESH_DATA') refetchRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
    }
  }, [])
}
