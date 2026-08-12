import { describe, expect, it } from 'vitest'
import { resolveUnitContent } from '../resolveContent'

describe('resolveUnitContent — real content/units.json movement facts', () => {
  // Regression: a reported game had a Merchant unable to move across a
  // cliff edge it should have been able to cross — canCrossCliffs was
  // wrongly false in units.json (only Mountaineer had it set).
  it('lets the Merchant cross cliffs', () => {
    const content = resolveUnitContent(2)
    expect(content.movementByKind.merchant.canCrossCliffs).toBe(true)
  })
})
