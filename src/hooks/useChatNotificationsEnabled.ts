import type { User } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { getProfileChatNotificationsEnabled } from '../lib/gameApi'
import { DEFAULT_CHAT_NOTIFICATIONS_ENABLED } from '../lib/chatNotificationPreference'

export interface ChatNotificationsEnabledState {
  /** DEFAULT_CHAT_NOTIFICATIONS_ENABLED until the profile row loads, then the saved value. */
  value: boolean
  loading: boolean
  setValue: (value: boolean) => void
}

/**
 * Loads a signed-in user's "notify me on chat messages" preference (issue
 * #658, see src/lib/chatNotificationPreference.ts) — accepts `null` (e.g.
 * before auth has resolved) so it can be called unconditionally ahead of a
 * page's own loading/session checks, per the rules of hooks — same shape as
 * useConfirmBeforeRevealingCards.
 */
export function useChatNotificationsEnabled(user: User | null): ChatNotificationsEnabledState {
  const [value, setValue] = useState<boolean>(DEFAULT_CHAT_NOTIFICATIONS_ENABLED)
  const [loading, setLoading] = useState(true)

  const userId = user?.id ?? null

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    void getProfileChatNotificationsEnabled(userId)
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
