import type { User } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { getIsAdmin } from '../lib/gameApi'

/**
 * Whether the signed-in user holds the "delete any game" override (issue
 * #177). Accepts `null` (e.g. before auth has resolved) so it can be called
 * unconditionally ahead of a page's own loading/session checks, per the
 * rules of hooks — same shape as useDisplayName.
 */
export function useIsAdmin(user: User | null): boolean {
  const [isAdmin, setIsAdmin] = useState(false)
  const userId = user?.id ?? null

  useEffect(() => {
    if (!userId) {
      setIsAdmin(false)
      return
    }
    let cancelled = false
    void getIsAdmin(userId)
      .then((admin) => {
        if (!cancelled) setIsAdmin(admin)
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false)
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  return isAdmin
}
