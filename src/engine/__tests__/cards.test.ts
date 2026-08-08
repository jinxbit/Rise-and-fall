import { describe, expect, it } from 'vitest'
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
