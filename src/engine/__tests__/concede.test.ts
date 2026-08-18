import { beforeEach, describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { cardIdFor, syncCardZonesWithBoard } from '../cards'
import { createNewGame } from '../createGame'
import { beginSelectCardsPhase } from '../round'
import type { Coordinate, GameState, Unit } from '../types'

let placeholderUnitCounter = 0
function nextPlaceholderUnitId(): string {
  placeholderUnitCounter += 1
  return `concede_test_unit_${placeholderUnitCounter}`
}

/** A 3-player active game, mid select-cards phase, every player with a full hand — mirrors applyAction.test.ts's makeActiveGame but with a third player so eliminating one doesn't immediately end the game. */
function makeThreePlayerActiveGame(): GameState {
  const lobby = createNewGame({
    gameId: 'concede_game',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      { id: 'p3', authUserId: 'auth_3', displayName: 'Cleo', color: 'green' },
    ],
  })

  const startingPositions: Record<string, Coordinate> = { p1: { q: 0, r: 0 }, p2: { q: 5, r: 0 }, p3: { q: 10, r: 0 } }
  let board = lobby.board
  const units: Unit[] = []
  for (const player of lobby.players) {
    const coord = startingPositions[player.id]
    board = setTile(board, coord, 'plain')
    units.push({
      id: nextPlaceholderUnitId(),
      ownerId: player.id,
      kind: 'ship',
      coord,
      movement: { isMobile: true, terrains: ['water'], canCrossCliffs: false, moveDistance: 1 },
      traits: ['ship'],
    })
  }

  const active: GameState = { ...lobby, board, units, status: 'active' }
  return beginSelectCardsPhase(syncCardZonesWithBoard(active))
}

describe('CONCEDE', () => {
  let state: GameState

  beforeEach(() => {
    state = makeThreePlayerActiveGame()
  })

  it('rejects an unknown player', () => {
    const result = applyAction(state, { type: 'CONCEDE', playerId: 'ghost' })
    expect(result.ok).toBe(false)
  })

  it('rejects a player who is already eliminated', () => {
    const players = state.players.map((p) => (p.id === 'p1' ? { ...p, eliminated: true } : p))
    const result = applyAction({ ...state, players }, { type: 'CONCEDE', playerId: 'p1' })
    expect(result.ok).toBe(false)
  })

  it('eliminates the conceding player during select-cards without ending the phase while others are still pending', () => {
    const result = applyAction(state, { type: 'CONCEDE', playerId: 'p1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.players.find((p) => p.id === 'p1')?.eliminated).toBe(true)
    expect(result.state.roundPhase).toBe('selectCards')
    expect(result.state.pendingPlayerIds).toEqual(['p2', 'p3'])
    expect(result.state.turnOrder).toEqual(['p2', 'p3'])
  })

  it('chains into the actions phase when the conceding player was the last one pending in select-cards', () => {
    const p2Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'ship') })
    if (!p2Choice.ok) throw new Error('setup failed')
    const p3Choice = applyAction(p2Choice.state, { type: 'CHOOSE_CARD', playerId: 'p3', cardId: cardIdFor('p3', 'ship') })
    if (!p3Choice.ok) throw new Error('setup failed')
    expect(p3Choice.state.pendingPlayerIds).toEqual(['p1'])

    const result = applyAction(p3Choice.state, { type: 'CONCEDE', playerId: 'p1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.roundPhase).toBe('actions')
    expect(result.state.players.find((p) => p.id === 'p1')?.eliminated).toBe(true)
  })

  it('advances turn order without ending the phase when a non-active pending player concedes during the actions phase', () => {
    const p1Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') })
    if (!p1Choice.ok) throw new Error('setup failed')
    const p2Choice = applyAction(p1Choice.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'ship') })
    if (!p2Choice.ok) throw new Error('setup failed')
    const p3Choice = applyAction(p2Choice.state, { type: 'CHOOSE_CARD', playerId: 'p3', cardId: cardIdFor('p3', 'ship') })
    if (!p3Choice.ok) throw new Error('setup failed')
    expect(p3Choice.state.roundPhase).toBe('actions')
    expect(p3Choice.state.activePlayerId).toBe('p1')

    const result = applyAction(p3Choice.state, { type: 'CONCEDE', playerId: 'p3' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.roundPhase).toBe('actions')
    expect(result.state.activePlayerId).toBe('p1')
    expect(result.state.pendingPlayerIds).toEqual(['p1', 'p2'])
    expect(result.state.players.find((p) => p.id === 'p3')?.eliminated).toBe(true)
  })

  it('ends the game immediately if conceding leaves only one player standing, without chaining to the next phase', () => {
    const players = state.players.map((p) => (p.id === 'p2' ? { ...p, eliminated: true } : p))
    const eliminatedState: GameState = { ...state, players, turnOrder: ['p1', 'p3'], pendingPlayerIds: ['p1', 'p3'] }

    const result = applyAction(eliminatedState, { type: 'CONCEDE', playerId: 'p1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.status).toBe('completed')
    expect(result.state.winnerPlayerIds).toEqual(['p3'])
    // Left exactly where the elimination happened — no phase-advance chain.
    expect(result.state.roundPhase).toBe('selectCards')
  })
})
