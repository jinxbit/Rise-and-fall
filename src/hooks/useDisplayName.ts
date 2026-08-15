import type { User } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { getProfileDisplayName } from '../lib/gameApi'
import { resolveDisplayName } from '../lib/displayName'

export interface DisplayNameState {
  /** The Discord-fallback name until the profile row loads, then the resolved (custom-or-Discord) name. */
  displayName: string
  /** The user's custom name (null = not set), once loaded — for controlling DisplayNameSettings. */
  profileDisplayName: string | null
  loading: boolean
  setProfileDisplayName: (name: string | null) => void
}

/**
 * Loads and resolves a signed-in user's effective display name — see
 * resolveDisplayName. Accepts `null` (e.g. before auth has resolved) so it
 * can be called unconditionally ahead of a page's own loading/session
 * checks, per the rules of hooks.
 */
export function useDisplayName(user: User | null): DisplayNameState {
  const [profileDisplayName, setProfileDisplayName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const userId = user?.id ?? null

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    void getProfileDisplayName(userId).then((name) => {
      if (cancelled) return
      setProfileDisplayName(name)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [userId])

  return {
    displayName: user ? resolveDisplayName(user, profileDisplayName) : '',
    profileDisplayName,
    loading,
    setProfileDisplayName,
  }
}
