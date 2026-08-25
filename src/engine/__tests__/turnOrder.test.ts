import { describe, expect, it } from 'vitest'
import { createEmptyBoard } from '../board'
import { currentActorId, pendingActorIds } from '../turnOrder'
import type { GameState } from '../types'

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
    resolvedUnitIdsThisTurn: [],
    unitsCreatedThisTurn: [],
    turnOrder: ['p1', 'p2'],
    board: createEmptyBoard('hex'),
    players: [],
    units: [],
    cards: {},
    resourceBank: { gold: 0, wood: 0, stone: 0 },
    activeTaleIds: [],
    gameLength: Infinity,
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
    ...overrides,
  }
}

describe('currentActorId', () => {
  it('returns the tile placer during boardSetup tile placement', () => {
    const state = makeState({
      status: 'boardSetup',
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 2, tilePlacerIndex: 1, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    })
    expect(currentActorId(state)).toBe('p2')
  })

  it('returns the unit placer during boardSetup unit placement (tile queue empty)', () => {
    const state = makeState({
      status: 'boardSetup',
      boardSetup: {
        tileTierQueue: [],
        tilesRemainingInTier: 0,
        tilePlacerIndex: 0,
        unitsRemainingByPlayerId: { p1: ['city'], p2: ['city', 'nomad', 'ship'] },
        unitPlacerIndex: 1,
      },
    })
    expect(currentActorId(state)).toBe('p2')
  })

  it('returns pendingPlayerIds[0] for any active-status phase', () => {
    const state = makeState({ status: 'active', roundPhase: 'decline', pendingPlayerIds: ['p2', 'p1'] })
    expect(currentActorId(state)).toBe('p2')
  })

  it('falls back to activePlayerId when pendingPlayerIds is empty', () => {
    const state = makeState({ status: 'active', pendingPlayerIds: [], activePlayerId: 'p1' })
    expect(currentActorId(state)).toBe('p1')
  })

  it('returns null when nobody is pending in an active-status phase', () => {
    const state = makeState({ status: 'active', pendingPlayerIds: [], activePlayerId: null })
    expect(currentActorId(state)).toBeNull()
  })

  it('returns null for lobby/completed statuses', () => {
    expect(currentActorId(makeState({ status: 'lobby' }))).toBeNull()
    expect(currentActorId(makeState({ status: 'completed' }))).toBeNull()
  })
})

describe('pendingActorIds', () => {
  it('returns only the active player during the turn-order actions phase, not the rest of the round queue', () => {
    // pendingPlayerIds still holds every player who hasn't taken their turn
    // this round yet ('p1' included, since they go last) — only 'p2' (the
    // head of the queue / activePlayerId) is actually up right now.
    const state = makeState({
      status: 'active',
      roundPhase: 'actions',
      pendingPlayerIds: ['p2', 'p1'],
      activePlayerId: 'p2',
    })
    expect(pendingActorIds(state)).toEqual(['p2'])
  })

  it('returns only the active player during the turn-order purchase phase', () => {
    const state = makeState({
      status: 'active',
      roundPhase: 'purchase',
      pendingPlayerIds: ['p2', 'p1'],
      activePlayerId: 'p2',
    })
    expect(pendingActorIds(state)).toEqual(['p2'])
  })

  it('returns every pending player during the simultaneous selectCards phase', () => {
    const state = makeState({
      status: 'active',
      roundPhase: 'selectCards',
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: null,
    })
    expect(pendingActorIds(state)).toEqual(['p1', 'p2'])
  })

  it('returns every pending player during the simultaneous decline phase', () => {
    const state = makeState({
      status: 'active',
      roundPhase: 'decline',
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: null,
    })
    expect(pendingActorIds(state)).toEqual(['p1', 'p2'])
  })
})
