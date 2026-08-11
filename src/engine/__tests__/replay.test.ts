import { describe, expect, it } from 'vitest'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../achievementContent'
import type { AchievementContent } from '../achievementContent'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import type { BoardGenerationContent } from '../boardGenerationContent'
import { cardIdFor, createPlayerCards, syncCardZonesWithBoard } from '../cards'
import { createNewGame, startGame } from '../createGame'
import { replayActions } from '../replay'
import { beginSelectCardsPhase } from '../round'
import type { Card, GameState, Player } from '../types'
import type { UnitAction, UnitContent } from '../unitContent'

/** Strips wall-clock timestamps (actionHistory entries) before a deep-equality comparison — applyAction() stamps real time, so two independently-produced states are never byte-identical there even when every game-logic field matches. */
function stripTimestamps(state: GameState) {
  return {
    ...state,
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
    // (2,1) is one of the seeded starting-water tiles, no longer a legal City
    // placement (see boardSetup.ts's isLegalStartingUnitPlacement) — (1,0) is
    // the other half of p1's plain tile from step1, still unoccupied.
    const step3 = applyAction(step2.state, { type: 'PLACE_UNIT', playerId: 'p2', unitKind: 'city', coord: { q: 1, r: 0 } }, unitContent)
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

  function makePlayer(id: string, cards: Card[], declineCardIds: string[] = []): Player {
    return {
      id,
      authUserId: null,
      displayName: id,
      color: 'red',
      handCardIds: [],
      currentlyPlayedCardId: null,
      discardCardIds: [],
      supplyCardIds: cards.map((c) => c.id),
      declineCardIds,
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
    // p2 needs a unit of their own too — otherwise syncCardZonesWithBoard
    // leaves their hand empty, eliminatePlayersWithNoCardToPlay eliminates
    // them right at genesis, and (since eliminatePlayer now ends the game
    // outright once only one player remains — see elimination.ts) this
    // genesis would already be status: 'completed' before any test action
    // runs at all.
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 5, r: 0 }, 'plain')
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
      units: [
        { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: unitContent.movementByKind.city, traits: [] },
        { id: 'city_b', ownerId: 'p2', kind: 'city', coord: { q: 5, r: 0 }, movement: unitContent.movementByKind.city, traits: [] },
      ],
      status: 'active',
    }
    return beginSelectCardsPhase(syncCardZonesWithBoard(active))
  }

  it('accumulates CHOOSE_CARD/RESOLVE_UNIT_ACTION in actionHistory, and replay reconstructs the same state', () => {
    const genesis = makeActiveGenesis()
    expect(genesis.actionHistory).toEqual([])

    const step1 = applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, roundUnitContent)
    if (!step1.ok) throw new Error(step1.error)
    const step1b = applyAction(step1.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }, roundUnitContent)
    if (!step1b.ok) throw new Error(step1b.error)
    const step2 = applyAction(
      step1b.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      roundUnitContent,
    )
    if (!step2.ok) throw new Error(step2.error)

    const finalState = step2.state
    expect(finalState.actionHistory.map((entry) => entry.action.type)).toEqual(['CHOOSE_CARD', 'CHOOSE_CARD', 'RESOLVE_UNIT_ACTION'])
    expect(finalState.players.find((p) => p.id === 'p1')!.resources.gold).toBe(2)

    const replayed = replayActions(genesis, finalState.actionHistory, roundUnitContent)
    expect(stripTimestamps(replayed)).toEqual(stripTimestamps(finalState))
  })

  // Bug report: "Can't undo a pass on purchasing a card from decline." Undo
  // (GamePage.tsx's handleUndo) is exactly replayActions(genesis,
  // actionHistory.slice(0, -1)) — this drives a real game to a
  // round-closing PASS_PURCHASE (p1 has a card in decline already, so their
  // purchase choice is real, not auto-skipped) and confirms replaying up to
  // but not including it reconstructs the exact pre-pass purchase-phase
  // state, with no replay error.
  it('a round-ending PASS_PURCHASE can be undone: replaying everything before it reconstructs the pre-pass purchase-phase state', () => {
    const turnOrder = ['p1', 'p2']
    const cards: Record<string, Card> = {}
    const p1Cards = createPlayerCards('p1')
    const p2Cards = createPlayerCards('p2')
    for (const c of [...p1Cards, ...p2Cards]) cards[c.id] = c
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 5, r: 0 }, 'plain')
    const lobby = createNewGame({
      gameId: 'g3',
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
      players: [
        makePlayer('p1', p1Cards.filter((c) => c.kind === 'city'), [cardIdFor('p1', 'nomad')]),
        makePlayer('p2', p2Cards.filter((c) => c.kind === 'city')),
      ],
      cards,
      turnOrder,
      units: [
        { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: unitContent.movementByKind.city, traits: [] },
        // p2 needs a unit of their own too — otherwise beginSelectCardsPhase
        // eliminates them for having no card to choose, and this fixture
        // needs both players cycling through the actions phase to reach a
        // real (not immediately-finished) purchase phase.
        { id: 'city_b', ownerId: 'p2', kind: 'city', coord: { q: 5, r: 0 }, movement: unitContent.movementByKind.city, traits: [] },
      ],
      status: 'active',
    }
    const genesis = beginSelectCardsPhase(syncCardZonesWithBoard(active))

    let state = genesis
    for (const action of [
      { type: 'CHOOSE_CARD' as const, playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'CHOOSE_CARD' as const, playerId: 'p2', cardId: cardIdFor('p2', 'city') },
      { type: 'PASS_ACTIONS' as const, playerId: 'p1' },
      { type: 'PASS_ACTIONS' as const, playerId: 'p2' },
    ]) {
      const result = applyAction(state, action, roundUnitContent)
      if (!result.ok) throw new Error(`setup failed at ${action.type}: ${result.error}`)
      state = result.state
    }
    // p1 has a card in decline, so they land in the purchase phase with a
    // real choice; p2 doesn't, and is auto-skipped (see
    // skipEmptyDeclinePurchasers in round.ts).
    expect(state.roundPhase).toBe('purchase')
    expect(state.pendingPlayerIds).toEqual(['p1', 'p2'])
    const stateBeforePass = state

    const passResult = applyAction(state, { type: 'PASS_PURCHASE', playerId: 'p1' }, roundUnitContent)
    if (!passResult.ok) throw new Error('PASS_PURCHASE failed: ' + passResult.error)
    // p2's auto-skip plus p1's pass empties the purchase queue, so this
    // single PASS_PURCHASE also closes out the round (finishRound runs).
    expect(passResult.state.roundPhase).toBe('selectCards')

    const previousHistory = passResult.state.actionHistory.slice(0, -1)
    const undone = replayActions(genesis, previousHistory, roundUnitContent)

    expect(stripTimestamps(undone)).toEqual(stripTimestamps(stateBeforePass))
  })

  // Feature request: "Make undoing possible even if the game ended."
  // GamePage.tsx's handleUndo is unconditional replayActions(genesis,
  // actionHistory.slice(0, -1)) regardless of `status` — this confirms the
  // engine invariant that makes that work: undoing the very action that
  // ended the game (finishRound's game-end branch, round.ts) reconstructs
  // the pre-end state with status back to 'active', not stuck 'completed'.
  it('undoing the action that ended the game reverts status from completed back to active', () => {
    const turnOrder = ['p1', 'p2']
    const cards: Record<string, Card> = {}
    const p1Cards = createPlayerCards('p1')
    const p2Cards = createPlayerCards('p2')
    for (const c of [...p1Cards, ...p2Cards]) cards[c.id] = c
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 5, r: 0 }, 'plain')
    const lobby = createNewGame({
      gameId: 'g4',
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
      players: [makePlayer('p1', p1Cards.filter((c) => c.kind === 'city')), makePlayer('p2', p2Cards.filter((c) => c.kind === 'city'))],
      cards,
      turnOrder,
      units: [
        { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: unitContent.movementByKind.city, traits: [] },
        { id: 'city_b', ownerId: 'p2', kind: 'city', coord: { q: 5, r: 0 }, movement: unitContent.movementByKind.city, traits: [] },
      ],
      status: 'active',
    }
    const genesis = beginSelectCardsPhase(syncCardZonesWithBoard(active))

    // A single-achievement, single-round game: both players already hold
    // their full city supply (cap 1) at genesis, so p1 resolving any city
    // action claims city-mastery on the spot (updateAchievementClaims,
    // achievements.ts) — reaching gameLength(1) the moment the round
    // finishes.
    const content: UnitContent = { ...roundUnitContent, unitSupplyCaps: { city: 1 } }
    const achievementContent: AchievementContent = {
      ...EMPTY_ACHIEVEMENT_CONTENT,
      gameLength: 1,
      unitKindByAchievementId: { 'city-mastery': 'city' },
      achievementVictoryPoints: { 'city-mastery': 1 },
    }

    let state = genesis
    for (const action of [
      { type: 'CHOOSE_CARD' as const, playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'CHOOSE_CARD' as const, playerId: 'p2', cardId: cardIdFor('p2', 'city') },
      { type: 'RESOLVE_UNIT_ACTION' as const, playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      { type: 'PASS_ACTIONS' as const, playerId: 'p2' },
      // Claiming an achievement mid-round triggers the decline phase
      // (isDeclineTriggered, decline.ts) — each player owes 1 card, and
      // their just-played city card (now in discard) is the only candidate.
      { type: 'MOVE_TO_DECLINE' as const, playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'MOVE_TO_DECLINE' as const, playerId: 'p2', cardId: cardIdFor('p2', 'city') },
      { type: 'PASS_PURCHASE' as const, playerId: 'p1' },
      { type: 'PASS_PURCHASE' as const, playerId: 'p2' },
    ]) {
      const result = applyAction(state, action, content, achievementContent)
      if (!result.ok) throw new Error(`setup failed at ${action.type}: ${result.error}`)
      state = result.state
    }

    // The final PASS_PURCHASE closes the round, and closing the round with
    // gameLength already reached is what ends the game.
    expect(state.status).toBe('completed')
    expect(state.winnerPlayerIds).toEqual(['p1'])

    const previousHistory = state.actionHistory.slice(0, -1)
    const undone = replayActions(genesis, previousHistory, content, achievementContent)

    expect(undone.status).toBe('active')
    expect(undone.winnerPlayerIds).toEqual([])
  })
})
