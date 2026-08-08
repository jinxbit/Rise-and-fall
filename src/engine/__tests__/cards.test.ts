import { beforeEach, describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard } from '../board'
import { cardIdFor, findCardZone, moveCard, syncCardZonesWithBoard, UNIT_KINDS } from '../cards'
import { createNewGame, startGame } from '../createGame'
import type { GameState, Unit } from '../types'

function makeLobbyGame(): GameState {
  return createNewGame({
    gameId: 'game_1',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
    ],
  })
}

function makeUnit(ownerId: string, kind: string): Unit {
  return {
    id: `${ownerId}_${kind}_unit`,
    ownerId,
    kind,
    coord: { q: 0, r: 0 },
    movement: { domains: [], canTraverseCliffs: false, range: 0 },
    traits: [],
  }
}

describe('createNewGame: starting card zones', () => {
  it('gives each player one card per unit kind, all starting in supply', () => {
    const state = makeLobbyGame()
    for (const player of state.players) {
      expect(player.supplyCardIds).toHaveLength(UNIT_KINDS.length)
      expect(player.handCardIds).toHaveLength(0)
      for (const kind of UNIT_KINDS) {
        expect(state.cards[cardIdFor(player.id, kind)]).toBeDefined()
      }
    }
  })
})

describe('syncCardZonesWithBoard (rules 5 & 6)', () => {
  it('moves a card from supply to hand when its owner gets their first unit of that kind', () => {
    let state = makeLobbyGame()
    state = { ...state, units: [makeUnit('p1', 'city')] }

    const synced = syncCardZonesWithBoard(state)
    const p1 = synced.players.find((p) => p.id === 'p1')!
    expect(findCardZone(p1, cardIdFor('p1', 'city'))).toBe('hand')
  })

  it('moves a card back to supply once the owner has no units of that kind left', () => {
    let state = makeLobbyGame()
    state = { ...state, units: [makeUnit('p1', 'city')] }
    state = syncCardZonesWithBoard(state)

    const withoutUnit = { ...state, units: [] }
    const synced = syncCardZonesWithBoard(withoutUnit)
    const p1 = synced.players.find((p) => p.id === 'p1')!
    expect(findCardZone(p1, cardIdFor('p1', 'city'))).toBe('supply')
  })

  it('leaves a card in decline alone even if its owner has no units of that kind (rule 7)', () => {
    let state = makeLobbyGame()
    const p1Index = state.players.findIndex((p) => p.id === 'p1')!
    const declinedPlayer = moveCard(state.players[p1Index], cardIdFor('p1', 'city'), 'decline')
    const players = [...state.players]
    players[p1Index] = declinedPlayer
    state = { ...state, players, units: [makeUnit('p1', 'city')] }

    const synced = syncCardZonesWithBoard(state)
    const p1 = synced.players.find((p) => p.id === 'p1')!
    expect(findCardZone(p1, cardIdFor('p1', 'city'))).toBe('decline')
  })

  it('startGame puts starting-unit cards in hand via rule 6', () => {
    const lobby = makeLobbyGame()
    const state = startGame(lobby, { p1: { q: 0, r: 0 }, p2: { q: 5, r: 0 } })
    const p1 = state.players.find((p) => p.id === 'p1')!
    // The scaffold's starting units include a 'ship', one of the six kinds.
    expect(findCardZone(p1, cardIdFor('p1', 'ship'))).toBe('hand')
  })
})

describe('PLAY_CARD (rules 3, 4, 9, 10, 11)', () => {
  let state: GameState

  beforeEach(() => {
    state = makeLobbyGame()
    state = { ...state, status: 'active', activePlayerId: 'p1', turnOrder: ['p1', 'p2'] }
    // Give p1 a hand of two cards directly, bypassing board sync for test isolation.
    const p1Index = state.players.findIndex((p) => p.id === 'p1')
    let p1 = state.players[p1Index]
    p1 = moveCard(p1, cardIdFor('p1', 'city'), 'hand')
    p1 = moveCard(p1, cardIdFor('p1', 'temple'), 'hand')
    const players = [...state.players]
    players[p1Index] = p1
    state = { ...state, players }
  })

  it('moves the played card from hand to discard', () => {
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const p1 = result.state.players.find((p) => p.id === 'p1')!
    expect(p1.handCardIds).not.toContain(cardIdFor('p1', 'city'))
    expect(p1.discardCardIds).toContain(cardIdFor('p1', 'city'))
    expect(p1.currentlyPlayedCardId).toBeNull()
  })

  it('rejects playing a card not in hand', () => {
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') })
    expect(result.ok).toBe(false)
  })

  it('rejects a second card play in the same turn', () => {
    const first = applyAction(state, { type: 'PLAY_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = applyAction(first.state, { type: 'PLAY_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'temple') })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error).toContain('single card')
    }
  })

  it('allows a card play again after END_TURN resets the per-turn limit', () => {
    const played = applyAction(state, { type: 'PLAY_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(played.ok).toBe(true)
    if (!played.ok) return

    const ended = applyAction(played.state, { type: 'END_TURN', playerId: 'p1' })
    expect(ended.ok).toBe(true)
    if (!ended.ok) return
    expect(ended.state.activePlayerId).toBe('p2')
    expect(ended.state.cardPlayedThisTurn).toBe(false)
  })

  it('recycles the discard into the hand once the hand is emptied, and makes the next player first (rules 10 & 11)', () => {
    const first = applyAction(state, { type: 'PLAY_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // p1 -> p2 -> p1, so it's p1's turn again with the per-turn play limit reset.
    const p1EndsTurn = applyAction(first.state, { type: 'END_TURN', playerId: 'p1' })
    expect(p1EndsTurn.ok).toBe(true)
    if (!p1EndsTurn.ok) return
    const p2EndsTurn = applyAction(p1EndsTurn.state, { type: 'END_TURN', playerId: 'p2' })
    expect(p2EndsTurn.ok).toBe(true)
    if (!p2EndsTurn.ok) return
    expect(p2EndsTurn.state.activePlayerId).toBe('p1')

    // p1's last remaining hand card is played, emptying the hand -> recycle should fire.
    const second = applyAction(p2EndsTurn.state, {
      type: 'PLAY_CARD',
      playerId: 'p1',
      cardId: cardIdFor('p1', 'temple'),
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return

    const p1 = second.state.players.find((p) => p.id === 'p1')!
    expect(p1.discardCardIds).toHaveLength(0)
    expect(p1.handCardIds.sort()).toEqual([cardIdFor('p1', 'city'), cardIdFor('p1', 'temple')].sort())

    // Rule 11: the next player (p2) becomes first in turn order.
    expect(second.state.turnOrder[0]).toBe('p2')
  })
})
