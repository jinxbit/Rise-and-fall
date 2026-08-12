import { describe, expect, it } from 'vitest'
import { isActionAvailableForUnit, legalConvertTargets, legalCreateTargets, legalTransformTargets } from '../actionTargeting'
import { createEmptyBoard, setTile } from '../board'
import type { ConvertEffect, CreateEffect, TransformEffect, UnitAction, UnitContent } from '../unitContent'
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
    resolvedUnitIdsThisTurn: [],
    unitsCreatedThisTurn: [],
    turnOrder: ['p1', 'p2'],
    board: createEmptyBoard('hex'),
    players: [makePlayer('p1'), makePlayer('p2')],
    units: [],
    cards: {},
    resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
    ...overrides,
  }
}

const terrainLevels: Record<string, number> = { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 }
const emptyContent: UnitContent = { actionsByKind: {}, movementByKind: {}, terrainLevels, resourceCaps: {}, unitSupplyCaps: {}, companionKindsByCardKind: {} }

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

  it('excludes a Water hex for a non-Ship target unit', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [1, -1, 'plain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } })] })

    expect(legalCreateTargets(state, 'p1', unit, effect, emptyContent)).toEqual([{ q: 1, r: -1 }])
  })

  it('includes a Water hex when the target unit is a Ship', () => {
    const shipEffect: CreateEffect = { actionType: 'create', targetUnit: 'ship', targetHex: { location: 'adj' }, cost: {} }
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1')] })

    expect(legalCreateTargets(state, 'p1', unit, shipEffect, emptyContent)).toEqual([{ q: 1, r: 0 }])
  })

  it('excludes a Glacier hex for a non-Mountaineer target unit', () => {
    // Mountain, not Plain, adjacent to Glacier: their terrain levels are
    // only 1 apart, so this isn't also blocked by the unrelated cliff rule
    // — the exclusion below is only ever about the Glacier restriction.
    const board = boardOf([[0, 0, 'mountain'], [1, 0, 'glacier'], [1, -1, 'mountain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } })] })

    expect(legalCreateTargets(state, 'p1', unit, effect, emptyContent)).toEqual([{ q: 1, r: -1 }])
  })

  it('includes a Glacier hex when the target unit is a Mountaineer', () => {
    const mountaineerEffect: CreateEffect = { actionType: 'create', targetUnit: 'mountaineer', targetHex: { location: 'adj' }, cost: {} }
    const board = boardOf([[0, 0, 'mountain'], [1, 0, 'glacier']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1')] })

    expect(legalCreateTargets(state, 'p1', unit, mountaineerEffect, emptyContent)).toEqual([{ q: 1, r: 0 }])
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

  it('excludes Water for a non-Ship target unit even if the content terrainType mistakenly allows it', () => {
    const effect: TransformEffect = {
      actionType: 'transform',
      targetUnit: 'city',
      targetHex: { terrainType: ['water'], location: 'adj' },
      destroySelf: true,
      cost: {},
    }
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water']])
    const unit = makeUnit('p1', 'nomad', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1')] })

    expect(legalTransformTargets(state, 'p1', unit, effect, emptyContent)).toEqual([])
  })

  it('excludes Glacier for a non-Mountaineer target unit even if the content terrainType mistakenly allows it', () => {
    const effect: TransformEffect = {
      actionType: 'transform',
      targetUnit: 'city',
      targetHex: { terrainType: ['glacier'], location: 'adj' },
      destroySelf: true,
      cost: {},
    }
    // Mountain, not Plain, adjacent to Glacier — see the analogous
    // legalCreateTargets test above for why (isolates this from the
    // unrelated cliff rule).
    const board = boardOf([[0, 0, 'mountain'], [1, 0, 'glacier']])
    const unit = makeUnit('p1', 'nomad', { q: 0, r: 0 })
    const state = makeState({ board, units: [unit], players: [makePlayer('p1')] })

    expect(legalTransformTargets(state, 'p1', unit, effect, emptyContent)).toEqual([])
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

  it("excludes an adjacent enemy unit once the capturer's own supply of that kind is full (bug: capturing an enemy unit never checked the capturer's supply at all, since it has no resultUnit override to change kind)", () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [9, 9, 'plain']])
    const unit = makeUnit('p1', 'temple', { q: 0, r: 0 })
    const enemy = makeUnit('p2', 'nomad', { q: 1, r: 0 }, { isMobile: true })
    // p1 already has a Nomad elsewhere, filling their cap of 1.
    const ownNomad = makeUnit('p1', 'nomad', { q: 9, r: 9 }, { isMobile: true })
    const state = makeState({ board, units: [unit, enemy, ownNomad], players: [makePlayer('p1'), makePlayer('p2')] })
    const content: UnitContent = {
      ...emptyContent,
      movementByKind: { nomad: { isMobile: true, terrains: [], canCrossCliffs: false } },
      unitSupplyCaps: { nomad: 1 },
    }

    expect(legalConvertTargets(state, 'p1', unit, effect, content)).toEqual([])
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

  it("costByTargetKind: filters per-target affordability instead of one flat cost for the whole action (Temple's Convert Enemy Unit costs more for pricier targets)", () => {
    const effectWithVaryingCost: ConvertEffect = {
      ...effect,
      cost: { gold: 999 },
      costByTargetKind: { nomad: { gold: 2 }, ship: { gold: 5 } },
    }
    const content: UnitContent = {
      ...emptyContent,
      movementByKind: {
        nomad: { isMobile: true, terrains: [], canCrossCliffs: false },
        ship: { isMobile: true, terrains: ['water'], canCrossCliffs: false },
      },
    }
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [-1, 0, 'plain']])
    const unit = makeUnit('p1', 'temple', { q: 0, r: 0 })
    const enemyNomad = makeUnit('p2', 'nomad', { q: 1, r: 0 }, { isMobile: true })
    const enemyShip = makeUnit('p2', 'ship', { q: -1, r: 0 }, { isMobile: true })
    const state = makeState({
      board,
      units: [unit, enemyNomad, enemyShip],
      players: [makePlayer('p1', { resources: { gold: 3, wood: 0, stone: 0 } }), makePlayer('p2')],
    })

    // 3 gold affords the Nomad (2) but not the Ship (5) — only the Nomad's hex is legal.
    expect(legalConvertTargets(state, 'p1', unit, effectWithVaryingCost, content)).toEqual([{ q: 1, r: 0 }])
  })
})

describe("legalConvertTargets, targetOwner: 'own' (City upgrading an adjacent Nomad)", () => {
  const effect: ConvertEffect = {
    actionType: 'convert',
    targetHex: { location: 'adj' },
    targetOwner: 'own',
    targetMobileOnly: false,
    requiredTargetKind: 'nomad',
    resultUnit: 'merchant',
    cost: { gold: 2 },
  }

  it('returns adjacent hexes with an own Nomad, affordable', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const nomad = makeUnit('p1', 'nomad', { q: 1, r: 0 })
    const state = makeState({ board, units: [unit, nomad], players: [makePlayer('p1', { resources: { gold: 2, wood: 0, stone: 0 } })] })

    expect(legalConvertTargets(state, 'p1', unit, effect, emptyContent)).toEqual([{ q: 1, r: 0 }])
  })

  it('excludes an adjacent own unit that is not the required kind', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const merchant = makeUnit('p1', 'merchant', { q: 1, r: 0 })
    const state = makeState({ board, units: [unit, merchant], players: [makePlayer('p1', { resources: { gold: 2, wood: 0, stone: 0 } })] })

    expect(legalConvertTargets(state, 'p1', unit, effect, emptyContent)).toEqual([])
  })

  it('excludes an adjacent enemy Nomad', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const enemyNomad = makeUnit('p2', 'nomad', { q: 1, r: 0 })
    const state = makeState({
      board,
      units: [unit, enemyNomad],
      players: [makePlayer('p1', { resources: { gold: 2, wood: 0, stone: 0 } }), makePlayer('p2')],
    })

    expect(legalConvertTargets(state, 'p1', unit, effect, emptyContent)).toEqual([])
  })

  it('returns nothing if the player cannot afford the cost', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const nomad = makeUnit('p1', 'nomad', { q: 1, r: 0 })
    const state = makeState({ board, units: [unit, nomad], players: [makePlayer('p1', { resources: { gold: 0, wood: 0, stone: 0 } })] })

    expect(legalConvertTargets(state, 'p1', unit, effect, emptyContent)).toEqual([])
  })

  it('returns nothing once the result kind is at its supply cap', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const nomad = makeUnit('p1', 'nomad', { q: 1, r: 0 })
    const state = makeState({ board, units: [unit, nomad], players: [makePlayer('p1', { resources: { gold: 2, wood: 0, stone: 0 } })] })
    const content: UnitContent = { ...emptyContent, unitSupplyCaps: { merchant: 0 } }

    expect(legalConvertTargets(state, 'p1', unit, effect, content)).toEqual([])
  })
})

