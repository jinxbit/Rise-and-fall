import { describe, expect, it } from 'vitest'
import { isProductionBuild } from '../environment'

describe('isProductionBuild', () => {
  it('treats an unset or blank VITE_ENVIRONMENT as production', () => {
    expect(isProductionBuild(undefined)).toBe(true)
    expect(isProductionBuild('')).toBe(true)
    expect(isProductionBuild('   ')).toBe(true)
  })

  it('treats "production" (any case) as production even if set outright', () => {
    expect(isProductionBuild('production')).toBe(true)
    expect(isProductionBuild('Production')).toBe(true)
  })

  it('treats any other value as non-production', () => {
    expect(isProductionBuild('Preview')).toBe(false)
    expect(isProductionBuild('Local')).toBe(false)
  })
})
