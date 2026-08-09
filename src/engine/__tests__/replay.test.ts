import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import type { BoardGenerationContent } from '../boardGenerationContent'
import { cardIdFor, createPlayerCards, syncCardZonesWithBoard } from '../cards'
import { createNewGame, startGame } from '../createGame'
import { replayActions } from '../replay'
import { beginSelectCardsPhase } from '../round'
import type { Card, GameState, Player } from '../types'
import type { UnitAction, UnitContent } from '../unitContent'

/** Strips wall-clock timestamps (log entries, actionHistory entries) before a deep-equality comparison — applyAction() stamps real time, so two independently-produced states are never byte-identical there even when every game-logic field matches. */
function stripTimestamps(state: GameState) {
  return {
    ...state,
    log: state.log.map((entry) => ({ ...entry, timestamp: '' })),
    actionHistory: state.actionHistory.map((entry) => ({ ...entry, timestamp: '' })),
  }
}

const domino = [
  { q: 0, r: 0 },
  { q: 1, r: 0 },
]

const boardGenerationContent: BoardGenerationContent = {
  startingWaterShapeCells: domino,
  tiers: [{ terrain: 'plain', shapeCells: domino, placesOn: ['water'], poolSize: 1 }],
}

const unitContent: UnitContent = {
  actionsByKind: {},
  movementByKind: {
    city: { isMobile: false, terrains: [], canCrossCliffs: false },
    nomad: { isMobile: true, terrains: ['plain'], canCrossCliffs: false, moveDistance: 1 },
    ship: { isMobile: true, terrains: ['water'], canCrossCliffs: false, moveDistance: 'unlimited' },
  },
  terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
  resourceCaps: { gold: null, wood: 5, stone: 5 },
  unitSupplyCaps: {},
}

function makeGenesis(): GameState {
  const lobby = createNewGame({
    gameId: 'g1',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
    ],
    resourceBank: { gold: 100, wood: 100, stone: 100 },
  })
  return startGame(lobby, boardGenerationContent)
}

describe('actionHistory + replayActions — board-setup phase', () => {
  it('accumulates PLACE_TILE/PLACE_UNIT in actionHistory, and replaying them from genesis reconstructs the same state', () => {
    const genesis = makeGenesis()
    expect(genesis.status).toBe('boardSetup')
    expect(genesis.actionHistory).toEqual([])

    const step1 = applyAction(genesis, { type: 'PLACE_TILE', playerId: 'p1', anchor: { q: 0, r: 0 }, rotationSteps: 0 }, unitContent, undefined, boardGenerationContent)
    if (!step1.ok) throw new Error(step1.error)
    const step2 = applyAction(step1.state, { type: 'PLACE_UNIT', playerId: 'p1', unitKind: 'city', coord: { q: 0, r: 0 } }, unitContent)
    if (!step2.ok) throw new Error(step2.error)
    const step3 = applyAction(step2.state, { type: 'PLACE_UNIT', playerId: 'p2', unitKind: 'city', coord: { q: 2, r: 1 } }, unitContent)
    if (!step3.ok) throw new Error(step3.error)

    const finalState = step3.state
    expect(finalState.actionHistory).toHaveLength(3)
    expect(finalState.actionHistory.map((entry) => entry.action.type)).toEqual(['PLACE_TILE', 'PLACE_UNIT', 'PLACE_UNIT'])
    // Confirms the board conversion (water -> plain) actually happened, so this isn't a no-op history.
    expect(finalState.board.tiles['0,0']?.terrain).toBe('plain')
    expect(finalState.units).toHaveLength(2)

    const replayed = replayActions(genesis, finalState.actionHistory, unitContent, undefined, boardGenerationContent)
    expect(stripTimestamps(replayed)).toEqual(stripTimestamps(finalState))
  })

  it('throws if the logged history is replayed out of order against the same genesis', () => {
    const genesis = makeGenesis()
    const step1 = applyAction(genesis, { type: 'PLACE_TILE', playerId: 'p1', anchor: { q: 0, r: 0 }, rotationSteps: 0 }, unitContent, undefined, boardGenerationContent)
    if (!step1.ok) throw new Error(step1.error)
    const step2 = applyAction(step1.state, { type: 'PLACE_UNIT', playerId: 'p1', unitKind: 'city', coord: { q: 0, r: 0 } }, unitContent)
    if (!step2.ok) throw new Error(step2.error)

    const reordered = [step2.state.actionHistory[1], step2.state.actionHistory[0]]
    expect(() => replayActions(genesis, reordered, unitContent, undefined, boardGenerationContent)).toThrow()
  })
})

describe('actionHistory + replayActions — round phase', () => {
  const cityIncomeAction: UnitAction = {
    id: 'generate-income',
    name: 'Generate Income',
    description: '',
    effect: { actionType: 'income', goldByTerrain: { plain: 2 } },
  }
  const roundUnitContent: UnitContent = { ...unitContent, actionsByKind: { city: [cityIncomeAction] } }

  function makePlayer(id: string, cards: Card[]): Player {
    return {
      id,
      authUserId: null,
      displayName: id,
      color: 'red',
      handCardIds: [],
      currentlyPlayedCardId: null,
      discardCardIds: [],
      supplyCardIds: cards.map((c) => c.id),
      declineCardIds: [],
      eliminated: false,
      resources: { gold: 0, wood: 0, stone: 0 },
    }
  }

  function makeActiveGenesis(): GameState {
    const turnOrder = ['p1', 'p2']
    const cards: Record<string, Card> = {}
    const players = turnOrder.map((id) => {
      const playerCards = createPlayerCards(id)
      for (const c of playerCards) cards[c.id] = c
      return makePlayer(id, playerCards)
    })
    const board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain')
    const lobby = createNewGame({
      gameId: 'g2',
      playMode: 'hotseat',
      board,
      players: [
        { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
      ],
      resourceBank: { gold: 100, wood: 100, stone: 100 },
    })
    const active: GameState = {
      ...lobby,
      board,
      players,
      cards,
      units: [{ id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: unitContent.movementByKind.city, traits: [] }],
      status: 'active',
    }
    return beginSelectCardsPhase(syncCardZonesWithBoard(active))
  }

  it('accumulates CHOOSE_CARD/RESOLVE_UNIT_ACTION in actionHistory, and replay reconstructs the same state', () => {
    const genesis = makeActiveGenesis()
    expect(genesis.actionHistory).toEqual([])

    const step1 = applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, roundUnitContent)
    if (!step1.ok) throw new Error(step1.error)
    const step2 = applyAction(
      step1.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      roundUnitContent,
    )
    if (!step2.ok) throw new Error(step2.error)

    const finalState = step2.state
    expect(finalState.actionHistory.map((entry) => entry.action.type)).toEqual(['CHOOSE_CARD', 'RESOLVE_UNIT_ACTION'])
    expect(finalState.players.find((p) => p.id === 'p1')!.resources.gold).toBe(2)

    const replayed = replayActions(genesis, finalState.actionHistory, roundUnitContent)
    expect(stripTimestamps(replayed)).toEqual(stripTimestamps(finalState))
  })
})
