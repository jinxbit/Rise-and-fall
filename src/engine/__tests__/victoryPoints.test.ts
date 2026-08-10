import { describe, expect, it } from 'vitest'
import { calculateAchievementVP, calculateBoardCountVP, calculateGoldVP, determineWinners, sumVP } from '../victoryPoints'
import type { Coordinate, Player, Unit } from '../types'

let unitCounter = 0
function unitAt(ownerId: string, kind: string, coord: Coordinate = { q: 0, r: 0 }): Unit {
  unitCounter += 1
  return {
    id: `test-unit-${unitCounter}`,
    ownerId,
    kind,
    coord,
    movement: { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }
}

function playerWithGold(id: string, gold: number): Player {
  return {
    id,
    authUserId: null,
    displayName: id,
    color: 'red',
    handCardIds: [],
    currentlyPlayedCardId: null,
    discardCardIds: [],
    supplyCardIds: [],
    declineCardIds: [],
    eliminated: false,
    resources: { gold, wood: 0, stone: 0 },
  }
}

describe('calculateAchievementVP', () => {
  it('sums VP for whichever achievements each player claimed', () => {
    const claimed = { 'city-mastery': 'p1', 'temple-mastery': 'p1', 'nomad-mastery': 'p2' }
    const vp = calculateAchievementVP(claimed, { 'city-mastery': 1, 'temple-mastery': 1, 'nomad-mastery': 1 })

    expect(vp).toEqual({ p1: 2, p2: 1 })
  })

  it('treats an achievement id missing from achievementVictoryPoints as worth 0', () => {
    const vp = calculateAchievementVP({ 'ship-mastery': 'p1' }, {})

    expect(vp).toEqual({ p1: 0 })
  })

  it('returns an empty object when nothing has been claimed', () => {
    expect(calculateAchievementVP({}, { 'city-mastery': 1 })).toEqual({})
  })
})

describe('calculateBoardCountVP', () => {
  const curves = { city: [1, 2, 3, 4] }

  it('scores each player by their per-kind board count via that kind\'s curve', () => {
    const units = [unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p2', 'city')]

    const vp = calculateBoardCountVP(units, curves)

    expect(vp).toEqual({ p1: 3, p2: 1 })
  })

  it('uses the curve\'s last entry when the count exceeds the array length', () => {
    const units = [unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p1', 'city')]

    const vp = calculateBoardCountVP(units, curves)

    expect(vp).toEqual({ p1: 4 })
  })

  it('scores a unit kind with no curve entry (or an empty curve) as 0', () => {
    const units = [unitAt('p1', 'temple')]

    expect(calculateBoardCountVP(units, { temple: [] })).toEqual({})
    expect(calculateBoardCountVP(units, {})).toEqual({})
  })

  it('sums across multiple unit kinds for the same player', () => {
    const units = [unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p1', 'temple')]

    const vp = calculateBoardCountVP(units, { city: [1, 2, 3], temple: [5] })

    expect(vp).toEqual({ p1: 7 })
  })
})

describe('calculateGoldVP', () => {
  it('converts each player\'s held gold at goldPerVictoryPoint, rounded down — the reported bug (gold was not counted toward VP at all)', () => {
    const players = [playerWithGold('p1', 5), playerWithGold('p2', 4)]

    expect(calculateGoldVP(players, 2)).toEqual({ p1: 2, p2: 2 })
  })

  it('rounds down rather than up (5 gold at 2/point is 2 VP, not 3)', () => {
    expect(calculateGoldVP([playerWithGold('p1', 5)], 2)).toEqual({ p1: 2 })
  })

  it('scores 0 gold as 0 VP, not omitted', () => {
    expect(calculateGoldVP([playerWithGold('p1', 0)], 2)).toEqual({ p1: 0 })
  })

  it('scores everyone 0 when goldPerVictoryPoint is null (no gold-VP content supplied)', () => {
    expect(calculateGoldVP([playerWithGold('p1', 100)], null)).toEqual({})
  })
})

describe('sumVP', () => {
  it('merges multiple VP-by-player maps into totals', () => {
    const totals = sumVP({ p1: 2, p2: 1 }, { p1: 3 }, { p2: 5, p3: 1 })

    expect(totals).toEqual({ p1: 5, p2: 6, p3: 1 })
  })

  it('returns an empty object for no sources', () => {
    expect(sumVP()).toEqual({})
  })
})

describe('determineWinners', () => {
  it('returns the sole player with the highest total', () => {
    expect(determineWinners(['p1', 'p2', 'p3'], { p1: 5, p2: 9, p3: 3 })).toEqual(['p2'])
  })

  it('returns every player tied for the highest total — no tiebreaker', () => {
    expect(determineWinners(['p1', 'p2', 'p3'], { p1: 9, p2: 9, p3: 3 })).toEqual(['p1', 'p2'])
  })

  it("treats a player missing from the VP map as having 0, including in an all-0 tie", () => {
    expect(determineWinners(['p1', 'p2'], {})).toEqual(['p1', 'p2'])
  })

  it('returns an empty array for no players', () => {
    expect(determineWinners([], { p1: 5 })).toEqual([])
  })
})
