import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { cardIdFor, createPlayerCards, syncCardZonesWithBoard } from '../cards'
import { createNewGame } from '../createGame'
import { beginSelectCardsPhase } from '../round'
import { buildTurnReview, findReviewWindowStart, findTurnStops, recapTurnFor, reviewPhaseGroupAt, roundPhaseForRecap, shouldShowCardChoiceRecap } from '../turnReview'
import type { LoggedAction } from '../actions'
import type { Card, GameState, Player, Terrain, Unit } from '../types'
import type { UnitAction, UnitContent } from '../unitContent'

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

function boardOf(cells: Array<[number, number, Terrain]>) {
  let board = createEmptyBoard('hex')
  for (const [q, r, terrain] of cells) board = setTile(board, { q, r }, terrain)
  return board
}

const CITY_ACTIONS: UnitAction[] = [
  { id: 'generate-income', name: 'Generate Income', description: '', effect: { actionType: 'income', goldByTerrain: { plain: 3 } } },
  { id: 'create-nomad', name: 'Create Nomad', description: '', effect: { actionType: 'create', targetUnit: 'nomad', targetHex: { location: 'adj' }, cost: {} } },
  {
    id: 'create-merchant',
    name: 'Convert to Merchant',
    description: '',
    effect: { actionType: 'convert', targetHex: { location: 'adj' }, targetOwner: 'own', targetMobileOnly: false, requiredTargetKind: 'nomad', resultUnit: 'merchant', cost: {} },
  },
]
const NOMAD_ACTIONS: UnitAction[] = [
  { id: 'produce-resource', name: 'Produce Resource', description: '', effect: { actionType: 'produce', resourceByTerrain: { forest: { wood: 2 } } } },
  { id: 'move', name: 'Move', description: '', effect: { actionType: 'move' } },
  {
    id: 'transform-to-city',
    name: 'Transform to City',
    description: '',
    effect: { actionType: 'transform', targetUnit: 'city', targetHex: { terrainType: ['plain'], location: 'self' }, destroySelf: true, cost: {} },
  },
  {
    id: 'transform-to-ship',
    name: 'Transform to Ship',
    description: '',
    effect: { actionType: 'transform', targetUnit: 'ship', targetHex: { terrainType: ['water'], location: 'adj' }, destroySelf: true, cost: {} },
  },
]
const TEMPLE_ACTIONS: UnitAction[] = [
  { id: 'convert-enemy-unit', name: 'Convert Enemy Unit', description: '', effect: { actionType: 'convert', targetHex: { location: 'adj' }, targetOwner: 'enemy', targetMobileOnly: false, cost: {} } },
]
const SHIP_ACTIONS: UnitAction[] = [{ id: 'trade', name: 'Trade', description: '', effect: { actionType: 'trade', goldPerCity: 5 } }]
const MERCHANT_ACTIONS: UnitAction[] = [
  { id: 'buy-wood', name: 'Buy Wood', description: '', effect: { actionType: 'trade-resource', resource: 'wood', mode: 'buy', resourceAmount: 1, goldPerResource: 5 } },
]

const content: UnitContent = {
  actionsByKind: { city: CITY_ACTIONS, nomad: NOMAD_ACTIONS, temple: TEMPLE_ACTIONS, ship: SHIP_ACTIONS, merchant: MERCHANT_ACTIONS },
  movementByKind: {
    city: { isMobile: false, terrains: [], canCrossCliffs: false },
    temple: { isMobile: false, terrains: [], canCrossCliffs: false },
    nomad: { isMobile: true, terrains: ['plain', 'forest'], canCrossCliffs: false, moveDistance: 1 },
    merchant: { isMobile: true, terrains: ['plain', 'forest', 'water'], canCrossCliffs: false, moveDistance: 4 },
    ship: { isMobile: true, terrains: ['water'], canCrossCliffs: false, moveDistance: 'unlimited' },
  },
  terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
  resourceCaps: { gold: null, wood: null, stone: null },
  unitSupplyCaps: {},
  companionKindsByCardKind: {},
  activationsPerTurnByKind: {},
}

