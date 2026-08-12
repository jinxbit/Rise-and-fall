import { describe, expect, it } from 'vitest'
import {
  calculateAchievementDetail,
  calculateAchievementVP,
  calculateBoardCountDetail,
  calculateBoardCountVP,
  calculateGoldVP,
  calculateVPBreakdown,
  calculateVPDetail,
  determineWinners,
  sumVP,
} from '../victoryPoints'
import { createEmptyBoard, setTile } from '../board'
import { createNewGame } from '../createGame'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../achievementContent'
import type { AchievementContent } from '../achievementContent'
import { EMPTY_TALE_CONTENT } from '../taleContent'
import type { Coordinate, GameState, Player, Unit } from '../types'

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

describe('calculateAchievementDetail', () => {
  it('itemizes the same result calculateAchievementVP sums, one entry per claimed achievement', () => {
    const claimed = { 'city-mastery': 'p1', 'temple-mastery': 'p1', 'nomad-mastery': 'p2' }
    const detail = calculateAchievementDetail(claimed, { 'city-mastery': 2, 'temple-mastery': 1, 'nomad-mastery': 5 })

    expect(detail.p1).toEqual(expect.arrayContaining([{ achievementId: 'city-mastery', vp: 2 }, { achievementId: 'temple-mastery', vp: 1 }]))
    expect(detail.p1).toHaveLength(2)
    expect(detail.p2).toEqual([{ achievementId: 'nomad-mastery', vp: 5 }])
  })

  it('treats an achievement id missing from achievementVictoryPoints as worth 0, still listed', () => {
    const detail = calculateAchievementDetail({ 'ship-mastery': 'p1' }, {})

    expect(detail).toEqual({ p1: [{ achievementId: 'ship-mastery', vp: 0 }] })
  })

  it('returns an empty object when nothing has been claimed', () => {
    expect(calculateAchievementDetail({}, { 'city-mastery': 1 })).toEqual({})
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

describe('calculateBoardCountDetail', () => {
  const curves = { city: [1, 2, 3, 4] }

  it("itemizes the same result calculateBoardCountVP sums, one entry per (player, kind)", () => {
    const units = [unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p2', 'city')]

    const detail = calculateBoardCountDetail(units, curves)

    expect(detail).toEqual({ p1: [{ kind: 'city', count: 3, vp: 3 }], p2: [{ kind: 'city', count: 1, vp: 1 }] })
  })

  it("uses the curve's last entry when the count exceeds the array length", () => {
    const units = [unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p1', 'city')]

    const detail = calculateBoardCountDetail(units, curves)

    expect(detail).toEqual({ p1: [{ kind: 'city', count: 5, vp: 4 }] })
  })

  it('omits a unit kind with no curve entry (or an empty curve), same as calculateBoardCountVP', () => {
    const units = [unitAt('p1', 'temple')]

    expect(calculateBoardCountDetail(units, { temple: [] })).toEqual({})
    expect(calculateBoardCountDetail(units, {})).toEqual({})
  })

  it('lists multiple unit kinds for the same player as separate entries', () => {
    const units = [unitAt('p1', 'city'), unitAt('p1', 'city'), unitAt('p1', 'temple')]

    const detail = calculateBoardCountDetail(units, { city: [1, 2, 3], temple: [5] })

    expect(detail.p1).toEqual(expect.arrayContaining([{ kind: 'city', count: 2, vp: 2 }, { kind: 'temple', count: 1, vp: 5 }]))
    expect(detail.p1).toHaveLength(2)
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

describe('calculateVPBreakdown', () => {
  function baseState(): GameState {
    let board = createEmptyBoard('hex')
    board = setTile(board, { q: 0, r: 0 }, 'water')
    board = setTile(board, { q: 1, r: 0 }, 'water')

    const state = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board,
      players: [
        { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      ],
    })

    const players = state.players.map((player) => (player.id === 'p1' ? { ...player, resources: { ...player.resources, gold: 5 } } : player))

    const units = [unitAt('p1', 'city', { q: 0, r: 0 }), unitAt('p1', 'city', { q: 1, r: 0 })]

    return { ...state, status: 'active', players, units, claimedByAchievementId: { 'city-mastery': 'p1' } }
  }

  const content: AchievementContent = {
    ...EMPTY_ACHIEVEMENT_CONTENT,
    achievementVictoryPoints: { 'city-mastery': 3 },
    unitBoardCountVP: { city: [1, 2] },
    terrainVictoryPoints: { water: 1 },
    goldPerVictoryPoint: 2,
  }

  it('combines all five VP sources per player into one breakdown, with a correct total', () => {
    const breakdown = calculateVPBreakdown(baseState(), content)

    expect(breakdown.p1).toEqual({ achievements: 3, boardCount: 2, terrainControl: 2, gold: 2, controllableStructures: 0, total: 9 })
  })

  it('includes a player who scored 0 on every source, unlike the individual calculate*VP functions', () => {
    const breakdown = calculateVPBreakdown(baseState(), content)

    expect(breakdown.p2).toEqual({ achievements: 0, boardCount: 0, terrainControl: 0, gold: 0, controllableStructures: 0, total: 0 })
  })

  it('includes every player in state.players even with no achievement/terrain/unit/gold content supplied', () => {
    const breakdown = calculateVPBreakdown(baseState(), EMPTY_ACHIEVEMENT_CONTENT)

    expect(breakdown).toEqual({
      p1: { achievements: 0, boardCount: 0, terrainControl: 0, gold: 0, controllableStructures: 0, total: 0 },
      p2: { achievements: 0, boardCount: 0, terrainControl: 0, gold: 0, controllableStructures: 0, total: 0 },
    })
  })

  it("adds a Tale controllable structure's VP to whoever controls it, via taleContent", () => {
    const state = { ...baseState(), units: [...baseState().units, unitAt('p1', 'cathedral', { q: 5, r: 5 })] }
    const taleContent = { ...EMPTY_TALE_CONTENT, controllableStructures: [{ kind: 'cathedral', name: 'The Cathedral', victoryPoints: 15 }] }

    const breakdown = calculateVPBreakdown(state, content, taleContent)

    expect(breakdown.p1.controllableStructures).toBe(15)
    expect(breakdown.p1.total).toBe(9 + 15)
    expect(breakdown.p2.controllableStructures).toBe(0)
  })

  describe('calculateVPDetail', () => {
    it('itemizes each of the five VP sources — what the player has, and the points it is worth — with a total matching calculateVPBreakdown', () => {
      const state = baseState()
      const detail = calculateVPDetail(state, content)

      // p1: city-mastery claimed (3 VP) + 2 Cities on board (curve [1,2] at
      // count 2 -> 2 VP) + a 2-hex water region majority (1 VP/hex -> 2 VP)
      // + 5 gold at 2 gold/point -> 2 VP = 9 total, matching
      // calculateVPBreakdown's p1.total for this same fixture.
      expect(detail.p1).toEqual({
        achievements: [{ achievementId: 'city-mastery', vp: 3 }],
        boardCount: [{ kind: 'city', count: 2, vp: 2 }],
        terrainControl: [{ terrain: 'water', hexCount: 2, vp: 2 }],
        gold: { amount: 5, vp: 2 },
        controllableStructures: [],
        total: 9,
      })
      expect(detail.p1.total).toBe(calculateVPBreakdown(state, content).p1.total)
    })

    it('gives a player with nothing on every source empty lists, a 0-VP gold entry, and a 0 total', () => {
      const detail = calculateVPDetail(baseState(), content)

      expect(detail.p2).toEqual({
        achievements: [],
        boardCount: [],
        terrainControl: [],
        gold: { amount: 0, vp: 0 },
        controllableStructures: [],
        total: 0,
      })
    })

    it("itemizes a Tale controllable structure the player controls", () => {
      const state = { ...baseState(), units: [...baseState().units, unitAt('p1', 'cathedral', { q: 5, r: 5 })] }
      const taleContent = { ...EMPTY_TALE_CONTENT, controllableStructures: [{ kind: 'cathedral', name: 'The Cathedral', victoryPoints: 15 }] }

      const detail = calculateVPDetail(state, content, taleContent)

      expect(detail.p1.controllableStructures).toEqual([{ kind: 'cathedral', name: 'The Cathedral', vp: 15 }])
      expect(detail.p1.total).toBe(9 + 15)
    })
  })
})
