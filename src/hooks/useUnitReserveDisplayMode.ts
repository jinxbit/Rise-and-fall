import type { User } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { getProfileUnitReserveDisplay } from '../lib/gameApi'
import { DEFAULT_UNIT_RESERVE_DISPLAY_MODE, type UnitReserveDisplayMode } from '../lib/unitReserveDisplay'

export interface UnitReserveDisplayModeState {
  /** DEFAULT_UNIT_RESERVE_DISPLAY_MODE until the profile row loads, then the saved mode — pass straight to RoundView's `unitReserveDisplayMode` prop. */
  mode: UnitReserveDisplayMode
  loading: boolean
  setMode: (mode: UnitReserveDisplayMode) => void
}

/**
 * Loads a signed-in user's unit reserve display preference — see
 * resolveUnitReserveDisplayMode. Accepts `null` (e.g. before auth has
 * resolved) so it can be called unconditionally ahead of a page's own
 * loading/session checks, per the rules of hooks — same shape as
 * useUnitPlateColors.
 */
export function useUnitReserveDisplayMode(user: User | null): UnitReserveDisplayModeState {
  const [mode, setMode] = useState<UnitReserveDisplayMode>(DEFAULT_UNIT_RESERVE_DISPLAY_MODE)
  const [loading, setLoading] = useState(true)

  const userId = user?.id ?? null

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    void getProfileUnitReserveDisplay(userId)
      .then((loaded) => {
        if (cancelled) return
        setMode(loaded)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  return { mode, loading, setMode }
}
