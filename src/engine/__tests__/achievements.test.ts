import { describe, expect, it } from 'vitest'
import type { AchievementContent } from '../achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../achievementContent'
import { updateAchievementClaims } from '../achievements'
import { createEmptyBoard } from '../board'
import type { Coordinate, GameState, Player, Unit } from '../types'

function makePlayer(id: string, overrides: Partial<Player> = {}): Player {
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
    resources: { gold: 0, wood: 0, stone: 0 },
    ...overrides,
  }
}

let unitCounter = 0
function makeUnit(ownerId: string, kind: string, coord: Coordinate = { q: 0, r: 0 }): Unit {
  unitCounter += 1
  return {
    id: `unit_${unitCounter}`,
    ownerId,
    kind,
    coord,
    movement: { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: 'g1',
    playMode: 'hotseat',
    status: 'active',
    turn: 1,
    activePlayerId: null,
    roundPhase: 'actions',
    chosenCardIdByPlayerId: {},
    pendingPlayerIds: [],
    turnOrder: ['p1', 'p2'],
    board: createEmptyBoard('hex'),
    players: [makePlayer('p1'), makePlayer('p2')],
    units: [],
    cards: {},
    resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
    unitLimits: {},
    log: [],
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
    ...overrides,
  }
}

const content: AchievementContent = {
  ...EMPTY_ACHIEVEMENT_CONTENT,
  unitKindByAchievementId: { 'city-mastery': 'city', 'temple-mastery': 'temple' },
}

const unitSupplyCaps = { city: 2, temple: 3 }

describe('updateAchievementClaims', () => {
  it('claims an achievement for a player who reaches the full per-player supply of its unit kind', () => {
    const state = makeState({ units: [makeUnit('p1', 'city'), makeUnit('p1', 'city')] })

    const next = updateAchievementClaims(state, content, unitSupplyCaps)

    expect(next.claimedByAchievementId['city-mastery']).toBe('p1')
    expect(next.achievementsClaimedThisRound).toBe(1)
  })

  it('does not claim one unit short of the cap', () => {
    const state = makeState({ units: [makeUnit('p1', 'city')] })

    const next = updateAchievementClaims(state, content, unitSupplyCaps)

    expect(next.claimedByAchievementId['city-mastery']).toBeUndefined()
    expect(next.achievementsClaimedThisRound).toBe(0)
  })

  it('claims multiple achievements in one call if more than one kind is at cap', () => {
    const state = makeState({
      units: [makeUnit('p1', 'city'), makeUnit('p1', 'city'), makeUnit('p2', 'temple'), makeUnit('p2', 'temple'), makeUnit('p2', 'temple')],
    })

    const next = updateAchievementClaims(state, content, unitSupplyCaps)

    expect(next.claimedByAchievementId).toEqual({ 'city-mastery': 'p1', 'temple-mastery': 'p2' })
    expect(next.achievementsClaimedThisRound).toBe(2)
  })

  it('is sticky: an already-claimed achievement is never reassigned, even to a player also at cap', () => {
    const state = makeState({
      claimedByAchievementId: { 'city-mastery': 'p1' },
      units: [makeUnit('p1', 'city'), makeUnit('p2', 'city'), makeUnit('p2', 'city')],
    })

    const next = updateAchievementClaims(state, content, unitSupplyCaps)

    expect(next.claimedByAchievementId['city-mastery']).toBe('p1')
    expect(next.achievementsClaimedThisRound).toBe(0)
  })

  it('accumulates onto an existing achievementsClaimedThisRound count rather than resetting it', () => {
    const state = makeState({ achievementsClaimedThisRound: 1, units: [makeUnit('p1', 'city'), makeUnit('p1', 'city')] })

    const next = updateAchievementClaims(state, content, unitSupplyCaps)

    expect(next.achievementsClaimedThisRound).toBe(2)
  })

  it('skips a kind missing from unitSupplyCaps', () => {
    const state = makeState({ units: [makeUnit('p1', 'city'), makeUnit('p1', 'city')] })

    const next = updateAchievementClaims(state, content, {})

    expect(next.claimedByAchievementId).toEqual({})
  })

  it('does not let an eliminated player claim, even if they still count units at cap', () => {
    const state = makeState({
      players: [makePlayer('p1', { eliminated: true }), makePlayer('p2')],
      units: [makeUnit('p1', 'city'), makeUnit('p1', 'city')],
    })

    const next = updateAchievementClaims(state, content, unitSupplyCaps)

    expect(next.claimedByAchievementId['city-mastery']).toBeUndefined()
  })

  it('is a no-op when unitKindByAchievementId is empty (default content)', () => {
    const state = makeState({ units: [makeUnit('p1', 'city'), makeUnit('p1', 'city')] })

    const next = updateAchievementClaims(state, EMPTY_ACHIEVEMENT_CONTENT, unitSupplyCaps)

    expect(next).toBe(state)
  })

  it('logs the claim', () => {
    const state = makeState({ units: [makeUnit('p1', 'city'), makeUnit('p1', 'city')] })

    const next = updateAchievementClaims(state, content, unitSupplyCaps)

    expect(next.log.some((e) => e.message.includes('mastery achievement'))).toBe(true)
  })
})
