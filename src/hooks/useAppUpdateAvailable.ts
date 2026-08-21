import { useEffect, useState } from 'react'

const CHECK_INTERVAL_MS = 5 * 60 * 1000

/**
 * Polls the deployed build's version.json in the background and reports
 * when it no longer matches the build this tab loaded, so the UI can offer
 * a reload instead of the player only finding out something's stale when
 * an action starts erroring mid-session (issue #247).
 */
export function useAppUpdateAvailable(): boolean {
  const [updateAvailable, setUpdateAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function check() {
      try {
        const response = await fetch('/version.json', { cache: 'no-store' })
        if (!response.ok) return
        const data = (await response.json()) as { buildId?: string }
        if (!cancelled && data.buildId && data.buildId !== __BUILD_ID__) {
          setUpdateAvailable(true)
        }
      } catch {
        // Offline or request blocked — try again on the next interval/focus.
      }
    }

    function onVisible() {
      if (document.visibilityState === 'visible') void check()
    }

    const interval = setInterval(() => void check(), CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisible)
    void check()

    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return updateAvailable
}
