import { isProductionBuild } from './environment'
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
 * Sends a password-reset email (issue #386). The link lands back on
 * `/reset-password`, which Supabase turns into a temporary "recovery"
 * session (see ResetPasswordPage) that `updatePassword` below then uses.
 */
export async function requestPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  })
  if (error) throw error
}

/** Sets a new password for the signed-in user — used by ResetPasswordPage once the recovery-link session is active. */
export async function updatePassword(newPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw error
}

/**
 * Whether guest sign-in may be offered/used at all: `VITE_ALLOW_GUEST_AUTH`
 * opts it in per deploy, but that alone isn't trusted to keep it out of
 * production — a shared (not Preview-scoped) Vercel env var would leak it
 * there. So this also requires a non-production build by the
 * `VITE_ENVIRONMENT` convention (`isProductionBuild`, src/lib/environment.ts),
 * the same signal the environment badge uses, which needs no extra
 * configuration to stay off in production.
 */
export function isGuestAuthAllowed(): boolean {
  return import.meta.env.VITE_ALLOW_GUEST_AUTH === 'true' && !isProductionBuild(import.meta.env.VITE_ENVIRONMENT)
}

/**
 * Testing-only bypass for Discord sign-in — creates a real (anonymous)
 * Supabase session, so RLS/`auth.uid()` and the rest of the app work
 * unmodified. Requires "Allow anonymous sign-ins" enabled in the Supabase
 * dashboard (Authentication → Sign In / Providers). Gated by
 * `isGuestAuthAllowed()` so it's opt-in per deploy and disabled in production.
 */
export async function signInAsGuest() {
  if (!isGuestAuthAllowed()) throw new Error('Guest sign-in is not available')
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
