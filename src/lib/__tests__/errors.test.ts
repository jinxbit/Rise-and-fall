import { describe, expect, it } from 'vitest'
import { simpleError, toAppError } from '../errors'

describe('toAppError', () => {
  it('uses a real Error message and stack for the message/details', () => {
    const err = new Error('boom')
    const result = toAppError(err, 'fallback')
    expect(result.message).toBe('boom')
    expect(result.details).toContain('boom')
    expect(result.details).toContain('Error')
  })

  it('extracts the message from a Postgrest-style error object instead of falling back', () => {
    // Supabase's PostgrestError is a plain object, not `instanceof Error` —
    // this is the case that used to be silently swallowed by
    // `err instanceof Error ? err.message : fallback`.
    const err = { message: 'permission denied for table games', code: '42501', hint: 'check RLS policy' }
    const result = toAppError(err, 'Failed to load games')
    expect(result.message).toBe('permission denied for table games')
    expect(result.details).toContain('42501')
    expect(result.details).toContain('check RLS policy')
  })

  it('falls back to the given message when nothing usable is thrown', () => {
    const result = toAppError('a raw string was thrown', 'Failed to load games')
    expect(result.message).toBe('Failed to load games')
  })
})

describe('simpleError', () => {
  it('uses the same text for message and details', () => {
    expect(simpleError('No game found with that room code.')).toEqual({
      message: 'No game found with that room code.',
      details: 'No game found with that room code.',
    })
  })
})
