import { describe, expect, it } from 'vitest'
import type { AchievementContent } from '../achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../achievementContent'
import { applyAction } from '../applyAction'
import { createEmptyBoard } from '../board'
import { cardIdFor, moveCard, UNIT_KINDS } from '../cards'
import { createNewGame } from '../createGame'
import { getUnitLimit } from '../decline'
import type { GameState, Unit } from '../types'
import type { UnitContent } from '../unitContent'

function makeUnit(ownerId: string, kind: string, id: string): Unit {
  return {
    id,
    ownerId,
    kind,
    coord: { q: 0, r: 0 },
    movement: { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }
}

// Just enough content to let RESOLVE_UNIT_ACTION resolve a City's card in
// these round-flow tests — the effect itself (income with no terrain set)
// is a harmless no-op here, since these tests are about phase/turn
// sequencing, not action outcomes (see unitActions.test.ts for those).
const testUnitContent: UnitContent = {
  actionsByKind: {
    city: [{ id: 'generate-income', name: 'Generate Income', description: '', effect: { actionType: 'income', goldByTerrain: {} } }],
  },
  movementByKind: {},
  terrainLevels: {},
  resourceCaps: {},
  unitSupplyCaps: {},
}

/**
 * An active game with p1/p2 each holding their full six-card hand, to
 * drive the round loop directly. Seeds one real unit per non-City kind for
 * each player (well away from {0,0}, where individual tests place their
 * own City units) so syncCardZonesWithBoard — now run after every resolved
 * action — has a real unit backing each of those cards and leaves them in
 * hand; City is deliberately left to each test to set up (or not).
 */
function makeActiveGameWithFullHands(): GameState {
  const state = createNewGame({
    gameId: 'game_1',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
    ],
  })

  const players = state.players.map((player) => {
    let next = player
    for (const cardId of player.supplyCardIds) {
      next = moveCard(next, cardId, 'hand')
    }
    return next
  })

  const units: Unit[] = state.players.flatMap((player, playerIndex) =>
    UNIT_KINDS.filter((kind) => kind !== 'city').map((kind, kindIndex) => ({
      id: `${player.id}_seed_${kind}`,
      ownerId: player.id,
      kind,
      coord: { q: 100 + kindIndex, r: 100 + playerIndex },
      movement: { isMobile: false, terrains: [], canCrossCliffs: false },
      traits: [],
    })),
  )

  return { ...state, status: 'active', players, units }
}

