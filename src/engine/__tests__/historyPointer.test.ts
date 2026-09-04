import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { cardIdFor, createPlayerCards, syncCardZonesWithBoard } from '../cards'
import { createNewGame } from '../createGame'
import { applyActionAtPointer, branchDiscardsAnotherPlayersAction, clampPointer, computeRevealedPhaseMarks, revealMarkKey, stateAtPointer } from '../historyPointer'
import { beginSelectCardsPhase } from '../round'
import type { Card, GameState, Player } from '../types'
import type { UnitContent } from '../unitContent'

function stripTimestamps(state: GameState) {
  return {
    ...state,
    actionHistory: state.actionHistory.map((entry) => ({ ...entry, timestamp: '' })),
  }
}

const unitContent: UnitContent = {
  actionsByKind: {},
  movementByKind: {
    city: { isMobile: false, terrains: [], canCrossCliffs: false },
    nomad: { isMobile: true, terrains: ['plain'], canCrossCliffs: false, moveDistance: 1 },
  },
  terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
  resourceCaps: { gold: null, wood: 5, stone: 5 },
  unitSupplyCaps: {},
  companionKindsByCardKind: {},
  activationsPerTurnByKind: {},
}

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

/** An active-round genesis (mirrors replay.test.ts's makeActiveGenesis) — enough for CHOOSE_CARD/PASS_ACTIONS to flow without either player being auto-eliminated for lacking a card. */
function makeGenesis(): GameState {
  const turnOrder = ['p1', 'p2']
  const cards: Record<string, Card> = {}
  const p1Cards = createPlayerCards('p1')
  const p2Cards = createPlayerCards('p2')
  for (const c of [...p1Cards, ...p2Cards]) cards[c.id] = c
  const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 5, r: 0 }, 'plain')
  const lobby = createNewGame({
    gameId: 'g1',
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
    players: [makePlayer('p1', p1Cards), makePlayer('p2', p2Cards)],
    cards,
    turnOrder,
    units: [
      { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: unitContent.movementByKind.city, traits: [] },
      { id: 'city_b', ownerId: 'p2', kind: 'city', coord: { q: 5, r: 0 }, movement: unitContent.movementByKind.city, traits: [] },
      // p2 also has a nomad, so their hand has a second card to branch onto
      // in the "branching prunes the abandoned tail" test below.
      { id: 'nomad_b', ownerId: 'p2', kind: 'nomad', coord: { q: 5, r: 0 }, movement: unitContent.movementByKind.nomad, traits: [] },
    ],
    status: 'active',
  }
  return beginSelectCardsPhase(syncCardZonesWithBoard(active))
}

function choose(state: GameState, playerId: string) {
  const result = applyAction(state, { type: 'CHOOSE_CARD', playerId, cardId: cardIdFor(playerId, 'city') }, unitContent)
  if (!result.ok) throw new Error(result.error)
  return result.state
}

describe('clampPointer', () => {
  it('never goes below 0', () => {
    expect(clampPointer(5, -3)).toBe(0)
  })

  it('never exceeds history length', () => {
    expect(clampPointer(5, 99)).toBe(5)
  })

  it('passes through an in-range value unchanged', () => {
    expect(clampPointer(5, 2)).toBe(2)
  })
})

describe('stateAtPointer', () => {
  it('pointer 0 reconstructs genesis exactly', () => {
    const genesis = makeGenesis()
    const state = choose(genesis, 'p1')
    expect(stripTimestamps(stateAtPointer(genesis, state.actionHistory, 0, unitContent))).toEqual(stripTimestamps(genesis))
  })

  it('pointer at the tip reconstructs the current state', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const tip = choose(afterP1, 'p2')
    expect(stripTimestamps(stateAtPointer(genesis, tip.actionHistory, tip.actionHistory.length, unitContent))).toEqual(stripTimestamps(tip))
  })

  it('a pointer behind the tip reconstructs an earlier state, undoing later entries non-destructively', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const tip = choose(afterP1, 'p2')

    const rewound = stateAtPointer(genesis, tip.actionHistory, 1, unitContent)
    expect(stripTimestamps(rewound)).toEqual(stripTimestamps(afterP1))
    // The full history is untouched by rewinding the read — nothing was deleted.
    expect(tip.actionHistory).toHaveLength(2)
  })
})

