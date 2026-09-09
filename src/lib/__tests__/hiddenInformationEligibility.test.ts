import { describe, expect, it } from 'vitest'
import { hiddenInformationAvailable } from '../hiddenInformationEligibility'

describe('hiddenInformationAvailable', () => {
  it('is available for live/async games with rule enforcement on', () => {
    expect(hiddenInformationAvailable('live', true)).toBe(true)
    expect(hiddenInformationAvailable('async', true)).toBe(true)
  })

  it('is unavailable for hotseat even with rule enforcement on', () => {
    expect(hiddenInformationAvailable('hotseat', true)).toBe(false)
  })

  it('is unavailable whenever rule enforcement is off, regardless of play mode', () => {
    expect(hiddenInformationAvailable('live', false)).toBe(false)
    expect(hiddenInformationAvailable('async', false)).toBe(false)
    expect(hiddenInformationAvailable('hotseat', false)).toBe(false)
  })
})
