import { describe, expect, it } from 'vitest'
import type { AchievementContent } from '../achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../achievementContent'
import { applyAction } from '../applyAction'
import { createEmptyBoard } from '../board'
import { cardIdFor, moveCard, UNIT_KINDS } from '../cards'
import { createNewGame } from '../createGame'
import { finishRound } from '../round'
import type { GameState, Unit } from '../types'
import type { UnitContent } from '../unitContent'

// These round-flow tests are about phase/turn sequencing, not action
// outcomes (see unitActions.test.ts for those) — nobody here ever
// resolves a real unit action, so this only exists as a harmless filler
// wherever applyAction's positional unitContent arg needs *something* to
// reach a later achievementContent arg.
const testUnitContent: UnitContent = {
  actionsByKind: {
    city: [{ id: 'generate-income', name: 'Generate Income', description: '', effect: { actionType: 'income', goldByTerrain: {} } }],
  },
  movementByKind: {},
  terrainLevels: {},
  resourceCaps: {},
  unitSupplyCaps: {},
  companionKindsByCardKind: {},
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

    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // No units are anywhere near the placeholder limit, so decline is
    // skipped; neither player has anything in decline either, so the
    // purchase phase auto-completes right here (see
    // skipEmptyDeclinePurchasers in ../round.ts) — no PASS_PURCHASE needed.
    expect(result.state.turn).toBe(1)
    expect(result.state.roundPhase).toBe('selectCards')
    expect(result.state.pendingPlayerIds).toEqual(['p1', 'p2'])
    expect(result.state.activePlayerId).toBeNull()
    const p1After = result.state.players.find((p) => p.id === 'p1')!
    expect(p1After.discardCardIds).toContain(p1City)
  })

  it('purchase phase auto-skips a player with nothing in decline, but still waits on one who has something', () => {
    // turnOrder is [p1, p2]; giving p2 (not p1) the decline card means the
    // phase must skip past p1 automatically before landing on p2.
    let state = makeActiveGameWithFullHands()
    const p2Index = state.players.findIndex((p) => p.id === 'p2')
    const p2 = moveCard(state.players[p2Index], cardIdFor('p2', 'temple'), 'decline')
    const players = [...state.players]
    players[p2Index] = p2
    state = { ...state, players }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // p1 was auto-skipped (nothing in decline); p2 has something, so the
    // phase waits on them instead of auto-completing straight through.
    expect(result.state.roundPhase).toBe('purchase')
    expect(result.state.activePlayerId).toBe('p2')
    expect(result.state.pendingPlayerIds).toEqual(['p2'])

    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // p2 passing empties the queue -> round ends normally.
    expect(result.state.roundPhase).toBe('selectCards')
    expect(result.state.turn).toBe(1)
  })

  it('inserts a decline phase when an achievement was claimed this round, then returns to purchase', () => {
    const base = makeActiveGameWithFullHands()
    const state = { ...base, achievementsClaimedThisRound: 1 }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
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
    const base = makeActiveGameWithFullHands()
    const state = { ...base, achievementsClaimedThisRound: 1 }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
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
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
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
    // p1 needs *something* in decline, or the purchase phase auto-skips
    // them entirely (see skipEmptyDeclinePurchasers in ../round.ts) before
    // they'd ever get a chance to submit this rejected request.
    let state = makeActiveGameWithFullHands()
    const p1Index = state.players.findIndex((p) => p.id === 'p1')
    const p1 = moveCard(state.players[p1Index], cardIdFor('p1', 'nomad'), 'decline')
    const players = [...state.players]
    players[p1Index] = p1
    state = { ...state, players }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('purchase')

    // p1's decline holds 'nomad', not 'temple'.
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
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
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

  it("purchase phase auto-skips a player who has something in decline but can't afford the buyback price, same as an empty decline", () => {
    // p1 has a card in decline but no gold; p2 has both something in
    // decline and enough gold, so the phase must skip past p1 and land on
    // p2 without requiring a PASS_PURCHASE from p1.
    let state = makeActiveGameWithFullHands()
    const p1Index = state.players.findIndex((p) => p.id === 'p1')
    const p2Index = state.players.findIndex((p) => p.id === 'p2')
    let p1 = { ...state.players[p1Index], resources: { gold: 0, wood: 0, stone: 0 } }
    p1 = moveCard(p1, cardIdFor('p1', 'temple'), 'decline')
    let p2 = { ...state.players[p2Index], resources: { gold: 100, wood: 0, stone: 0 } }
    p2 = moveCard(p2, cardIdFor('p2', 'temple'), 'decline')
    const players = [...state.players]
    players[p1Index] = p1
    players[p2Index] = p2
    // 1 achievement already claimed, so the cost table below actually prices the buyback.
    state = { ...state, players, claimedByAchievementId: { 'city-mastery': 'p2' } }

    const achievementContent: AchievementContent = { ...EMPTY_ACHIEVEMENT_CONTENT, purchaseCostTable: [5] }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, testUnitContent, achievementContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }, testUnitContent, achievementContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' }, testUnitContent, achievementContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' }, testUnitContent, achievementContent)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // p1 was auto-skipped (5 gold buyback, only 0 gold) — the game just
    // continues to whoever can actually act, same as the empty-decline case.
    expect(result.state.roundPhase).toBe('purchase')
    expect(result.state.activePlayerId).toBe('p2')
    expect(result.state.pendingPlayerIds).toEqual(['p2'])

    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p2' }, testUnitContent, achievementContent)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // p2 passing empties the queue -> round ends normally.
    expect(result.state.roundPhase).toBe('selectCards')
    expect(result.state.turn).toBe(1)
  })

  it('requires each player to decline achievementsClaimedThisRound cards (min 1) before advancing', () => {
    const base = makeActiveGameWithFullHands()
    const state = { ...base, achievementsClaimedThisRound: 2 }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
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

  it('eliminates a player who owes more decline cards than they have, even after declining everything they could', () => {
    // p1 is left with only one card total (city) -- everything else moved
    // out to supply -- but owes two (2 achievements claimed this round).
    // Playing + declining that one card (it ends up in discard after
    // PASS_ACTIONS, per finishActionsTurn) fully uses up what's available;
    // they still can't meet the second required card, so they're
    // eliminated for the unmeetable remainder.
    let state = makeActiveGameWithFullHands()
    const p1Index = state.players.findIndex((p) => p.id === 'p1')
    let p1 = state.players[p1Index]
    const onlyCard = cardIdFor('p1', 'city')
    for (const cardId of p1.handCardIds.filter((id) => id !== onlyCard)) {
      p1 = moveCard(p1, cardId, 'supply')
    }
    const players = [...state.players]
    players[p1Index] = p1
    state = { ...state, players, achievementsClaimedThisRound: 2 }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: onlyCard })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('decline')
    // p1 owes 2, has exactly 1 available (onlyCard, now in discard) -> still shows up twice up front.
    expect(result.state.pendingPlayerIds).toEqual(expect.arrayContaining(['p1', 'p1']))

    result = applyAction(result.state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: onlyCard })
    if (!result.ok) throw new Error('setup failed')

    const p1After = result.state.players.find((p) => p.id === 'p1')!
    expect(p1After.eliminated).toBe(true)
    expect(p1After.declineCardIds).toEqual([onlyCard])
    // p1 no longer appears in pendingPlayerIds -- eliminated players drop out immediately.
    expect(result.state.pendingPlayerIds).not.toContain('p1')
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
    const achievementContent: AchievementContent = {
      ...EMPTY_ACHIEVEMENT_CONTENT,
      gameLength: 3,
      achievementVictoryPoints: { 'city-mastery': 1, 'temple-mastery': 1, 'nomad-mastery': 1 },
    }

    // Neither player has anything in decline, so PASS_ACTIONS (nothing was
    // individually resolved via RESOLVE_UNIT_ACTION first) walks straight
    // through the purchase phase and the game-end check that finishes it —
    // achievementContent must be passed here to reach that check.
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' }, testUnitContent, achievementContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' }, testUnitContent, achievementContent)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.status).toBe('completed')
    // p1 has 2 achievement VP (city + temple mastery) vs. p2's 1 (nomad mastery) -> p1 wins outright.
    expect(result.state.winnerPlayerIds).toEqual(['p1'])
    // The game-ending round never restarts select-cards.
    expect(result.state.roundPhase).toBe('purchase')
  })

  it('counts gold toward the end-of-game VP total (bug: gold was not counted as part of the victory point display/total at all)', () => {
    let state = makeActiveGameWithFullHands()
    state = {
      ...state,
      claimedByAchievementId: { 'city-mastery': 'p1', 'nomad-mastery': 'p2' },
      players: state.players.map((p) =>
        p.id === 'p1' ? { ...p, resources: { gold: 0, wood: 0, stone: 0 } } : { ...p, resources: { gold: 10, wood: 0, stone: 0 } },
      ),
    }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    const achievementContent: AchievementContent = {
      ...EMPTY_ACHIEVEMENT_CONTENT,
      gameLength: 2,
      achievementVictoryPoints: { 'city-mastery': 1, 'nomad-mastery': 1 },
      goldPerVictoryPoint: 2,
    }

    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' }, testUnitContent, achievementContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' }, testUnitContent, achievementContent)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.status).toBe('completed')
    // Achievement VP alone ties p1 and p2 at 1 each, but p2's 10 gold at
    // 2 gold/point is worth 5 more VP (p1's 0 gold is worth 0) -> p2 wins
    // outright, which only happens if gold actually got counted.
    expect(result.state.winnerPlayerIds).toEqual(['p2'])
  })

  it('does not eliminate a player who finishes the game with an empty hand', () => {
    // A player's hand can legitimately empty out (everything played or
    // discarded) in the very round that reaches gameLength. finishRound
    // checks the game-end condition before ever chaining into the next
    // round's beginSelectCardsPhase (see round.ts), which is the only place
    // an empty hand would normally trigger elimination — so this must not
    // eliminate them, no matter how few cards they end up with.
    let state = makeActiveGameWithFullHands()
    const p1Index = state.players.findIndex((p) => p.id === 'p1')
    let p1 = state.players[p1Index]
    for (const cardId of [...p1.handCardIds, ...p1.discardCardIds]) {
      p1 = moveCard(p1, cardId, 'supply')
    }
    const players = [...state.players]
    players[p1Index] = p1
    state = { ...state, players, claimedByAchievementId: { 'city-mastery': 'p1' } }

    const achievementContent: AchievementContent = { ...EMPTY_ACHIEVEMENT_CONTENT, gameLength: 1 }
    const result = finishRound(state, achievementContent)

    expect(result.status).toBe('completed')
    const p1After = result.players.find((p) => p.id === 'p1')!
    expect(p1After.handCardIds).toHaveLength(0)
    expect(p1After.eliminated).toBe(false)
  })

  it('does not end the game below gameLength, even with achievements already claimed', () => {
    let state = makeActiveGameWithFullHands()
    state = { ...state, claimedByAchievementId: { 'city-mastery': 'p1' } }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')

    const achievementContent: AchievementContent = { ...EMPTY_ACHIEVEMENT_CONTENT, gameLength: 4 }
    // Neither player has anything in decline, so PASS_ACTIONS walks
    // straight through the purchase phase — the below-gameLength check
    // needs achievementContent passed here to reach it.
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' }, testUnitContent, achievementContent)
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' }, testUnitContent, achievementContent)
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
    // Keep a card for a kind p1 actually has a unit for (Ship, seeded by
    // makeActiveGameWithFullHands) — using the City card here would trip
    // the exact bug #21 fixes: p1 has no City unit in this fixture, so a
    // recycled City card should land back in supply, not hand.
    const keepCardId = cardIdFor('p1', 'ship')
    const restCardIds = p1.handCardIds.filter((id) => id !== keepCardId)
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
    // Neither player has anything in decline, so PASS_ACTIONS walks
    // straight through the purchase phase — no PASS_PURCHASE needed.
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
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
    // Neither player has anything in decline, so PASS_ACTIONS walks
    // straight through the purchase phase — no PASS_PURCHASE needed.
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.turnOrder).toEqual(['p1', 'p2'])
  })
})

