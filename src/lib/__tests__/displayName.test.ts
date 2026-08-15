import { describe, expect, it } from 'vitest'
import { resolveDisplayName } from '../displayName'
import type { User } from '@supabase/supabase-js'

function makeUser(userMetadata: Record<string, unknown>, email?: string): User {
  return { id: 'u1', user_metadata: userMetadata, email } as User
}

describe('resolveDisplayName', () => {
  it('prefers the custom profile display name over anything Discord-derived', () => {
    const user = makeUser({ full_name: 'Discord Name', name: 'discorduser' }, 'user@example.com')
    expect(resolveDisplayName(user, 'Custom Name')).toBe('Custom Name')
  })

  it('falls back to full_name when no custom name is set', () => {
    const user = makeUser({ full_name: 'Discord Name', name: 'discorduser' }, 'user@example.com')
    expect(resolveDisplayName(user, null)).toBe('Discord Name')
  })

  it('falls back to name when full_name is missing', () => {
    const user = makeUser({ name: 'discorduser' }, 'user@example.com')
    expect(resolveDisplayName(user, null)).toBe('discorduser')
  })

  it('falls back to email when no Discord metadata name is present', () => {
    const user = makeUser({}, 'user@example.com')
    expect(resolveDisplayName(user, null)).toBe('user@example.com')
  })

  it("falls back to 'Player' when nothing else is available", () => {
    const user = makeUser({})
    expect(resolveDisplayName(user, null)).toBe('Player')
  })
})
