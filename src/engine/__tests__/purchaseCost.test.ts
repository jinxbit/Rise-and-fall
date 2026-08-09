import { describe, expect, it } from 'vitest'
import { calculatePurchaseCost } from '../purchaseCost'

describe('calculatePurchaseCost', () => {
  // content/achievements.json's purchaseCost.byAchievementCount.
  const costTable = [5, 10, 20, 40, 60, 80]

  it('is free before any achievement has been claimed', () => {
    expect(calculatePurchaseCost(0, costTable)).toBe(0)
  })

  it('matches the given cost table exactly', () => {
    expect(calculatePurchaseCost(1, costTable)).toBe(5)
    expect(calculatePurchaseCost(2, costTable)).toBe(10)
    expect(calculatePurchaseCost(3, costTable)).toBe(20)
    expect(calculatePurchaseCost(4, costTable)).toBe(40)
    expect(calculatePurchaseCost(5, costTable)).toBe(60)
    expect(calculatePurchaseCost(6, costTable)).toBe(80)
  })

  it('is free for an empty cost table', () => {
    expect(calculatePurchaseCost(3, [])).toBe(0)
  })
})
