import type { User } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { getProfileConfirmBeforeRevealingCards } from '../lib/gameApi'
import { DEFAULT_CONFIRM_BEFORE_REVEALING_CARDS } from '../lib/cardRevealConfirmation'

export interface ConfirmBeforeRevealingCardsState {
  /** DEFAULT_CONFIRM_BEFORE_REVEALING_CARDS until the profile row loads, then the saved value — pass straight to RoundView's `confirmBeforeRevealingCards` prop. */
  value: boolean
  loading: boolean
  setValue: (value: boolean) => void
}

/**
 * Loads a signed-in user's "confirm before revealing cards" preference (issue
 * #528, see src/lib/cardRevealConfirmation.ts) — accepts `null` (e.g. before
 * auth has resolved) so it can be called unconditionally ahead of a page's
 * own loading/session checks, per the rules of hooks — same shape as
 * useUnitReserveDisplayMode.
 */
export function useConfirmBeforeRevealingCards(user: User | null): ConfirmBeforeRevealingCardsState {
  const [value, setValue] = useState<boolean>(DEFAULT_CONFIRM_BEFORE_REVEALING_CARDS)
  const [loading, setLoading] = useState(true)

  const userId = user?.id ?? null

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    void getProfileConfirmBeforeRevealingCards(userId)
      .then((loaded) => {
        if (cancelled) return
        setValue(loaded)
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

  return { value, loading, setValue }
}