describe('isActionAvailableForUnit', () => {
  it('income is unavailable on a terrain/adjacency that pays out nothing, available where it does (bug: a City could "Generate Income" on a terrain not in goldByTerrain and still consume its turn for 0 gold)', () => {
    const incomeAction: UnitAction = { id: 'a', name: 'Income', description: '', effect: { actionType: 'income', goldByTerrain: { forest: 3 } } }
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })

    const onPlain = makeState({ board: boardOf([[0, 0, 'plain']]), units: [unit], players: [makePlayer('p1')] })
    expect(isActionAvailableForUnit(onPlain, 'p1', unit, incomeAction, emptyContent)).toBe(false)

    const onForest = { ...onPlain, board: boardOf([[0, 0, 'forest']]) }
    expect(isActionAvailableForUnit(onForest, 'p1', unit, incomeAction, emptyContent)).toBe(true)
  })

  it('produce is unavailable on a terrain not in resourceByTerrain, available on one that is (bug: a Nomad could "Produce Resource" on Plain, which has no entry, and still consume its turn for nothing)', () => {
    const produceAction: UnitAction = { id: 'b', name: 'Produce', description: '', effect: { actionType: 'produce', resourceByTerrain: { forest: { wood: 1 } } } }
    const unit = makeUnit('p1', 'nomad', { q: 0, r: 0 })

    const onPlain = makeState({ board: boardOf([[0, 0, 'plain']]), units: [unit], players: [makePlayer('p1')] })
    expect(isActionAvailableForUnit(onPlain, 'p1', unit, produceAction, emptyContent)).toBe(false)

    const onForest = { ...onPlain, board: boardOf([[0, 0, 'forest']]) }
    expect(isActionAvailableForUnit(onForest, 'p1', unit, produceAction, emptyContent)).toBe(true)
  })

  it("produce is unavailable once the player is already at that resource's cap — the reported bug (Produce stayed clickable and wasted a turn once Wood/Stone hit its cap)", () => {
    const produceAction: UnitAction = { id: 'b', name: 'Produce', description: '', effect: { actionType: 'produce', resourceByTerrain: { forest: { wood: 1 } } } }
    const unit = makeUnit('p1', 'nomad', { q: 0, r: 0 })
    const contentWithCap: UnitContent = { ...emptyContent, resourceCaps: { wood: 5 } }
    const state = makeState({ board: boardOf([[0, 0, 'forest']]), units: [unit] })

    const atCap = { ...state, players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 0 } })] }
    expect(isActionAvailableForUnit(atCap, 'p1', unit, produceAction, contentWithCap)).toBe(false)

    const belowCap = { ...state, players: [makePlayer('p1', { resources: { gold: 0, wood: 4, stone: 0 } })] }
    expect(isActionAvailableForUnit(belowCap, 'p1', unit, produceAction, contentWithCap)).toBe(true)
  })

  it('produce is unavailable once the shared resource bank is empty, even below the player cap', () => {
    const produceAction: UnitAction = { id: 'b', name: 'Produce', description: '', effect: { actionType: 'produce', resourceByTerrain: { forest: { wood: 1 } } } }
    const unit = makeUnit('p1', 'nomad', { q: 0, r: 0 })
    const state = makeState({
      board: boardOf([[0, 0, 'forest']]),
      units: [unit],
      players: [makePlayer('p1', { resources: { gold: 0, wood: 0, stone: 0 } })],
      resourceBank: { gold: 1000, wood: 0, stone: 1000 },
    })
    expect(isActionAvailableForUnit(state, 'p1', unit, produceAction, emptyContent)).toBe(false)
  })

  it("trade is unavailable with no City in the Ship's sea area, available with one", () => {
    const tradeAction: UnitAction = { id: 'c', name: 'Trade', description: '', effect: { actionType: 'trade', goldPerCity: 1 } }
    const ship = makeUnit('p1', 'ship', { q: 0, r: 0 })

    const alone = makeState({ board: boardOf([[0, 0, 'water']]), units: [ship], players: [makePlayer('p1')] })
    expect(isActionAvailableForUnit(alone, 'p1', ship, tradeAction, emptyContent)).toBe(false)

    const city = makeUnit('p2', 'city', { q: 1, r: 0 })
    const withCity = { ...alone, board: boardOf([[0, 0, 'water'], [1, 0, 'plain']]), units: [ship, city] }
    expect(isActionAvailableForUnit(withCity, 'p1', ship, tradeAction, emptyContent)).toBe(true)
  })

  it('create/transform/convert mirror their legal-targets query — unavailable with no legal target', () => {
    const createAction: UnitAction = {
      id: 'a',
      name: 'Create Nomad',
      description: '',
      effect: { actionType: 'create', targetUnit: 'nomad', targetHex: { location: 'adj' }, cost: { gold: 1 } },
    }
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 })
    const state = makeState({ board: boardOf([[0, 0, 'plain'], [1, 0, 'plain']]), units: [unit], players: [makePlayer('p1', { resources: { gold: 0, wood: 0, stone: 0 } })] })

    // Can't afford the cost, so there's no legal target at all.
    expect(isActionAvailableForUnit(state, 'p1', unit, createAction, emptyContent)).toBe(false)

    const funded = { ...state, players: [makePlayer('p1', { resources: { gold: 5, wood: 0, stone: 0 } })] }
    expect(isActionAvailableForUnit(funded, 'p1', unit, createAction, emptyContent)).toBe(true)
  })

  it('trade-resource is unavailable when the player cannot afford to buy, or has nothing to sell', () => {
    const buyAction: UnitAction = {
      id: 'buy',
      name: 'Buy Wood',
      description: '',
      effect: { actionType: 'trade-resource', resource: 'wood', mode: 'buy', resourceAmount: 1, goldPerResource: 2 },
    }
    const sellAction: UnitAction = {
      id: 'sell',
      name: 'Sell Stone',
      description: '',
      effect: { actionType: 'trade-resource', resource: 'stone', mode: 'sell', resourceAmount: 1, goldPerResource: 2 },
    }
    const unit = makeUnit('p1', 'merchant', { q: 0, r: 0 })
    const poor = makeState({
      board: boardOf([[0, 0, 'plain']]),
      units: [unit],
      players: [makePlayer('p1', { resources: { gold: 0, wood: 0, stone: 0 } })],
    })
    expect(isActionAvailableForUnit(poor, 'p1', unit, buyAction, emptyContent)).toBe(false)
    expect(isActionAvailableForUnit(poor, 'p1', unit, sellAction, emptyContent)).toBe(false)

    const stocked = { ...poor, players: [makePlayer('p1', { resources: { gold: 2, wood: 0, stone: 1 } })] }
    expect(isActionAvailableForUnit(stocked, 'p1', unit, buyAction, emptyContent)).toBe(true)
    expect(isActionAvailableForUnit(stocked, 'p1', unit, sellAction, emptyContent)).toBe(true)
  })

  it("trade-resource's buy mode is unavailable once the player is already at the bought resource's cap, even though they can afford it", () => {
    const buyAction: UnitAction = {
      id: 'buy',
      name: 'Buy Wood',
      description: '',
      effect: { actionType: 'trade-resource', resource: 'wood', mode: 'buy', resourceAmount: 1, goldPerResource: 2 },
    }
    const unit = makeUnit('p1', 'merchant', { q: 0, r: 0 })
    const contentWithCap: UnitContent = { ...emptyContent, resourceCaps: { wood: 5 } }
    const atCap = makeState({
      board: boardOf([[0, 0, 'plain']]),
      units: [unit],
      players: [makePlayer('p1', { resources: { gold: 10, wood: 5, stone: 0 } })],
    })
    expect(isActionAvailableForUnit(atCap, 'p1', unit, buyAction, contentWithCap)).toBe(false)

    const belowCap = { ...atCap, players: [makePlayer('p1', { resources: { gold: 10, wood: 4, stone: 0 } })] }
    expect(isActionAvailableForUnit(belowCap, 'p1', unit, buyAction, contentWithCap)).toBe(true)
  })

  it('move is unavailable with no legal destination', () => {
    const moveAction: UnitAction = { id: 'm', name: 'Move', description: '', effect: { actionType: 'move' } }
    const unit = makeUnit('p1', 'nomad', { q: 0, r: 0 }, { isMobile: true, terrains: ['plain'] })
    const isolated = makeState({ board: boardOf([[0, 0, 'plain']]), units: [unit], players: [makePlayer('p1')] })
    expect(isActionAvailableForUnit(isolated, 'p1', unit, moveAction, emptyContent)).toBe(false)

    const withNeighbor = { ...isolated, board: boardOf([[0, 0, 'plain'], [1, 0, 'plain']]) }
    expect(isActionAvailableForUnit(withNeighbor, 'p1', unit, moveAction, emptyContent)).toBe(true)
  })
})
