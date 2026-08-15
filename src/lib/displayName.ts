import type { User } from '@supabase/supabase-js'

/**
 * The name shown for a signed-in user: their custom display name
 * (0015_profile_display_name.sql) if they've set one, otherwise the same
 * Discord-derived fallback chain used before that column existed.
 */
export function resolveDisplayName(user: User, profileDisplayName: string | null): string {
  return (
    profileDisplayName ??
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    user.email ??
    'Player'
  )
}