describe('finishRound re-syncs recycled cards against the board (rule 5/6 + rule 10/11 interaction)', () => {
  // Reproduces the reported bug: a player's hand empties out at round end
  // (rule 10) while their discard still holds a card for a unit kind they
  // no longer have any units of (e.g. it was played earlier the same round,
  // and that unit was lost/transformed away in between). The blind
  // discard -> hand recycle (rule 11) used to deal it straight back into
  // hand as a choosable option next round, even though rule 5/6 says a
  // card with no backing unit belongs in supply. finishRound must re-sync
  // against the board after recycling, not just move discard verbatim.
  it("recycles a card for a kind the player still has units of into hand, but sends one for a kind they don't back to supply", () => {
    // p1/p2 have real units for every non-City kind (temple, nomad,
    // merchant, mountaineer, ship — see makeActiveGameWithFullHands) but
    // neither has a City unit.
    let state = makeActiveGameWithFullHands()
    const p1Index = state.players.findIndex((p) => p.id === 'p1')
    let p1 = state.players[p1Index]
    // Simulate: p1 played their City card earlier this round (now sitting
    // in discard, per rule 3/4), and everything else in hand got played
    // too, leaving hand empty going into round-end.
    for (const cardId of [...p1.handCardIds]) {
      p1 = moveCard(p1, cardId, 'discard')
    }
    const players = [...state.players]
    players[p1Index] = p1
    state = { ...state, players }

    const result = finishRound(state)

    const p1After = result.players.find((p) => p.id === 'p1')!
    expect(p1After.discardCardIds).toHaveLength(0)
    // City: no unit backing it -> supply, never dealt into hand.
    expect(p1After.supplyCardIds).toContain(cardIdFor('p1', 'city'))
    expect(p1After.handCardIds).not.toContain(cardIdFor('p1', 'city'))
    // Ship (and every other kind p1 actually has a unit of): recycled into
    // hand as normal.
    expect(p1After.handCardIds).toContain(cardIdFor('p1', 'ship'))
    expect(p1After.handCardIds).toContain(cardIdFor('p1', 'temple'))
    expect(p1After.handCardIds).toContain(cardIdFor('p1', 'nomad'))
    expect(p1After.handCardIds).toContain(cardIdFor('p1', 'merchant'))
    expect(p1After.handCardIds).toContain(cardIdFor('p1', 'mountaineer'))
  })
})
