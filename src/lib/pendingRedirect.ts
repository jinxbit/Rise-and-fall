const KEY = 'riseAndFall.postSignInRedirect'

/**
 * Remembers where an unauthenticated visitor was trying to go, so HomePage
 * can send them back after they sign in. Uses sessionStorage (not React
 * state) because Discord sign-in does a full-page OAuth round trip that
 * would otherwise lose the intended destination.
 */
export function setPendingRedirect(path: string) {
  sessionStorage.setItem(KEY, path)
}

/** Reads and clears the pending redirect, if any. */
export function consumePendingRedirect(): string | null {
  const path = sessionStorage.getItem(KEY)
  if (path) sessionStorage.removeItem(KEY)
  return path
}
