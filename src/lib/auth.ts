import { supabase } from './supabase'

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
 */
export async function signInAsGuest() {
  const guestName = `Guest ${Math.floor(1000 + Math.random() * 9000)}`
  const { error } = await supabase.auth.signInAnonymously({
    options: { data: { full_name: guestName } },
  })
  if (error) throw error
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}
