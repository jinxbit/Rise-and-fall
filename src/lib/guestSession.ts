const KEY = 'riseAndFall.guestSession'

interface GuestSessionBackup {
  access_token: string
  refresh_token: string
}

/**
 * Anonymous ("guest") Supabase sessions have no credential to sign back into
 * — auth.signOut()'s default scope revokes the refresh token server-side, so
 * once a guest explicitly signs out, signInAsGuest() could previously only
 * mint a brand-new identity, silently orphaning every game the old identity
 * had played from "My games" while those same (public) games stayed visible
 * under Public Rooms, which isn't identity-scoped (issue #273). Stashing the
 * still-valid tokens here right before a guest signs out locally (see
 * signOut() in auth.ts) lets a later "Continue as guest" resume the same
 * identity instead of losing it.
 */
export function saveGuestSession(accessToken: string, refreshToken: string) {
  localStorage.setItem(KEY, JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }))
}

export function readGuestSession(): GuestSessionBackup | null {
  const raw = localStorage.getItem(KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as GuestSessionBackup
  } catch {
    return null
  }
}

export function clearGuestSession() {
  localStorage.removeItem(KEY)
}
