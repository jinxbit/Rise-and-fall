import { beforeEach, describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import type { BoardGenerationContent } from '../boardGenerationContent'
import { cardIdFor } from '../cards'
import { createNewGame, startGame } from '../createGame'
import type { GameState } from '../types'

function makeActiveGame(): GameState {
  const lobby = createNewGame({
    gameId: 'game_1',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
    ],
  })

  return startGame(lobby, {
    p1: { q: 0, r: 0 },
    p2: { q: 5, r: 0 },
  })
}

describe('createNewGame / startGame', () => {
  it('starts in lobby status with no units', () => {
    const lobby = createNewGame({
      gameId: 'game_1',
      playMode: 'live',
      board: createEmptyBoard('hex'),
      players: [{ id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' }],
    })
    expect(lobby.status).toBe('lobby')
    expect(lobby.units).toHaveLength(0)
  })

  it('places a settlement, mobile unit, and ship per player on start', () => {
    const state = makeActiveGame()
    expect(state.status).toBe('active')
    expect(state.units).toHaveLength(6)
    expect(state.units.filter((u) => u.ownerId === 'p1')).toHaveLength(3)
  })

  it('starts round 1 in the select-cards phase with every player pending', () => {
    const state = makeActiveGame()
    expect(state.turn).toBe(0)
    expect(state.roundPhase).toBe('selectCards')
    expect(state.activePlayerId).toBeNull()
    expect(state.pendingPlayerIds).toEqual(['p1', 'p2'])
  })
})

describe('applyAction', () => {
  let state: GameState

  beforeEach(() => {
    state = makeActiveGame()
  })

  it('rejects CHOOSE_CARD for a card not in hand', () => {
    const result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(result.ok).toBe(false)
  })

  it('rejects a player choosing a card twice in the same round', () => {
    const shipCardId = cardIdFor('p1', 'ship')
    const first = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: shipCardId })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = applyAction(first.state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: shipCardId })
    expect(second.ok).toBe(false)
  })

  it('moves to the actions phase once every player has chosen a card', () => {
    const p1Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') })
    expect(p1Choice.ok).toBe(true)
    if (!p1Choice.ok) return
    expect(p1Choice.state.roundPhase).toBe('selectCards')

    const p2Choice = applyAction(p1Choice.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'ship') })
    expect(p2Choice.ok).toBe(true)
    if (!p2Choice.ok) return
    expect(p2Choice.state.roundPhase).toBe('actions')
    expect(p2Choice.state.activePlayerId).toBe('p1')
    expect(p2Choice.state.pendingPlayerIds).toEqual(['p1', 'p2'])
  })

  it('rejects RESOLVE_UNIT_ACTION outside the actions phase', () => {
    const result = applyAction(state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', actionId: 'generate-income' })
    expect(result.ok).toBe(false)
  })

  it('rejects RESOLVE_UNIT_ACTION out of turn order', () => {
    const p1Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') })
    if (!p1Choice.ok) throw new Error('setup failed')
    const p2Choice = applyAction(p1Choice.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'ship') })
    if (!p2Choice.ok) throw new Error('setup failed')

    const result = applyAction(p2Choice.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', actionId: 'generate-income' })
    expect(result.ok).toBe(false)
  })

  it('rejects PURCHASE_CARD outside the purchase phase', () => {
    const result = applyAction(state, { type: 'PURCHASE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('purchase phase')
    }
  })

  it('does not mutate the input state', () => {
    const snapshot = JSON.stringify(state)
    applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') })
    expect(JSON.stringify(state)).toBe(snapshot)
  })

  it('rejects actions when the game is not active', () => {
    const lobbyState: GameState = { ...state, status: 'lobby' }
    const result = applyAction(lobbyState, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') })
    expect(result.ok).toBe(false)
  })
})

describe('applyAction — PLACE_TILE/PLACE_UNIT dispatch during boardSetup', () => {
  function makeBoardSetupState(): GameState {
    const lobby = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board: setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'water'), { q: 1, r: 0 }, 'water'),
      players: [
        { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      ],
    })
    return {
      ...lobby,
      status: 'boardSetup',
      boardSetup: { tileTierQueue: ['plain'], tilesRemainingInTier: 1, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    }
  }

  const boardGenerationContent: BoardGenerationContent = {
    startingWaterShapeCells: [],
    tiers: [{ terrain: 'plain', shapeCells: [{ q: 0, r: 0 }, { q: 1, r: 0 }], placesOn: ['water'], poolSize: 1 }],
  }

  it('routes PLACE_TILE through even though status is not "active"', () => {
    const state = makeBoardSetupState()
    const result = applyAction(
      state,
      { type: 'PLACE_TILE', playerId: 'p1', anchor: { q: 0, r: 0 }, rotationSteps: 0 },
      undefined,
      undefined,
      boardGenerationContent,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.boardSetup?.tileTierQueue).toEqual([])
  })

  it('rejects a normal round action (CHOOSE_CARD) during boardSetup status', () => {
    const state = makeBoardSetupState()
    const result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('not active')
  })
})
