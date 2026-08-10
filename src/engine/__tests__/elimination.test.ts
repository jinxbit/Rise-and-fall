import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard } from '../board'
import { cardIdFor, moveCard } from '../cards'
import { createNewGame } from '../createGame'
import { eliminatePlayer, eliminatePlayersWithNoCardToDecline, eliminatePlayersWithNoCardToPlay } from '../elimination'
import { beginSelectCardsPhase } from '../round'
import type { GameState, Player, Unit } from '../types'

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

function makeUnit(ownerId: string, kind = 'city', id = `${ownerId}_${kind}`): Unit {
  return {
    id,
    ownerId,
    kind,
    coord: { q: 0, r: 0 },
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
    roundPhase: 'decline',
    chosenCardIdByPlayerId: {},
    pendingPlayerIds: [],
    resolvedUnitIdsThisTurn: [],
    turnOrder: [],
    board: createEmptyBoard('hex'),
    players: [],
    units: [],
    cards: {},
    resourceBank: { gold: 0, wood: 0, stone: 0 },
    unitLimits: {},
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
    ...overrides,
  }
}

describe('eliminatePlayer', () => {
  it('marks the player eliminated, removes their units, and drops them from turn order', () => {
    const state = makeState({
      roundPhase: 'actions',
      turnOrder: ['p1', 'p2'],
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: 'p1',
      players: [makePlayer('p1'), makePlayer('p2')],
      units: [makeUnit('p1'), makeUnit('p2')],
    })

    const next = eliminatePlayer(state, 'p1')

    expect(next.players.find((p) => p.id === 'p1')?.eliminated).toBe(true)
    expect(next.units.map((u) => u.ownerId)).toEqual(['p2'])
    expect(next.turnOrder).toEqual(['p2'])
    expect(next.pendingPlayerIds).toEqual(['p2'])
    expect(next.activePlayerId).toBe('p2')
  })

  it('returns the eliminated player\'s resources to the bank and zeroes their own holding', () => {
    const state = makeState({
      roundPhase: 'actions',
      turnOrder: ['p1', 'p2'],
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: 'p1',
      players: [
        makePlayer('p1', { resources: { gold: 40, wood: 3, stone: 5 } }),
        makePlayer('p2', { resources: { gold: 10, wood: 1, stone: 0 } }),
      ],
      resourceBank: { gold: 100, wood: 4, stone: 2 },
    })

    const next = eliminatePlayer(state, 'p1')

    expect(next.players.find((p) => p.id === 'p1')?.resources).toEqual({ gold: 0, wood: 0, stone: 0 })
    expect(next.resourceBank).toEqual({ gold: 140, wood: 7, stone: 7 })
    // p2's own holding is untouched.
    expect(next.players.find((p) => p.id === 'p2')?.resources).toEqual({ gold: 10, wood: 1, stone: 0 })
  })

  it('leaves activePlayerId null during the select-cards phase, which has no single active player', () => {
    const state = makeState({
      roundPhase: 'selectCards',
      turnOrder: ['p1', 'p2'],
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: null,
      players: [makePlayer('p1'), makePlayer('p2')],
    })

    const next = eliminatePlayer(state, 'p1')

    expect(next.activePlayerId).toBeNull()
    expect(next.pendingPlayerIds).toEqual(['p2'])
  })

  it('leaves activePlayerId null during the decline phase too, which is simultaneous like select-cards', () => {
    const state = makeState({
      roundPhase: 'decline',
      turnOrder: ['p1', 'p2'],
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: null,
      players: [makePlayer('p1'), makePlayer('p2')],
    })

    const next = eliminatePlayer(state, 'p1')

    expect(next.activePlayerId).toBeNull()
    expect(next.pendingPlayerIds).toEqual(['p2'])
  })

  it('sets activePlayerId to null once nobody is left pending', () => {
    const state = makeState({
      roundPhase: 'actions',
      turnOrder: ['p1'],
      pendingPlayerIds: ['p1'],
      activePlayerId: 'p1',
      players: [makePlayer('p1')],
    })

    const next = eliminatePlayer(state, 'p1')

    expect(next.activePlayerId).toBeNull()
    expect(next.pendingPlayerIds).toEqual([])
  })

  it('is a no-op for an unknown player id', () => {
    const state = makeState({ players: [makePlayer('p1')] })
    expect(eliminatePlayer(state, 'ghost')).toBe(state)
  })

  it('is a no-op if the player is already eliminated', () => {
    const state = makeState({ players: [makePlayer('p1', { eliminated: true })] })
    expect(eliminatePlayer(state, 'p1')).toBe(state)
  })
})

describe('eliminatePlayersWithNoCardToPlay', () => {
  it('eliminates every pending player with an empty hand, leaving the rest', () => {
    const state = makeState({
      roundPhase: 'selectCards',
      turnOrder: ['p1', 'p2', 'p3'],
      pendingPlayerIds: ['p1', 'p2', 'p3'],
      players: [
        makePlayer('p1', { handCardIds: [] }),
        makePlayer('p2', { handCardIds: ['card_p2_city'] }),
        makePlayer('p3', { handCardIds: [] }),
      ],
    })

    const next = eliminatePlayersWithNoCardToPlay(state)

    expect(next.pendingPlayerIds).toEqual(['p2'])
    expect(next.players.find((p) => p.id === 'p1')?.eliminated).toBe(true)
    expect(next.players.find((p) => p.id === 'p2')?.eliminated).toBe(false)
    expect(next.players.find((p) => p.id === 'p3')?.eliminated).toBe(true)
  })

  it('is a no-op when every pending player has a card', () => {
    const state = makeState({
      roundPhase: 'selectCards',
      pendingPlayerIds: ['p1'],
      players: [makePlayer('p1', { handCardIds: ['card_p1_city'] })],
    })
    expect(eliminatePlayersWithNoCardToPlay(state)).toBe(state)
  })
})

