import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export interface AuthState {
  session: Session | null
  loading: boolean
}

/**
 * Tracks the current Supabase auth session (Discord identity). Used by all
 * three play modes to answer "which player am I" — live/async clients use
 * this directly, hotseat swaps sessions between pre-authenticated players
 * (see PlayerSwitcher).
 */
export function useAuth(): AuthState {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setLoading(false)
    })

    return () => subscription.subscription.unsubscribe()
  }, [])

  return { session, loading }
}
