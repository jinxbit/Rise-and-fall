import { supabase } from './supabase'
import { clearGuestSession, readGuestSession, saveGuestSession } from './guestSession'

export async function signInWithDiscord() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'discord',
    options: {
      redirectTo: window.location.origin,
    },
  })
  if (error) throw error
}

/**
 * Testing-only bypass for Discord sign-in — creates a real (anonymous)
 * Supabase session, so RLS/`auth.uid()` and the rest of the app work
 * unmodified. Requires "Allow anonymous sign-ins" enabled in the Supabase
 * dashboard (Authentication → Sign In / Providers). Gated by
 * VITE_ALLOW_GUEST_AUTH so it's opt-in per deploy, not exposed by default.
 *
 * Resumes the same guest identity across a sign-out (see signOut() and
 * guestSession.ts) instead of always minting a new one, so a tester's own
 * games don't silently disappear from "My games" (issue #273).
 */
export async function signInAsGuest() {
  const backup = readGuestSession()
  if (backup) {
    const { error: resumeError } = await supabase.auth.setSession({
      access_token: backup.access_token,
      refresh_token: backup.refresh_token,
    })
    if (!resumeError) return
    clearGuestSession()
  }

  const guestName = `Guest ${Math.floor(1000 + Math.random() * 9000)}`
  const { error } = await supabase.auth.signInAnonymously({
    options: { data: { full_name: guestName } },
  })
  if (error) throw error
}

export async function signOut() {
  const { data } = await supabase.auth.getSession()
  const session = data.session

  if (session?.user.is_anonymous) {
    // Local-only sign-out: clears this browser's session without revoking
    // the refresh token server-side, so the backup above can resume it later.
    saveGuestSession(session.access_token, session.refresh_token)
    const { error } = await supabase.auth.signOut({ scope: 'local' })
    if (error) throw error
    return
  }

  const { error } = await supabase.auth.signOut()
  if (error) throw error
}
