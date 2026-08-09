import { describe, expect, it } from 'vitest'
import { gainResource, spendResource } from '../resources'
import type { Resources } from '../types'

const empty: Resources = { gold: 0, wood: 0, stone: 0 }

describe('gainResource', () => {
  it('moves the full amount from bank to player when there is room on both sides', () => {
    const { resources, bank } = gainResource({ ...empty, wood: 1 }, { ...empty, wood: 10 }, 'wood', 2, 5)

    expect(resources.wood).toBe(3)
    expect(bank.wood).toBe(8)
  })

  it('caps the gain at the player cap (wood/stone: 5), leaving the remainder in the bank', () => {
    const { resources, bank } = gainResource({ ...empty, wood: 4 }, { ...empty, wood: 10 }, 'wood', 3, 5)

    expect(resources.wood).toBe(5)
    expect(bank.wood).toBe(9)
  })

  it('caps the gain at whatever is left in the bank', () => {
    const { resources, bank } = gainResource({ ...empty, stone: 0 }, { ...empty, stone: 2 }, 'stone', 5, 5)

    expect(resources.stone).toBe(2)
    expect(bank.stone).toBe(0)
  })

  it('gains nothing once the player is already at their cap', () => {
    const { resources, bank } = gainResource({ ...empty, wood: 5 }, { ...empty, wood: 10 }, 'wood', 1, 5)

    expect(resources.wood).toBe(5)
    expect(bank.wood).toBe(10)
  })

  it('is uncapped per player for gold (playerCap: null)', () => {
    const { resources, bank } = gainResource({ ...empty, gold: 100 }, { ...empty, gold: 500 }, 'gold', 50, null)

    expect(resources.gold).toBe(150)
    expect(bank.gold).toBe(450)
  })

  it('never gains more than the bank has, even for an uncapped resource', () => {
    const { resources, bank } = gainResource({ ...empty, gold: 0 }, { ...empty, gold: 10 }, 'gold', 999, null)

    expect(resources.gold).toBe(10)
    expect(bank.gold).toBe(0)
  })
})

describe('spendResource', () => {
  it('moves the amount from player back to bank', () => {
    const result = spendResource({ ...empty, stone: 5 }, { ...empty, stone: 3 }, 'stone', 2)

    expect(result).not.toBeNull()
    expect(result?.resources.stone).toBe(3)
    expect(result?.bank.stone).toBe(5)
  })

  it('returns null when the player does not have enough to spend', () => {
    const result = spendResource({ ...empty, gold: 4 }, { ...empty, gold: 0 }, 'gold', 5)

    expect(result).toBeNull()
  })

  it('allows spending exactly what the player has', () => {
    const result = spendResource({ ...empty, wood: 2 }, empty, 'wood', 2)

    expect(result?.resources.wood).toBe(0)
    expect(result?.bank.wood).toBe(2)
  })
})
