import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { cardIdFor, createPlayerCards, syncCardZonesWithBoard } from '../cards'
import { createNewGame } from '../createGame'
import { beginSelectCardsPhase } from '../round'
import type { Card, GameState, Player } from '../types'
import { applyRedoAction, applyUndoAction, resolveHistory } from '../undoRedo'
import type { UnitContent } from '../unitContent'

/** Strips wall-clock timestamps before a deep-equality comparison — every applyAction()/applyUndoAction()/applyRedoAction() call stamps real time. */
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

/** An active-round genesis (mirrors replay.test.ts/historyPointer.test.ts's makeGenesis). */
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
      { id: 'nomad_b', ownerId: 'p2', kind: 'nomad', coord: { q: 5, r: 0 }, movement: unitContent.movementByKind.nomad, traits: [] },
    ],
    status: 'active',
  }
  return beginSelectCardsPhase(syncCardZonesWithBoard(active))
}

function choose(state: GameState, playerId: string, kind: 'city' | 'nomad' = 'city') {
  const result = applyAction(state, { type: 'CHOOSE_CARD', playerId, cardId: cardIdFor(playerId, kind) }, unitContent)
  if (!result.ok) throw new Error(result.error)
  return result.state
}

describe('applyUndoAction', () => {
  it('rejects when there is nothing to undo', () => {
    const genesis = makeGenesis()
    const result = applyUndoAction(genesis, genesis, 'p1', unitContent)
    expect(result.ok).toBe(false)
  })

  it('appends an UNDO_ACTION entry (the raw history grows, nothing is removed) and reconstructs the prior state', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')

    const result = applyUndoAction(genesis, afterP1, 'p1', unitContent)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.state.actionHistory).toHaveLength(2)
    expect(result.state.actionHistory[0].action).toEqual(afterP1.actionHistory[0].action)
    expect(result.state.actionHistory[1].action).toEqual({ type: 'UNDO_ACTION', playerId: 'p1' })
    // The effective (derived) state matches genesis exactly.
    expect(stripTimestamps(result.state)).toEqual({ ...stripTimestamps(genesis), actionHistory: stripTimestamps(result.state).actionHistory })
    expect(resolveHistory(result.state.actionHistory).effective).toEqual([])
  })

  it('accepts a null playerId (Undo is not gated on a specific seated player)', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const result = applyUndoAction(genesis, afterP1, null, unitContent)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.state.actionHistory[1].action).toEqual({ type: 'UNDO_ACTION', playerId: null })
  })

  it('unwinds status: completed back to active, same as the old truncation-based undo', () => {
    // Minimal one-action "game end": reuse CONCEDE's last-player-standing
    // rule (elimination.ts) — p2 conceding while p1 is the only one left
    // ends the game immediately.
    const genesis = makeGenesis()
    const concedeResult = applyAction(genesis, { type: 'CONCEDE', playerId: 'p2' }, unitContent)
    if (!concedeResult.ok) throw new Error(concedeResult.error)
    expect(concedeResult.state.status).toBe('completed')

    const undone = applyUndoAction(genesis, concedeResult.state, 'p1', unitContent)
    expect(undone.ok).toBe(true)
    if (undone.ok) expect(undone.state.status).toBe('active')
  })
})

describe('applyRedoAction', () => {
  it('rejects when nothing has been undone', () => {
    const genesis = makeGenesis()
    const result = applyRedoAction(genesis, genesis, 'p1', unitContent)
    expect(result.ok).toBe(false)
  })

  it('restores exactly the state from right before the undo', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const undone = applyUndoAction(genesis, afterP1, 'p1', unitContent)
    if (!undone.ok) throw new Error('setup failed')

    const redone = applyRedoAction(genesis, undone.state, 'p1', unitContent)
    expect(redone.ok).toBe(true)
    if (!redone.ok) return

    expect(redone.state.actionHistory).toHaveLength(3)
    expect(redone.state.actionHistory[2].action).toEqual({ type: 'REDO_ACTION', playerId: 'p1' })
    expect(resolveHistory(redone.state.actionHistory).effective.map((e) => e.action)).toEqual([afterP1.actionHistory[0].action])
    // The derived GameState (board/players/roundPhase/etc.) matches afterP1 exactly.
    const { actionHistory: _redoneHistory, ...redoneRest } = stripTimestamps(redone.state)
    const { actionHistory: _afterP1History, ...afterP1Rest } = stripTimestamps(afterP1)
    expect(redoneRest).toEqual(afterP1Rest)
  })

  it('a fresh branch after an undo permanently drops the redo option, without deleting the abandoned entry from raw history', () => {
    const genesis = makeGenesis()
    const afterP1City = choose(genesis, 'p1')
    const undone = applyUndoAction(genesis, afterP1City, 'p1', unitContent)
    if (!undone.ok) throw new Error('setup failed')
    expect(resolveHistory(undone.state.actionHistory).canRedo).toBe(true)

    // p1 branches onto a different choice instead of redoing the original one.
    const branched = applyAction(undone.state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, unitContent)
    if (!branched.ok) throw new Error(branched.error)

    expect(resolveHistory(branched.state.actionHistory).canRedo).toBe(false)
    const redoAttempt = applyRedoAction(genesis, branched.state, 'p1', unitContent)
    expect(redoAttempt.ok).toBe(false)
    // The original CHOOSE_CARD is still sitting in the raw log, just unreachable.
    expect(branched.state.actionHistory.map((e) => e.action)).toContainEqual(afterP1City.actionHistory[0].action)
  })

  it('multiple undos followed by multiple redos round-trip back to the original tip, in the right order', () => {
    const genesis = makeGenesis()
    const afterP1 = choose(genesis, 'p1')
    const tip = choose(afterP1, 'p2')

    let state = tip
    for (let i = 0; i < 2; i++) {
      const result = applyUndoAction(genesis, state, 'p1', unitContent)
      if (!result.ok) throw new Error(result.error)
      state = result.state
    }
    expect(resolveHistory(state.actionHistory).effective).toEqual([])

    for (let i = 0; i < 2; i++) {
      const result = applyRedoAction(genesis, state, 'p1', unitContent)
      if (!result.ok) throw new Error(result.error)
      state = result.state
    }

    expect(resolveHistory(state.actionHistory).effective.map((e) => e.action)).toEqual(tip.actionHistory.map((e) => e.action))
    const { actionHistory: _stateHistory, ...stateRest } = stripTimestamps(state)
    const { actionHistory: _tipHistory, ...tipRest } = stripTimestamps(tip)
    expect(stateRest).toEqual(tipRest)
  })
})
