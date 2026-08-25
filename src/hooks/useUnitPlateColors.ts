import type { User } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { getProfileUnitColors } from '../lib/gameApi'
import type { UnitPlateColorOverrides, UnitPlateColors } from '../lib/unitColors'
import { resolveUnitPlateColors } from '../lib/unitColors'

export interface UnitPlateColorsState {
  /** DEFAULT_UNIT_PLATE_COLORS until the profile row loads, then the resolved (custom-or-default) colours — pass straight to HexBoard/RoundView's `unitPlateColors` prop. */
  colors: UnitPlateColors
  /** The user's raw overrides (null = not set per-state), once loaded — for controlling UnitColorSettings. */
  overrides: UnitPlateColorOverrides
  loading: boolean
  setOverrides: (overrides: UnitPlateColorOverrides) => void
}

const NO_OVERRIDES: UnitPlateColorOverrides = { hand: null, selected: null, discard: null }

/**
 * Loads and resolves a signed-in user's unit-plate colour overrides — see
 * resolveUnitPlateColors. Accepts `null` (e.g. before auth has resolved) so
 * it can be called unconditionally ahead of a page's own loading/session
 * checks, per the rules of hooks — same shape as useDisplayName.
 */
export function useUnitPlateColors(user: User | null): UnitPlateColorsState {
  const [overrides, setOverrides] = useState<UnitPlateColorOverrides>(NO_OVERRIDES)
  const [loading, setLoading] = useState(true)

  const userId = user?.id ?? null

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    void getProfileUnitColors(userId)
      .then((loaded) => {
        if (cancelled) return
        setOverrides(loaded)
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

  return {
    colors: resolveUnitPlateColors(overrides),
    overrides,
    loading,
    setOverrides,
  }
}
