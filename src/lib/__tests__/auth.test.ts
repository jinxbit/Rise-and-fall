import { afterEach, describe, expect, it, vi } from 'vitest'

// signInAsGuest() only needs to prove it refuses before touching Supabase,
// so the real client (which needs VITE_SUPABASE_URL/ANON_KEY) is unnecessary.
vi.mock('../supabase', () => ({ supabase: {} }))

const { isGuestAuthAllowed, signInAsGuest } = await import('../auth')

describe('isGuestAuthAllowed', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is false when VITE_ALLOW_GUEST_AUTH is unset, regardless of environment', () => {
    vi.stubEnv('VITE_ALLOW_GUEST_AUTH', undefined)
    vi.stubEnv('VITE_ENVIRONMENT', 'Preview')
    expect(isGuestAuthAllowed()).toBe(false)
  })

  it('is false in a production build even if VITE_ALLOW_GUEST_AUTH leaked in (issue #677)', () => {
    vi.stubEnv('VITE_ALLOW_GUEST_AUTH', 'true')
    vi.stubEnv('VITE_ENVIRONMENT', undefined)
    expect(isGuestAuthAllowed()).toBe(false)
  })

  it('is true only when both opted in and non-production', () => {
    vi.stubEnv('VITE_ALLOW_GUEST_AUTH', 'true')
    vi.stubEnv('VITE_ENVIRONMENT', 'Preview')
    expect(isGuestAuthAllowed()).toBe(true)
  })
})

describe('signInAsGuest', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses to sign in when guest auth is not allowed, without touching Supabase', async () => {
    vi.stubEnv('VITE_ALLOW_GUEST_AUTH', undefined)
    vi.stubEnv('VITE_ENVIRONMENT', undefined)
    await expect(signInAsGuest()).rejects.toThrow('Guest sign-in is not available')
  })
})
