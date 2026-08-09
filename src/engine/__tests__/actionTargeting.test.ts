import { describe, expect, it } from 'vitest'
import { legalConvertTargets, legalCreateTargets, legalTransformTargets } from '../actionTargeting'
import { createEmptyBoard, setTile } from '../board'
import type { ConvertEffect, CreateEffect, TransformEffect, UnitContent } from '../unitContent'
import type { Coordinate, GameState, Player, Terrain, Unit } from '../types'

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

let unitCounter = 0
function makeUnit(ownerId: string, kind: string, coord: Coordinate, overrides: Partial<Unit['movement']> = {}): Unit {
  unitCounter += 1
  return {
    id: `unit_${unitCounter}`,
    ownerId,
    kind,
    coord,
    movement: { isMobile: true, terrains: [], canCrossCliffs: false, ...overrides },
    traits: [],
  }
}

function boardOf(cells: Array<[number, number, Terrain]>) {
  let board = createEmptyBoard('hex')
  for (const [q, r, terrain] of cells) board = setTile(board, { q, r }, terrain)
  return board
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    gameId: 'g1',
    playMode: 'hotseat',
    status: 'active',
    turn: 1,
    activePlayerId: null,
    roundPhase: 'actions',
    chosenCardIdByPlayerId: {},
    pendingPlayerIds: [],
    turnOrder: ['p1', 'p2'],
    board: createEmptyBoard('hex'),
    players: [makePlayer('p1'), makePlayer('p2')],
    units: [],
    cards: {},
    resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
    unitLimits: {},
    log: [],
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    ...overrides,
  }
}

const terrainLevels: Record<string, number> = { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 }
const emptyContent: UnitContent = { actionsByKind: {}, movementByKind: {}, terrainLevels, resourceCaps: {}, unitSupplyCaps: {} }

describe('legalCreateTargets', () => {
  const effect: CreateEffect = { actionType: 'create', targetUnit: 'nomad', targetHex: { location: 'adj' }, cost: { gold: 1 } }

  it('returns every adjacent tiled, unoccupied, non-cliff hex', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [1, -1, 'plain'],
    ])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } })] })

    expect(legalCreateTargets(state, 'p1', unit, effect, emptyContent)).toEqual(
      expect.arrayContaining([{ q: 1, r: 0 }, { q: 1, r: -1 }]),
    )
  })

  it('excludes an occupied adjacent hex', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const blocker = makeUnit('p2', 'nomad', { q: 1, r: 0 })
    const state = makeState({
      board,
      units: [unit, blocker],
      players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } })],
    })

    expect(legalCreateTargets(state, 'p1', unit, effect, emptyContent)).toEqual([])
  })

  it('excludes a hex across a cliff edge', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'mountain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } })] })

    expect(legalCreateTargets(state, 'p1', unit, effect, emptyContent)).toEqual([])
  })

  it('returns nothing if the player cannot afford the cost', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1', { resources: { gold: 0, wood: 0, stone: 0 } })] })

    expect(legalCreateTargets(state, 'p1', unit, effect, emptyContent)).toEqual([])
  })

  it('returns nothing once the target kind is at its supply cap', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } })] })
    const content: UnitContent = { ...emptyContent, unitSupplyCaps: { nomad: 0 } }

    expect(legalCreateTargets(state, 'p1', unit, effect, content)).toEqual([])
  })
})

describe('legalTransformTargets', () => {
  it('self location: returns the unit\'s own hex only if the terrain matches', () => {
    const effect: TransformEffect = {
      actionType: 'transform',
      targetUnit: 'city',
      targetHex: { terrainType: ['plain', 'forest'], location: 'self' },
      destroySelf: true,
      cost: {},
    }
    const onPlain = makeUnit('p1', 'nomad', { q: 0, r: 0 })
    const state = makeState({ board: boardOf([[0, 0, 'plain']]), units: [onPlain], players: [makePlayer('p1')] })
    expect(legalTransformTargets(state, 'p1', onPlain, effect, emptyContent)).toEqual([{ q: 0, r: 0 }])

    const onWater = makeUnit('p1', 'nomad', { q: 0, r: 0 })
    const stateWater = makeState({ board: boardOf([[0, 0, 'water']]), units: [onWater], players: [makePlayer('p1')] })
    expect(legalTransformTargets(stateWater, 'p1', onWater, effect, emptyContent)).toEqual([])
  })

  it('adj location: filters by terrain type, occupancy, and cliffs', () => {
    const effect: TransformEffect = {
      actionType: 'transform',
      targetUnit: 'ship',
      targetHex: { terrainType: ['water'], location: 'adj' },
      destroySelf: true,
      cost: {},
    }
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'water'],
      [1, -1, 'plain'],
    ])
    const unit = makeUnit('p1', 'nomad', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1')] })
    expect(legalTransformTargets(state, 'p1', unit, effect, emptyContent)).toEqual([{ q: 1, r: 0 }])
  })
})

describe('legalConvertTargets', () => {
  const effect: ConvertEffect = { actionType: 'convert', targetHex: { location: 'adj' }, targetOwner: 'enemy', targetMobileOnly: true, cost: {} }

  it('returns adjacent hexes with an enemy mobile unit', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'temple', { q: 0, r: 0 })
    const enemy = makeUnit('p2', 'nomad', { q: 1, r: 0 }, { isMobile: true })
    const state = makeState({ board, units: [unit, enemy], players: [makePlayer('p1'), makePlayer('p2')] })
    const content: UnitContent = { ...emptyContent, movementByKind: { nomad: { isMobile: true, terrains: [], canCrossCliffs: false } } }

    expect(legalConvertTargets(state, 'p1', unit, effect, content)).toEqual([{ q: 1, r: 0 }])
  })

  it('excludes an immobile enemy unit when targetMobileOnly is set', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'temple', { q: 0, r: 0 })
    const enemy = makeUnit('p2', 'city', { q: 1, r: 0 }, { isMobile: false })
    const state = makeState({ board, units: [unit, enemy], players: [makePlayer('p1'), makePlayer('p2')] })

    expect(legalConvertTargets(state, 'p1', unit, effect, emptyContent)).toEqual([])
  })

  it('excludes an own unit', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'temple', { q: 0, r: 0 })
    const own = makeUnit('p1', 'nomad', { q: 1, r: 0 }, { isMobile: true })
    const state = makeState({ board, units: [unit, own], players: [makePlayer('p1')] })

    expect(legalConvertTargets(state, 'p1', unit, effect, emptyContent)).toEqual([])
  })
})