describe('applyActionAtPointer', () => {
  it('at the tip, behaves like an ordinary append with nothing archived', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')

    const { result, archivedTail } = applyActionAtPointer(
      genesis,
      afterP1.actionHistory,
      afterP1.actionHistory.length,
      { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') },
      unitContent,
    )

    expect(result.ok).toBe(true)
    expect(archivedTail).toEqual([])
    if (result.ok) expect(result.state.actionHistory).toHaveLength(2)
  })

  it('branching behind the tip prunes the abandoned entries and reports them as the archived tail', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const tip = choose(afterP1, 'p2')
    const abandonedEntry = tip.actionHistory[1]

    // p1 rewinds to right after their own choice (pointer 1) and picks a different card instead.
    const { result, archivedTail } = applyActionAtPointer(
      genesis,
      tip.actionHistory,
      1,
      { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'nomad') },
      unitContent,
    )

    expect(result.ok).toBe(true)
    expect(archivedTail).toEqual([abandonedEntry])
    if (result.ok) {
      expect(result.state.actionHistory).toHaveLength(2)
      expect(result.state.actionHistory[1].action).toEqual({ type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'nomad') })
    }
  })

  it('a rejected action archives nothing', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const tip = choose(afterP1, 'p2')

    // p1 already chose at genesis+1 — choosing again at pointer 0 is a legal
    // CHOOSE_CARD, but a wrong cardId is not.
    const { result, archivedTail } = applyActionAtPointer(genesis, tip.actionHistory, 0, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: 'not-a-real-card' }, unitContent)

    expect(result.ok).toBe(false)
    expect(archivedTail).toEqual([])
  })

  it('still validates ordinary legality against the pointer state, not just against the tip', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const tip = choose(afterP1, 'p2')

    // At pointer 1 (right after p1's own choice), p1 trying to choose again is illegal — they've already chosen.
    const { result } = applyActionAtPointer(genesis, tip.actionHistory, 1, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') }, unitContent)

    expect(result.ok).toBe(false)
  })
})

describe('branchDiscardsAnotherPlayersAction', () => {
  it('is false when the caller only discards their own pending entries', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    expect(branchDiscardsAnotherPlayersAction(afterP1.actionHistory, 0, 'p1')).toBe(false)
  })

  it('is true when the discarded tail includes another player\'s action', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const tip = choose(afterP1, 'p2')
    expect(branchDiscardsAnotherPlayersAction(tip.actionHistory, 0, 'p1')).toBe(true)
  })

  it('is false when pointer is already at the tip — nothing would be discarded', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const tip = choose(afterP1, 'p2')
    expect(branchDiscardsAnotherPlayersAction(tip.actionHistory, tip.actionHistory.length, 'p1')).toBe(false)
  })
})

describe('computeRevealedPhaseMarks (§5.3)', () => {
  it('has no mark while the selectCards phase still has a pending player', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const marks = computeRevealedPhaseMarks(genesis, afterP1.actionHistory, unitContent)
    expect(marks.has(revealMarkKey(genesis.turn, 'selectCards'))).toBe(false)
  })

  it('marks the phase revealed once every player has chosen and it resolves', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const tip = choose(afterP1, 'p2')
    expect(tip.roundPhase).toBe('actions')

    const marks = computeRevealedPhaseMarks(genesis, tip.actionHistory, unitContent)
    expect(marks.has(revealMarkKey(genesis.turn, 'selectCards'))).toBe(true)
  })

  it('a branch that leaves the phase genuinely unresolved produces no mark for it (§5.3: deleted when the resolving entry is pruned)', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const tip = choose(afterP1, 'p2')
    expect(computeRevealedPhaseMarks(genesis, tip.actionHistory, unitContent).has(revealMarkKey(genesis.turn, 'selectCards'))).toBe(true)

    // p1 rewinds all the way to genesis and retracts nothing — just
    // re-picks their own card, discarding p2's real pick entirely and
    // leaving p2 pending again.
    const { result } = applyActionAtPointer(genesis, tip.actionHistory, 0, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, unitContent)
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('selectCards')
    expect(result.state.pendingPlayerIds).toEqual(['p2'])

    const marksAfterBranch = computeRevealedPhaseMarks(genesis, result.state.actionHistory, unitContent)
    expect(marksAfterBranch.has(revealMarkKey(genesis.turn, 'selectCards'))).toBe(false)
  })
})