function makeGenesis(units: Unit[], board: GameState['board'], extraDeclineForP1: string[] = []): GameState {
  const p1Cards = createPlayerCards('p1')
  const p2Cards = createPlayerCards('p2')
  const cards: Record<string, Card> = {}
  for (const c of [...p1Cards, ...p2Cards]) cards[c.id] = c
  const lobby = createNewGame({
    gameId: 'g',
    playMode: 'hotseat',
    board,
    players: [
      { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
    ],
    resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
  })
  const p1 = { ...makePlayer('p1', p1Cards), declineCardIds: extraDeclineForP1 }
  // Most callers only care about p1's own actions and never give p2 a unit
  // at all — leaving p2 with an empty hand, which beginSelectCardsPhase
  // would eliminate them for below. Since eliminatePlayer now ends the game
  // outright once only one player remains (elimination.ts), that would
  // complete the game before this genesis is even returned. So p2 is
  // excluded up front (not in turnOrder, marked eliminated) UNLESS the
  // caller actually gave them a unit (e.g. the enemyCity/enemyNomad
  // fixtures below, which need a real opposing player).
  const p2HasAUnit = units.some((u) => u.ownerId === 'p2')
  const active: GameState = {
    ...lobby,
    board,
    players: [p1, { ...makePlayer('p2', p2Cards), eliminated: !p2HasAUnit }],
    cards,
    turnOrder: p2HasAUnit ? ['p1', 'p2'] : ['p1'],
    units,
    status: 'active',
  }
  return beginSelectCardsPhase(syncCardZonesWithBoard(active))
}

/** Drives `actions` through applyAction in order, throwing with the failing action's index/error if any is rejected — every test below relies on its whole setup succeeding. */
function drive(state: GameState, actions: Parameters<typeof applyAction>[1][]): GameState {
  let next = state
  for (const [i, action] of actions.entries()) {
    const result = applyAction(next, action, content)
    if (!result.ok) throw new Error(`action ${i} (${action.type}) failed: ${result.error}`)
    next = result.state
  }
  return next
}

describe('findReviewWindowStart', () => {
  const historyFor = (playerIds: string[]): LoggedAction[] =>
    playerIds.map((playerId) => ({ action: { type: 'PASS_ACTIONS', playerId }, turn: 1, timestamp: '' }))

  it('finds the index right after the last action by that player', () => {
    expect(findReviewWindowStart(historyFor(['p1', 'p2', 'p1', 'p2', 'p2']), 'p1')).toBe(3)
  })

  it('returns 0 if the player has never acted', () => {
    expect(findReviewWindowStart(historyFor(['p2', 'p2']), 'p1')).toBe(0)
  })

  it('returns the full length if the player themselves is the very last actor', () => {
    expect(findReviewWindowStart(historyFor(['p2', 'p1']), 'p1')).toBe(2)
  })
})

describe('findTurnStops', () => {
  const historyFor = (playerIds: string[]): LoggedAction[] =>
    playerIds.map((playerId) => ({ action: { type: 'PASS_ACTIONS', playerId }, turn: 1, timestamp: '' }))

  it('returns just the window start when nothing has happened since it', () => {
    expect(findTurnStops(historyFor(['p1', 'p2']), 2)).toEqual([2])
  })

  it('splits a single other player\'s turn into one segment', () => {
    expect(findTurnStops(historyFor(['p1', 'p2', 'p2', 'p2']), 1)).toEqual([1, 4])
  })

  it('splits multiple players\' turns at each change of actor', () => {
    // p1 acted at index 0 (windowStart 1); p2 takes two actions, then p3
    // one, then p1 (the reviewer) is up again but hasn't acted yet.
    expect(findTurnStops(historyFor(['p1', 'p2', 'p2', 'p3']), 1)).toEqual([1, 3, 4])
  })

  it('treats consecutive same-player actions across the whole window as one segment even if interrupted turns repeat that player later', () => {
    expect(findTurnStops(historyFor(['p1', 'p2', 'p3', 'p2']), 1)).toEqual([1, 2, 3, 4])
  })

  it('covers the whole game (not just "since a player last acted") when passed windowStart 0 — GamePage.tsx\'s "Show history" bar (issue #261)', () => {
    expect(findTurnStops(historyFor(['p1', 'p2', 'p2', 'p3', 'p1']), 0)).toEqual([0, 1, 3, 4, 5])
  })

  it('returns just [0] for an empty actionHistory', () => {
    expect(findTurnStops([], 0)).toEqual([0])
  })

  it('aggregates a whole selectCards phase into one stop, regardless of the order players choose in (issue #322)', () => {
    const history: LoggedAction[] = [
      { action: { type: 'CHOOSE_CARD', playerId: 'p1', cardId: 'c1' }, turn: 1, timestamp: '' },
      { action: { type: 'CHOOSE_CARD', playerId: 'p2', cardId: 'c2' }, turn: 1, timestamp: '' },
      { action: { type: 'CHOOSE_CARD', playerId: 'p1', cardId: 'c3' }, turn: 1, timestamp: '' },
    ]
    expect(findTurnStops(history, 0)).toEqual([0, 3])
  })

  it('still splits the actions phase one stop per acting player (issue #322)', () => {
    const history: LoggedAction[] = [
      { action: { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, turn: 1, timestamp: '' },
      { action: { type: 'PASS_ACTIONS', playerId: 'p1' }, turn: 1, timestamp: '' },
      { action: { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [] }, turn: 1, timestamp: '' },
      { action: { type: 'PASS_ACTIONS', playerId: 'p2' }, turn: 1, timestamp: '' },
    ]
    expect(findTurnStops(history, 0)).toEqual([0, 2, 4])
  })

  it('merges decline and purchase into a single aggregated stop, and splits into a new stop on entering/leaving that combined phase (issue #322)', () => {
    const history: LoggedAction[] = [
      { action: { type: 'PASS_ACTIONS', playerId: 'p1' }, turn: 1, timestamp: '' },
      { action: { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: 'c1' }, turn: 1, timestamp: '' },
      { action: { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: 'c2' }, turn: 1, timestamp: '' },
      { action: { type: 'PURCHASE_CARD', playerId: 'p1', cardId: 'c1' }, turn: 1, timestamp: '' },
      { action: { type: 'PASS_PURCHASE', playerId: 'p2' }, turn: 1, timestamp: '' },
      { action: { type: 'CHOOSE_CARD', playerId: 'p1', cardId: 'c4' }, turn: 2, timestamp: '' },
    ]
    expect(findTurnStops(history, 0)).toEqual([0, 1, 5, 6])
  })

  it('a CONCEDE mid-phase inherits the surrounding group instead of forcing its own stop', () => {
    const history: LoggedAction[] = [
      { action: { type: 'CHOOSE_CARD', playerId: 'p1', cardId: 'c1' }, turn: 1, timestamp: '' },
      { action: { type: 'CONCEDE', playerId: 'p2' }, turn: 1, timestamp: '' },
      { action: { type: 'CHOOSE_CARD', playerId: 'p3', cardId: 'c3' }, turn: 1, timestamp: '' },
    ]
    expect(findTurnStops(history, 0)).toEqual([0, 3])
  })
})

describe('reviewPhaseGroupAt', () => {
  it("reports 'selectCards' for a stop inside a simultaneous card-selection phase (issue #324)", () => {
    const history: LoggedAction[] = [
      { action: { type: 'CHOOSE_CARD', playerId: 'p1', cardId: 'c1' }, turn: 1, timestamp: '' },
      { action: { type: 'CHOOSE_CARD', playerId: 'p2', cardId: 'c2' }, turn: 1, timestamp: '' },
    ]
    expect(reviewPhaseGroupAt(history, 2)).toBe('selectCards')
  })

  it("reports 'declinePurchase' for a stop inside the merged decline/purchase phase (issue #324)", () => {
    const history: LoggedAction[] = [
      { action: { type: 'PASS_ACTIONS', playerId: 'p1' }, turn: 1, timestamp: '' },
      { action: { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: 'c1' }, turn: 1, timestamp: '' },
      { action: { type: 'PASS_PURCHASE', playerId: 'p2' }, turn: 1, timestamp: '' },
    ]
    expect(reviewPhaseGroupAt(history, 3)).toBe('declinePurchase')
  })

  it("reports 'actions' for a turn-order stop, where a single player is meaningfully 'next'", () => {
    const history: LoggedAction[] = [
      { action: { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [] }, turn: 1, timestamp: '' },
      { action: { type: 'PASS_ACTIONS', playerId: 'p1' }, turn: 1, timestamp: '' },
    ]
    expect(reviewPhaseGroupAt(history, 2)).toBe('actions')
  })

  it('a trailing CONCEDE inherits the group of the phase it interrupted', () => {
    const history: LoggedAction[] = [
      { action: { type: 'CHOOSE_CARD', playerId: 'p1', cardId: 'c1' }, turn: 1, timestamp: '' },
      { action: { type: 'CONCEDE', playerId: 'p2' }, turn: 1, timestamp: '' },
    ]
    expect(reviewPhaseGroupAt(history, 2)).toBe('selectCards')
  })
})

describe('roundPhaseForRecap', () => {
  const fakeState = (roundPhase: GameState['roundPhase'], status: GameState['status'] = 'active'): GameState => ({ roundPhase, status }) as GameState

  it("reports 'purchase' for a completed (non-tail) declinePurchase stop, even though its replayed state already chained into the next round's selectCards", () => {
    const history: LoggedAction[] = [
      { action: { type: 'PASS_ACTIONS', playerId: 'p1' }, turn: 1, timestamp: '' },
      { action: { type: 'PASS_PURCHASE', playerId: 'p1' }, turn: 1, timestamp: '' },
      { action: { type: 'CHOOSE_CARD', playerId: 'p1', cardId: 'c2' }, turn: 2, timestamp: '' },
    ]
    expect(roundPhaseForRecap(history, 2, fakeState('selectCards'))).toBe('purchase')
  })

  it("reports 'purchase' at the live tail once the game has actually completed mid-purchase (finishRound's early-return path never increments turn or changes roundPhase)", () => {
    const history: LoggedAction[] = [{ action: { type: 'PASS_PURCHASE', playerId: 'p1' }, turn: 1, timestamp: '' }]
    expect(roundPhaseForRecap(history, 1, fakeState('purchase', 'completed'))).toBe('purchase')
  })

  it('trusts the replayed roundPhase as-is at the live tail while decline/purchase is still genuinely in progress (no next action to prove the group is done)', () => {
    const history: LoggedAction[] = [{ action: { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: 'c1' }, turn: 1, timestamp: '' }]
    expect(roundPhaseForRecap(history, 1, fakeState('decline'))).toBe('decline')
    expect(roundPhaseForRecap(history, 1, fakeState('purchase'))).toBe('purchase')
  })

  it('passes the replayed roundPhase through unchanged outside the actions/declinePurchase groups', () => {
    const history: LoggedAction[] = [{ action: { type: 'CHOOSE_CARD', playerId: 'p1', cardId: 'c1' }, turn: 1, timestamp: '' }]
    expect(roundPhaseForRecap(history, 1, fakeState('actions'))).toBe('actions')
  })

  it("reports 'actions' for a completed actions-group stop even though its replayed state already chained straight into 'purchase' (e.g. no achievement claimed this round, so decline was skipped entirely)", () => {
    const history: LoggedAction[] = [{ action: { type: 'PASS_ACTIONS', playerId: 'p1' }, turn: 1, timestamp: '' }]
    expect(roundPhaseForRecap(history, 1, fakeState('purchase'))).toBe('actions')
  })

  it("reports 'actions' for a completed actions-group stop even though its replayed state already chained all the way through to the next round's selectCards (nothing pending in either decline or purchase)", () => {
    const history: LoggedAction[] = [{ action: { type: 'PASS_ACTIONS', playerId: 'p1' }, turn: 1, timestamp: '' }]
    expect(roundPhaseForRecap(history, 1, fakeState('selectCards'))).toBe('actions')
  })

  it("reports 'actions' for the live tail right after the actions group's last action, same as a historical stop", () => {
    const history: LoggedAction[] = [{ action: { type: 'PASS_ACTIONS', playerId: 'p1' }, turn: 1, timestamp: '' }]
    expect(roundPhaseForRecap(history, history.length, fakeState('purchase'))).toBe('actions')
  })
})

describe('recapTurnFor', () => {
  const fakeState = (roundPhase: GameState['roundPhase'], turn: number): GameState => ({ roundPhase, turn }) as GameState

  it('is the replayed turn itself while still genuinely mid-round (actions/decline/purchase)', () => {
    expect(recapTurnFor(fakeState('actions', 3))).toBe(3)
    expect(recapTurnFor(fakeState('decline', 3))).toBe(3)
    expect(recapTurnFor(fakeState('purchase', 3))).toBe(3)
  })

  it("is turn - 1 once the replayed state has already auto-chained into the NEXT round's selectCards, since finishRound bumps turn before that", () => {
    expect(recapTurnFor(fakeState('selectCards', 4))).toBe(3)
  })
})

describe('shouldShowCardChoiceRecap', () => {
  it("never shows for 'selectCards'/'decline' themselves, regardless of step mode", () => {
    expect(shouldShowCardChoiceRecap('selectCards', 1, null, 'turn')).toBe(false)
    expect(shouldShowCardChoiceRecap('decline', 1, null, 'turn')).toBe(false)
    expect(shouldShowCardChoiceRecap('selectCards', 1, { roundPhase: 'selectCards', recapTurn: 1 }, 'action')).toBe(false)
    expect(shouldShowCardChoiceRecap('decline', 1, { roundPhase: 'actions', recapTurn: 1 }, 'action')).toBe(false)
  })

  it('always shows for actions/purchase in action-by-action mode, regardless of the previous stop', () => {
    expect(shouldShowCardChoiceRecap('actions', 1, { roundPhase: 'actions', recapTurn: 1 }, 'action')).toBe(true)
    expect(shouldShowCardChoiceRecap('purchase', 1, { roundPhase: 'purchase', recapTurn: 1 }, 'action')).toBe(true)
    expect(shouldShowCardChoiceRecap('actions', 1, null, 'action')).toBe(true)
  })

  it("shows for the FIRST turn-stop of 'actions' — right as selectCards flips over — since selectCards's own single stop already replays as roundPhase 'actions' (applyChooseCard's atomic transition)", () => {
    expect(shouldShowCardChoiceRecap('actions', 1, { roundPhase: 'selectCards', recapTurn: 1 }, 'turn')).toBe(true)
  })

  it("does NOT keep showing for every subsequent per-player turn-stop within 'actions' (issue #326) — roundPhase and recapTurn stay the same for the whole group, but the previous stop already showed it", () => {
    expect(shouldShowCardChoiceRecap('actions', 1, { roundPhase: 'actions', recapTurn: 1 }, 'turn')).toBe(false)
  })

  it("shows for 'declinePurchase' group's single turn-stop, right as 'actions' flips over", () => {
    expect(shouldShowCardChoiceRecap('purchase', 1, { roundPhase: 'actions', recapTurn: 1 }, 'turn')).toBe(true)
  })

  it('shows when there is no previous stop at all (genesis, or the first stop in a windowed review)', () => {
    expect(shouldShowCardChoiceRecap('actions', 1, null, 'turn')).toBe(true)
    expect(shouldShowCardChoiceRecap('purchase', 1, null, 'turn')).toBe(true)
  })

  it("shows a NEW round's 'actions' recap even though roundPhaseForRecap reports the same 'actions' string as the PREVIOUS round's auto-chained tail stop (issue #331: a round with no decline/purchase phase auto-chains straight into the next round, and if that next round's own card picks also land on 'actions', the bare phase string alone can't tell the two apart)", () => {
    expect(shouldShowCardChoiceRecap('actions', 2, { roundPhase: 'actions', recapTurn: 1 }, 'turn')).toBe(true)
  })

  it("still suppresses the auto-chained tail stop itself against the actions group's earlier per-player stops — same round, so same recapTurn", () => {
    expect(shouldShowCardChoiceRecap('actions', 1, { roundPhase: 'actions', recapTurn: 1 }, 'turn')).toBe(false)
  })
})

describe('buildTurnReview', () => {
  it('records a move as a "moved" event with from/to coordinates', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const nomad: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([nomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'nomad_a', actionId: 'move', target: { q: 1, r: 0 } }] },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    expect(review.events).toContainEqual({ unitId: 'nomad_a', playerId: 'p1', type: 'moved', from: { q: 0, r: 0 }, to: { q: 1, r: 0 } })
  })

  it('records a create effect as a "created" event for the new unit', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const genesis = makeGenesis([city], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'create-nomad', target: { q: 1, r: 0 } }] },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    const created = review.events.find((e) => e.type === 'created')
    expect(created).toBeTruthy()
    expect(created?.to).toEqual({ q: 1, r: 0 })
    expect(created?.playerId).toBe('p1')
  })

  it('records a destroySelf transform as a "created" event for the resulting unit (the source id just disappears)', () => {
    const board = boardOf([[0, 0, 'plain']])
    const nomad: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([nomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'nomad_a', actionId: 'transform-to-city' }] },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    const newCityId = state.units.find((u) => u.kind === 'city')!.id
    expect(review.events).toContainEqual({ unitId: newCityId, playerId: 'p1', type: 'created', to: { q: 0, r: 0 } })
    // No event references the old id — it's gone, not "converted" or "moved".
    expect(review.events.some((e) => e.unitId === 'nomad_a')).toBe(false)
  })

  it('records an adjacent-hex transform (e.g. Nomad -> Ship) as BOTH a "created" event and a "moved" event, so history draws an arrow from the source hex', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'water'],
    ])
    const nomad: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([nomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'nomad_a', actionId: 'transform-to-ship', target: { q: 1, r: 0 } }] },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    const newShipId = state.units.find((u) => u.kind === 'ship')!.id
    expect(review.events).toContainEqual({ unitId: newShipId, playerId: 'p1', type: 'created', to: { q: 1, r: 0 } })
    expect(review.events).toContainEqual({ unitId: newShipId, playerId: 'p1', type: 'moved', from: { q: 0, r: 0 }, to: { q: 1, r: 0 } })
    // No event references the old id — it's gone, same as the self-transform case above.
    expect(review.events.some((e) => e.unitId === 'nomad_a')).toBe(false)
  })

  it('records a produce effect as a "produced" event with the resource delta', () => {
    const board = boardOf([[0, 0, 'forest']])
    const nomad: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([nomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'nomad_a', actionId: 'produce-resource' }] },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    expect(review.events).toContainEqual({ unitId: 'nomad_a', playerId: 'p1', type: 'produced', to: { q: 0, r: 0 }, resourceDelta: { wood: 2 } })
  })

  it('records an income effect as an "income" event with the gold delta', () => {
    const board = boardOf([[0, 0, 'plain']])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const genesis = makeGenesis([city], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    expect(review.events).toContainEqual({ unitId: 'city_a', playerId: 'p1', type: 'income', to: { q: 0, r: 0 }, resourceDelta: { gold: 3 } })
  })

  it("records Ship's Trade action (actionType 'trade') as an 'income' event too", () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'plain'],
    ])
    const ship: Unit = { id: 'ship_a', ownerId: 'p1', kind: 'ship', coord: { q: 0, r: 0 }, movement: content.movementByKind.ship, traits: [] }
    const enemyCity: Unit = { id: 'city_enemy', ownerId: 'p2', kind: 'city', coord: { q: 1, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const genesis = makeGenesis([ship, enemyCity], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') },
      { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'ship_a', actionId: 'trade' }] },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    expect(review.events).toContainEqual({ unitId: 'ship_a', playerId: 'p1', type: 'income', to: { q: 0, r: 0 }, resourceDelta: { gold: 5 } })
  })

  it("records a Merchant's trade-resource action as a 'traded' event with both the resource and gold deltas", () => {
    const board = boardOf([[0, 0, 'plain']])
    const merchant: Unit = { id: 'merchant_a', ownerId: 'p1', kind: 'merchant', coord: { q: 0, r: 0 }, movement: content.movementByKind.merchant, traits: [] }
    const genesis = makeGenesis([merchant], board)
    let stateWithGold = genesis
    stateWithGold = { ...stateWithGold, players: stateWithGold.players.map((p) => (p.id === 'p1' ? { ...p, resources: { gold: 10, wood: 0, stone: 0 } } : p)) }
    const state = drive(stateWithGold, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'merchant') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'merchant_a', actionId: 'buy-wood' }] },
    ])

    const review = buildTurnReview(stateWithGold, state.actionHistory, content)
    expect(review.events).toContainEqual({ unitId: 'merchant_a', playerId: 'p1', type: 'traded', to: { q: 0, r: 0 }, resourceDelta: { gold: -5, wood: 1 } })
  })

  it("records a City's own-Nomad convert as a 'converted' event on the SAME unit id (kind changes, id doesn't)", () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const nomad: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([city, nomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'create-merchant', target: { q: 1, r: 0 } }] },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    expect(review.events).toContainEqual({ unitId: 'nomad_a', playerId: 'p1', type: 'converted', to: { q: 1, r: 0 } })
  })

  it("records Temple stealing an enemy unit as a 'converted' event (owner changes, kind doesn't)", () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const temple: Unit = { id: 'temple_a', ownerId: 'p1', kind: 'temple', coord: { q: 0, r: 0 }, movement: content.movementByKind.temple, traits: [] }
    const enemyNomad: Unit = { id: 'nomad_enemy', ownerId: 'p2', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([temple, enemyNomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'temple') },
      { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'nomad') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'temple_a', actionId: 'convert-enemy-unit', target: { q: 1, r: 0 } }] },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    expect(review.events).toContainEqual({ unitId: 'nomad_enemy', playerId: 'p1', type: 'converted', to: { q: 1, r: 0 } })
  })

  it('attributes distinct events to each unit in a multi-assignment RESOLVE_UNIT_ACTION, without conflating them', () => {
    const board = boardOf([
      [0, 0, 'forest'],
      [5, 0, 'plain'],
    ])
    const nomadA: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const nomadB: Unit = { id: 'nomad_b', ownerId: 'p1', kind: 'nomad', coord: { q: 5, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([nomadA, nomadB], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') },
      {
        type: 'RESOLVE_UNIT_ACTION',
        playerId: 'p1',
        unitActions: [
          { unitId: 'nomad_a', actionId: 'produce-resource' },
          { unitId: 'nomad_b', actionId: 'transform-to-city' },
        ],
      },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    expect(review.events).toContainEqual({ unitId: 'nomad_a', playerId: 'p1', type: 'produced', to: { q: 0, r: 0 }, resourceDelta: { wood: 2 } })
    const newCityId = state.units.find((u) => u.kind === 'city')!.id
    expect(review.events).toContainEqual({ unitId: newCityId, playerId: 'p1', type: 'created', to: { q: 5, r: 0 } })
    // nomad_a's produce didn't leak a spurious event onto nomad_b or vice versa.
    expect(review.events).toHaveLength(2)
  })

  it('sums net resource change per player across the whole window, not just one action', () => {
    // Two Cities so p1's turn stays open across two separate
    // RESOLVE_UNIT_ACTION dispatches (a single acting unit auto-ends the
    // turn the moment it resolves — see applyResolveUnitAction).
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const cityA: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const cityB: Unit = { id: 'city_b', ownerId: 'p1', kind: 'city', coord: { q: 1, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const genesis = makeGenesis([cityA, cityB], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_b', actionId: 'generate-income' }] },
    ])

    const review = buildTurnReview(genesis, state.actionHistory, content)
    expect(review.resourceDeltaByPlayerId.p1).toEqual({ gold: 6, wood: 0, stone: 0 })
    expect(review.events.filter((e) => e.type === 'income')).toHaveLength(2)
  })
})
