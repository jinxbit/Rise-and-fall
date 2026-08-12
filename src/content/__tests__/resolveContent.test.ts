import { describe, expect, it } from 'vitest'
import { listGameLengthBounds, resolveAchievementContent, resolveUnitContent } from '../resolveContent'

describe('resolveUnitContent — real content/units.json movement facts', () => {
  // Regression: a reported game had a Merchant unable to move across a
  // cliff edge it should have been able to cross — canCrossCliffs was
  // wrongly false in units.json (only Mountaineer had it set).
  it('lets the Merchant cross cliffs', () => {
    const content = resolveUnitContent(2)
    expect(content.movementByKind.merchant.canCrossCliffs).toBe(true)
  })
})

describe('resolveAchievementContent — configurable gameLength (games.game_length)', () => {
  it('defaults to gameLength.default when no override is given', () => {
    const { default: defaultLength } = listGameLengthBounds()
    expect(resolveAchievementContent().gameLength).toBe(defaultLength)
  })

  it('uses the given gameLength when it is within bounds', () => {
    expect(resolveAchievementContent(5).gameLength).toBe(5)
    expect(resolveAchievementContent(6).gameLength).toBe(6)
  })

  it('clamps a gameLength above the content max down to the max', () => {
    const { max } = listGameLengthBounds()
    expect(resolveAchievementContent(999).gameLength).toBe(max)
  })

  it('clamps a gameLength below the content min up to the min', () => {
    const { min } = listGameLengthBounds()
    expect(resolveAchievementContent(0).gameLength).toBe(min)
  })
})