describe('round flow', () => {
  it('runs select -> actions -> purchase -> next round when no decline is triggered', () => {
    const state = makeActiveGameWithFullHands()
    const p1City = cardIdFor('p1', 'city')
    const p2City = cardIdFor('p2', 'city')

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: p1City })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: p2City })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.roundPhase).toBe('actions')
    expect(result.state.activePlayerId).toBe('p1')

    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // No units are anywhere near the placeholder limit, so decline is skipped.
    expect(result.state.roundPhase).toBe('purchase')

    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.turn).toBe(1)
    expect(result.state.roundPhase).toBe('selectCards')
    expect(result.state.pendingPlayerIds).toEqual(['p1', 'p2'])
    expect(result.state.activePlayerId).toBeNull()
    const p1After = result.state.players.find((p) => p.id === 'p1')!
    expect(p1After.discardCardIds).toContain(p1City)
  })

  it('inserts a decline phase when a player reaches their unit limit, then returns to purchase', () => {
    const unitLimits = { city: 2 }
    const cityUnits: Unit[] = Array.from({ length: unitLimits.city }, (_, i) => makeUnit('p1', 'city', `p1_city_${i}`))
    const base = makeActiveGameWithFullHands()
    const state = { ...base, units: [...base.units, ...cityUnits], unitLimits }
    expect(getUnitLimit(state, 'city')).toBe(2)

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.roundPhase).toBe('decline')
    expect(result.state.pendingPlayerIds).toEqual(['p1', 'p2'])
    // Decline is simultaneous (like select-cards), not turn order.
    expect(result.state.activePlayerId).toBeNull()

    result = applyAction(result.state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: cardIdFor('p1', 'temple') })
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('decline')
    result = applyAction(result.state, { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: cardIdFor('p2', 'temple') })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.roundPhase).toBe('purchase')
    const p1After = result.state.players.find((p) => p.id === 'p1')!
    expect(p1After.declineCardIds).toContain(cardIdFor('p1', 'temple'))
  })

  it('rejects moving a card to decline that is not in hand or discard', () => {
    const unitLimits = { city: 2 }
    const cityUnits: Unit[] = Array.from({ length: unitLimits.city }, (_, i) => makeUnit('p1', 'city', `p1_city_${i}`))
    const base = makeActiveGameWithFullHands()
    const state = { ...base, units: [...base.units, ...cityUnits], unitLimits }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('decline')

    const bogus = applyAction(result.state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: 'not-a-real-card' })
    expect(bogus.ok).toBe(false)
  })

  it('rejects MOVE_TO_DECLINE outside the decline phase', () => {
    const state = makeActiveGameWithFullHands()
    const result = applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(result.ok).toBe(false)
  })

  it('purchases a card back from decline, paying gold that scales with achievements claimed so far', () => {
    let state = makeActiveGameWithFullHands()
    const p1Index = state.players.findIndex((p) => p.id === 'p1')
    let p1 = { ...state.players[p1Index], resources: { gold: 100, wood: 0, stone: 0 } }
    p1 = moveCard(p1, cardIdFor('p1', 'temple'), 'decline')
    const players = [...state.players]
    players[p1Index] = p1
    state = { ...state, players, claimedByAchievementId: { 'city-mastery': 'p2' } }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('purchase')

    const achievementContent: AchievementContent = { ...EMPTY_ACHIEVEMENT_CONTENT, purchaseCostTable: [5, 10, 20] }
    const purchase = applyAction(
      result.state,
      { type: 'PURCHASE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'temple') },
      testUnitContent,
      achievementContent,
    )
    expect(purchase.ok).toBe(true)
    if (!purchase.ok) return

    // 1 achievement already claimed -> costTable[0] = 5 gold.
    const p1After = purchase.state.players.find((p) => p.id === 'p1')!
    expect(p1After.resources.gold).toBe(95)
    expect(p1After.declineCardIds).not.toContain(cardIdFor('p1', 'temple'))
    expect(p1After.handCardIds).toContain(cardIdFor('p1', 'temple'))
  })

  it('rejects PURCHASE_CARD for a card not in that player\'s decline', () => {
    const state = makeActiveGameWithFullHands()
    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('purchase')

    const purchase = applyAction(result.state, { type: 'PURCHASE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'temple') })
    expect(purchase.ok).toBe(false)
    if (!purchase.ok) {
      expect(purchase.error).toContain('decline')
    }
  })

  it('rejects PURCHASE_CARD when the player cannot afford the cost', () => {
    let state = makeActiveGameWithFullHands()
    const p1Index = state.players.findIndex((p) => p.id === 'p1')
    let p1 = { ...state.players[p1Index], resources: { gold: 0, wood: 0, stone: 0 } }
    p1 = moveCard(p1, cardIdFor('p1', 'temple'), 'decline')
    const players = [...state.players]
    players[p1Index] = p1
    // 1 achievement already claimed, so the cost table is actually priced (not the free "0 claimed" case).
    state = { ...state, players, claimedByAchievementId: { 'city-mastery': 'p2' } }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('purchase')

    const achievementContent: AchievementContent = { ...EMPTY_ACHIEVEMENT_CONTENT, purchaseCostTable: [5] }
    const purchase = applyAction(
      result.state,
      { type: 'PURCHASE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'temple') },
      testUnitContent,
      achievementContent,
    )
    expect(purchase.ok).toBe(false)
    if (!purchase.ok) {
      expect(purchase.error).toContain('Not enough gold')
    }
  })

  it('requires each player to decline achievementsClaimedThisRound cards (min 1) before advancing', () => {
    const unitLimits = { city: 2 }
    const cityUnits: Unit[] = Array.from({ length: unitLimits.city }, (_, i) => makeUnit('p1', 'city', `p1_city_${i}`))
    const base = makeActiveGameWithFullHands()
    const state = { ...base, units: [...base.units, ...cityUnits], unitLimits, achievementsClaimedThisRound: 2 }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('decline')
    // 2 achievements claimed this round -> each player owes 2 cards, so p1's id appears twice up front.
    expect(result.state.pendingPlayerIds).toEqual(['p1', 'p1', 'p2', 'p2'])
    // Decline is simultaneous — nobody is "up" in particular.
    expect(result.state.activePlayerId).toBeNull()

    // p2 goes first here, and out of order relative to p1's two declines — simultaneous means either can act at any time.
    result = applyAction(result.state, { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: cardIdFor('p2', 'temple') })
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('decline')
    expect(result.state.pendingPlayerIds).toEqual(['p1', 'p1', 'p2'])

    result = applyAction(result.state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: cardIdFor('p1', 'temple') })
    if (!result.ok) throw new Error('setup failed')
    // p1 still owes a second card — declining once doesn't drop them from pendingPlayerIds.
    expect(result.state.roundPhase).toBe('decline')
    expect(result.state.pendingPlayerIds).toEqual(['p1', 'p2'])

    result = applyAction(result.state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') })
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.pendingPlayerIds).toEqual(['p2'])

    result = applyAction(result.state, { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: cardIdFor('p2', 'nomad') })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.roundPhase).toBe('purchase')
    const p1After = result.state.players.find((p) => p.id === 'p1')!
    expect(p1After.declineCardIds).toEqual(expect.arrayContaining([cardIdFor('p1', 'temple'), cardIdFor('p1', 'nomad')]))
  })

  it('ends the game once gameLength achievements are claimed, crowning the highest-VP player(s)', () => {
    let state = makeActiveGameWithFullHands()
    state = {
      ...state,
      claimedByAchievementId: { 'city-mastery': 'p1', 'temple-mastery': 'p1', 'nomad-mastery': 'p2' },
    }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('purchase')

    const achievementContent: AchievementContent = {
      ...EMPTY_ACHIEVEMENT_CONTENT,
      gameLength: 3,
      achievementVictoryPoints: { 'city-mastery': 1, 'temple-mastery': 1, 'nomad-mastery': 1 },
    }

    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p1' }, testUnitContent, achievementContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p2' }, testUnitContent, achievementContent)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.status).toBe('completed')
    // p1 has 2 achievement VP (city + temple mastery) vs. p2's 1 (nomad mastery) -> p1 wins outright.
    expect(result.state.winnerPlayerIds).toEqual(['p1'])
    // The game-ending round never restarts select-cards.
    expect(result.state.roundPhase).toBe('purchase')
  })

  it('does not end the game below gameLength, even with achievements already claimed', () => {
    let state = makeActiveGameWithFullHands()
    state = { ...state, claimedByAchievementId: { 'city-mastery': 'p1' } }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')

    const achievementContent: AchievementContent = { ...EMPTY_ACHIEVEMENT_CONTENT, gameLength: 4 }
    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p1' }, testUnitContent, achievementContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p2' }, testUnitContent, achievementContent)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.status).toBe('active')
    expect(result.state.roundPhase).toBe('selectCards')
    expect(result.state.turn).toBe(1)
  })

  it('recycles an emptied hand and hands first-player to the next player at round end (rules 10 & 11)', () => {
    let state = makeActiveGameWithFullHands()
    const p1Index = state.players.findIndex((p) => p.id === 'p1')
    let p1 = state.players[p1Index]
    const [keepCardId, ...restCardIds] = [...p1.handCardIds]
    for (const cardId of restCardIds) {
      p1 = moveCard(p1, cardId, 'discard')
    }
    const players = [...state.players]
    players[p1Index] = p1
    state = { ...state, players }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: keepCardId })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('purchase')

    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const p1After = result.state.players.find((p) => p.id === 'p1')!
    expect(p1After.discardCardIds).toHaveLength(0)
    expect(p1After.handCardIds).toContain(keepCardId)
    expect(p1After.handCardIds.length).toBeGreaterThan(1)
    expect(result.state.turnOrder[0]).toBe('p2')
  })

  it('does not rotate first player when nobody recycled', () => {
    const state = makeActiveGameWithFullHands()
    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, testUnitContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.turnOrder).toEqual(['p1', 'p2'])
  })
})
