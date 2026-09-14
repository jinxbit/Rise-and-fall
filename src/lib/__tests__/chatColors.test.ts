// CHAT_PLAN.md §15 (issue #581): site-wide chat names are colored by a
// deterministic hash of the display name, with nothing stored server-side.
import { describe, expect, it } from 'vitest'
import { hashDisplayNameToColor } from '../chatColors'

describe('hashDisplayNameToColor', () => {
  it('is deterministic for the same name', () => {
    expect(hashDisplayNameToColor('Alice')).toBe(hashDisplayNameToColor('Alice'))
  })

  it('differs for different names (not a constant fallback)', () => {
    expect(hashDisplayNameToColor('Alice')).not.toBe(hashDisplayNameToColor('Bob'))
  })

  it('produces a valid hsl() color string', () => {
    expect(hashDisplayNameToColor('Carol')).toMatch(/^hsl\(\d+, 70%, 70%\)$/)
  })
})
