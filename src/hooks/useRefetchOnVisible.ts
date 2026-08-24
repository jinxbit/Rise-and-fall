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
 */
export function useRefetchOnVisible(refetch: () => void): void {
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') refetchRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
}
