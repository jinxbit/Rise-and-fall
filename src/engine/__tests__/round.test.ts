import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard } from '../board'
import { cardIdFor, moveCard } from '../cards'
import { createNewGame } from '../createGame'
import { getUnitLimit } from '../decline'
import type { GameState, Unit } from '../types'

function makeUnit(ownerId: string, kind: string, id: string): Unit {
  return {
    id,
    ownerId,
    kind,
    coord: { q: 0, r: 0 },
    movement: { domains: [], canTraverseCliffs: false, range: 0 },
    traits: [],
  }
}

/** An active game with p1/p2 each holding their full six-card hand, to drive the round loop directly. */
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

  return { ...state, status: 'active', players }
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

    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2' })
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
    const limit = getUnitLimit('city')
    const units: Unit[] = Array.from({ length: limit }, (_, i) => makeUnit('p1', 'city', `p1_city_${i}`))
    const state = { ...makeActiveGameWithFullHands(), units }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.roundPhase).toBe('decline')
    expect(result.state.pendingPlayerIds).toEqual(['p1', 'p2'])
    expect(result.state.activePlayerId).toBe('p1')

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
    const limit = getUnitLimit('city')
    const units: Unit[] = Array.from({ length: limit }, (_, i) => makeUnit('p1', 'city', `p1_city_${i}`))
    const state = { ...makeActiveGameWithFullHands(), units }

    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2' })
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

  it('leaves PURCHASE_CARD as not-yet-implemented, since the gold cost depends on achievements', () => {
    const state = makeActiveGameWithFullHands()
    let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2' })
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('purchase')

    const purchase = applyAction(result.state, { type: 'PURCHASE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(purchase.ok).toBe(false)
    if (!purchase.ok) {
      expect(purchase.error).toContain('NOT_IMPLEMENTED')
    }
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
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2' })
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
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p1' })
    if (!result.ok) throw new Error('setup failed')
    result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: 'p2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.turnOrder).toEqual(['p1', 'p2'])
  })
})