describe('eliminatePlayersWithNoCardToDecline', () => {
  it('eliminates every pending player with nothing to decline, independent of order', () => {
    const state = makeState({
      roundPhase: 'decline',
      turnOrder: ['p1', 'p2', 'p3'],
      pendingPlayerIds: ['p1', 'p2', 'p3'],
      activePlayerId: null,
      players: [
        makePlayer('p1', { handCardIds: [], discardCardIds: [] }),
        makePlayer('p2', { handCardIds: [], discardCardIds: [] }),
        makePlayer('p3', { handCardIds: ['card_p3_city'], discardCardIds: [] }),
      ],
    })

    const next = eliminatePlayersWithNoCardToDecline(state)

    expect(next.activePlayerId).toBeNull()
    expect(next.pendingPlayerIds).toEqual(['p3'])
    expect(next.players.find((p) => p.id === 'p1')?.eliminated).toBe(true)
    expect(next.players.find((p) => p.id === 'p2')?.eliminated).toBe(true)
    expect(next.players.find((p) => p.id === 'p3')?.eliminated).toBe(false)
  })

  it('is a no-op when every pending player has a card available, from hand or discard', () => {
    const state = makeState({
      roundPhase: 'decline',
      turnOrder: ['p1', 'p2'],
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: null,
      players: [makePlayer('p1', { handCardIds: [], discardCardIds: ['card_p1_city'] }), makePlayer('p2', { handCardIds: ['card_p2_city'] })],
    })

    expect(eliminatePlayersWithNoCardToDecline(state)).toBe(state)
  })

  it('eliminates only the specific player who runs out, leaving another still owing a card pending', () => {
    const state = makeState({
      roundPhase: 'decline',
      turnOrder: ['p1', 'p2'],
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: null,
      players: [makePlayer('p1', { handCardIds: [], discardCardIds: [] }), makePlayer('p2', { handCardIds: ['card_p2_city'] })],
    })

    const next = eliminatePlayersWithNoCardToDecline(state)

    expect(next.pendingPlayerIds).toEqual(['p2'])
    expect(next.players.find((p) => p.id === 'p1')?.eliminated).toBe(true)
    expect(next.players.find((p) => p.id === 'p2')?.eliminated).toBe(false)
  })

  it('does nothing outside the decline phase', () => {
    const state = makeState({
      roundPhase: 'actions',
      activePlayerId: 'p1',
      players: [makePlayer('p1', { handCardIds: [], discardCardIds: [] })],
    })
    expect(eliminatePlayersWithNoCardToDecline(state)).toBe(state)
  })

  it('ends cleanly (activePlayerId null) if everyone pending gets eliminated', () => {
    const state = makeState({
      roundPhase: 'decline',
      turnOrder: ['p1', 'p2'],
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: 'p1',
      players: [
        makePlayer('p1', { handCardIds: [], discardCardIds: [] }),
        makePlayer('p2', { handCardIds: [], discardCardIds: [] }),
      ],
    })

    const next = eliminatePlayersWithNoCardToDecline(state)

    expect(next.activePlayerId).toBeNull()
    expect(next.pendingPlayerIds).toEqual([])
  })
})

describe('elimination wired into round phases', () => {
  function makeTwoPlayerGame(): GameState {
    const lobby = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board: createEmptyBoard('hex'),
      players: [
        { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      ],
    })
    return { ...lobby, status: 'active' }
  }

  it('eliminates a player with an empty hand at select-cards start, and continues with the other', () => {
    const state = makeTwoPlayerGame()
    const p2Index = state.players.findIndex((p) => p.id === 'p2')
    let p2 = state.players[p2Index]
    for (const cardId of p2.supplyCardIds) {
      p2 = moveCard(p2, cardId, 'hand')
    }
    const players = [...state.players]
    players[p2Index] = p2
    // p1's cards all stay in supply — nothing in hand or discard.

    const result = beginSelectCardsPhase({ ...state, players })

    const p1After = result.players.find((p) => p.id === 'p1')!
    const p2After = result.players.find((p) => p.id === 'p2')!
    expect(p1After.eliminated).toBe(true)
    expect(p2After.eliminated).toBe(false)
    expect(result.turnOrder).toEqual(['p2'])
    expect(result.roundPhase).toBe('selectCards')
    expect(result.pendingPlayerIds).toEqual(['p2'])
  })

  it('advances straight to the actions phase if every player is eliminated at select-cards start', () => {
    const state = makeTwoPlayerGame()

    const result = beginSelectCardsPhase(state)

    expect(result.players.every((p) => p.eliminated)).toBe(true)
    expect(result.turnOrder).toEqual([])
    expect(result.roundPhase).toBe('actions')
  })

  it('cascades an elimination via applyMoveToDecline when the next player has nothing to decline', () => {
    const base = makeTwoPlayerGame()
    const p1Index = base.players.findIndex((p) => p.id === 'p1')
    let p1 = base.players[p1Index]
    for (const cardId of p1.supplyCardIds) {
      p1 = moveCard(p1, cardId, 'hand')
    }
    const players = [...base.players]
    players[p1Index] = p1
    // p2's cards all stay in supply — nothing in hand or discard.
    const state: GameState = {
      ...base,
      players,
      roundPhase: 'decline',
      pendingPlayerIds: ['p1', 'p2'],
      activePlayerId: null,
    }

    const result = applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: cardIdFor('p1', 'city') })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const p2After = result.state.players.find((p) => p.id === 'p2')!
    expect(p2After.eliminated).toBe(true)
    // Everyone pending is now gone, so the phase advances straight to purchase.
    expect(result.state.roundPhase).toBe('purchase')
  })
})
