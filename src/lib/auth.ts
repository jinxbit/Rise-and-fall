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

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
    },
  })
  if (error) throw error
}

/**
 * Registers a new account with email/password (issue #384) — an alternative
 * to Discord/Google for players who'd rather not use OAuth. `username`
 * becomes the account's `full_name` metadata, same field Discord/Google
 * populate, so resolveDisplayName picks it up with no extra profile write.
 * If the Supabase project requires email confirmation, `data.session` comes
 * back null and the caller should tell the user to check their inbox.
 */
export async function signUpWithEmail(email: string, password: string, username: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: username } },
  })
  if (error) throw error
  return { needsEmailConfirmation: data.session === null }
}

export async function signInWithEmail(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
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
