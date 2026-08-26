import { describe, expect, it } from 'vitest'
import type { AchievementContent } from '../achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../achievementContent'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { cardIdFor, moveCard, UNIT_KINDS } from '../cards'
import { createNewGame } from '../createGame'
import type { Coordinate, GameState, Unit } from '../types'
import type { UnitAction, UnitContent } from '../unitContent'
import { calculateGoldProducedByKind, calculateGoldSpendingByCategory, calculateUnitValueDetail } from '../unitValue'

let unitCounter = 0
function unitAt(ownerId: string, kind: string, coord: Coordinate = { q: 0, r: 0 }): Unit {
  unitCounter += 1
  return {
    id: `test-unit-${unitCounter}`,
    ownerId,
    kind,
    coord,
    movement: { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }
}

describe('calculateUnitValueDetail', () => {
  function baseState(): GameState {
    let board = createEmptyBoard('hex')
    board = setTile(board, { q: 0, r: 0 }, 'water')
    board = setTile(board, { q: 1, r: 0 }, 'water')

    const state = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board,
      players: [
        { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      ],
    })

    const units = [unitAt('p1', 'city', { q: 0, r: 0 }), unitAt('p1', 'city', { q: 1, r: 0 })]

    return { ...state, status: 'active', units, claimedByAchievementId: { 'city-mastery': 'p1' } }
  }

  const content: AchievementContent = {
    ...EMPTY_ACHIEVEMENT_CONTENT,
    unitKindByAchievementId: { 'city-mastery': 'city' },
    achievementVictoryPoints: { 'city-mastery': 3 },
    unitBoardCountVP: { city: [1, 2] },
    terrainVictoryPoints: { water: 1 },
    goldPerVictoryPoint: 2,
  }

  it('combines achievement, presence, and territory-control VP for a kind, with no gold produced (empty action history)', () => {
    const state = baseState()
    const detail = calculateUnitValueDetail(state, state, [], undefined, content)

    // city-mastery claimed (3) + 2 Cities on board (curve [1,2] at count 2 -> 2) + a 2-hex water majority (1 VP/hex -> 2, split evenly across the 2 cities present) + 0 gold produced = 7.
    expect(detail.p1).toEqual([{ kind: 'city', breakdown: { achievement: 3, presence: 2, territoryControl: 2, goldProduced: 0 }, total: 7 }])
  })

  it('omits a player with no unit-kind contribution entirely, rather than an all-zero entry', () => {
    const state = baseState()
    const detail = calculateUnitValueDetail(state, state, [], undefined, content)

    expect(detail.p2).toEqual([])
  })

  it("drops presence (but not achievement/territory) for a kind whose card is in decline, mirroring calculateBoardCountDetail's rule", () => {
    const state = baseState()
    const players = state.players.map((player) => (player.id === 'p1' ? { ...player, declineCardIds: [cardIdFor('p1', 'city')] } : player))
    const declinedState = { ...state, players }

    const detail = calculateUnitValueDetail(declinedState, declinedState, [], undefined, content)

    expect(detail.p1).toEqual([{ kind: 'city', breakdown: { achievement: 3, presence: 0, territoryControl: 2, goldProduced: 0 }, total: 5 }])
  })

  it('lists every kind that contributed something, sorted by descending total', () => {
    const state = baseState()
    const withShip = { ...state, units: [...state.units, unitAt('p1', 'ship', { q: 5, r: 5 })] }
    const contentWithShip: AchievementContent = { ...content, unitBoardCountVP: { ...content.unitBoardCountVP, ship: [5] } }

    const detail = calculateUnitValueDetail(withShip, withShip, [], undefined, contentWithShip)

    // city: 3 (achievement) + 2 (presence) + 2 (territory) = 7; ship: 5 (presence) only -> city sorts first.
    expect(detail.p1.map((d) => d.kind)).toEqual(['city', 'ship'])
    expect(detail.p1.find((d) => d.kind === 'ship')?.breakdown.presence).toBe(5)
  })

  it('returns an empty breakdown for every player when no content is supplied', () => {
    const state = baseState()
    const detail = calculateUnitValueDetail(state, state, [], undefined, EMPTY_ACHIEVEMENT_CONTENT)

    expect(detail).toEqual({ p1: [], p2: [] })
  })
})

describe('calculateGoldProducedByKind', () => {
  const achievementContent: AchievementContent = { ...EMPTY_ACHIEVEMENT_CONTENT, goldPerVictoryPoint: 1 }

  function makeActiveGame(): GameState {
    const state = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board: createEmptyBoard('hex'),
      players: [
        { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      ],
    })

    const players = state.players.map((player) => {
      let next = player
      for (const cardId of player.supplyCardIds) next = moveCard(next, cardId, 'hand')
      return next
    })

    const units: Unit[] = state.players.flatMap((player, playerIndex) =>
      UNIT_KINDS.map((kind, kindIndex) => unitAt(player.id, kind, { q: 100 + kindIndex, r: 100 + playerIndex })),
    )

    return { ...state, status: 'active', players, units }
  }

  it("attributes a RESOLVE_UNIT_ACTION's positive gold delta to the acting card's kind", () => {
    const cityActions: UnitAction[] = [{ id: 'generate-income', name: 'Generate Income', description: '', effect: { actionType: 'income', goldByTerrain: { plain: 3 } } }]
    const unitContent: UnitContent = {
      actionsByKind: { city: cityActions },
      movementByKind: {},
      terrainLevels: {},
      resourceCaps: {},
      unitSupplyCaps: {},
      companionKindsByCardKind: {},
      activationsPerTurnByKind: {},
    }

    let board = createEmptyBoard('hex')
    board = setTile(board, { q: 0, r: 0 }, 'plain')
    const genesis = { ...makeActiveGame(), board, resourceBank: { gold: 100, wood: 100, stone: 100 } }
    const cityUnit = genesis.units.find((u) => u.ownerId === 'p1' && u.kind === 'city') as Unit
    const genesisWithCityOnPlain = { ...genesis, units: genesis.units.map((u) => (u.id === cityUnit.id ? { ...u, coord: { q: 0, r: 0 } } : u)) }

    let result = applyAction(genesisWithCityOnPlain, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'temple') }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: cityUnit.id, actionId: 'generate-income' }] }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)

    const gold = calculateGoldProducedByKind(genesisWithCityOnPlain, result.state.actionHistory, unitContent, achievementContent)

    expect(gold).toEqual({ p1: { city: 3 } })
  })

  it('does not attribute a negative gold delta (spending, e.g. buying a resource) to any kind', () => {
    const merchantActions: UnitAction[] = [{ id: 'buy-wood', name: 'Buy Wood', description: '', effect: { actionType: 'trade-resource', resource: 'wood', mode: 'buy', resourceAmount: 1, goldPerResource: 3 } }]
    const unitContent: UnitContent = {
      actionsByKind: { merchant: merchantActions },
      movementByKind: {},
      terrainLevels: {},
      resourceCaps: {},
      unitSupplyCaps: {},
      companionKindsByCardKind: {},
      activationsPerTurnByKind: {},
    }

    const genesis = { ...makeActiveGame(), resourceBank: { gold: 100, wood: 100, stone: 100 } }
    const players = genesis.players.map((player) => (player.id === 'p1' ? { ...player, resources: { ...player.resources, gold: 10 } } : player))
    const genesisWithGold = { ...genesis, players }
    const merchantUnit = genesisWithGold.units.find((u) => u.ownerId === 'p1' && u.kind === 'merchant') as Unit

    let result = applyAction(genesisWithGold, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'merchant') }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'temple') }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: merchantUnit.id, actionId: 'buy-wood' }] }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    expect(result.state.players.find((p) => p.id === 'p1')?.resources.gold).toBe(7)

    const gold = calculateGoldProducedByKind(genesisWithGold, result.state.actionHistory, unitContent, achievementContent)

    expect(gold).toEqual({})
  })

  it('accumulates gold produced by the same kind across every unit resolved within one batched RESOLVE_UNIT_ACTION', () => {
    const cityActions: UnitAction[] = [{ id: 'generate-income', name: 'Generate Income', description: '', effect: { actionType: 'income', goldByTerrain: { plain: 3 } } }]
    const unitContent: UnitContent = {
      actionsByKind: { city: cityActions },
      movementByKind: {},
      terrainLevels: {},
      resourceCaps: {},
      unitSupplyCaps: {},
      companionKindsByCardKind: {},
      activationsPerTurnByKind: {},
    }

    let board = createEmptyBoard('hex')
    board = setTile(board, { q: 0, r: 0 }, 'plain')
    board = setTile(board, { q: 1, r: 0 }, 'plain')
    const genesis = { ...makeActiveGame(), board, resourceBank: { gold: 100, wood: 100, stone: 100 } }
    const cityUnit = genesis.units.find((u) => u.ownerId === 'p1' && u.kind === 'city') as Unit
    const secondCity = unitAt('p1', 'city', { q: 1, r: 0 })
    const genesisWithTwoCities = { ...genesis, units: [...genesis.units.map((u) => (u.id === cityUnit.id ? { ...u, coord: { q: 0, r: 0 } } : u)), secondCity] }

    let result = applyAction(genesisWithTwoCities, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'temple') }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(
      result.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: cityUnit.id, actionId: 'generate-income' }, { unitId: secondCity.id, actionId: 'generate-income' }] },
      unitContent,
      achievementContent,
    )
    if (!result.ok) throw new Error(result.error)

    const gold = calculateGoldProducedByKind(genesisWithTwoCities, result.state.actionHistory, unitContent, achievementContent)

    expect(gold).toEqual({ p1: { city: 6 } })
  })
})

describe('calculateGoldSpendingByCategory', () => {
  const achievementContent: AchievementContent = { ...EMPTY_ACHIEVEMENT_CONTENT, purchaseCostTable: [5, 10, 20], goldPerVictoryPoint: 1 }

  function makeActiveGame(): GameState {
    const state = createNewGame({
      gameId: 'game_1',
      playMode: 'hotseat',
      board: createEmptyBoard('hex'),
      players: [
        { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
      ],
    })

    const players = state.players.map((player) => {
      let next = player
      for (const cardId of player.supplyCardIds) next = moveCard(next, cardId, 'hand')
      return next
    })

    const units: Unit[] = state.players.flatMap((player, playerIndex) =>
      UNIT_KINDS.map((kind, kindIndex) => unitAt(player.id, kind, { q: 100 + kindIndex, r: 100 + playerIndex })),
    )

    return { ...state, status: 'active', players, units }
  }

  it("attributes a PURCHASE_CARD's cost (priced at the moment of purchase) to declineBuyback", () => {
    const base = makeActiveGame()
    const p1Index = base.players.findIndex((p) => p.id === 'p1')
    let p1 = { ...base.players[p1Index], resources: { ...base.players[p1Index].resources, gold: 100 } }
    p1 = moveCard(p1, cardIdFor('p1', 'temple'), 'decline')
    const players = [...base.players]
    players[p1Index] = p1
    const genesis = { ...base, players, claimedByAchievementId: { 'city-mastery': 'p2' } }

    let result = applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    expect(result.state.roundPhase).toBe('purchase')

    result = applyAction(result.state, { type: 'PURCHASE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'temple') }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)

    // 1 achievement already claimed -> costTable[0] = 5 gold -> 5 VP at goldPerVictoryPoint 1.
    const spending = calculateGoldSpendingByCategory(genesis, result.state.actionHistory, undefined, achievementContent)
    expect(spending.p1).toEqual({ unitCreation: 0, transform: 0, convert: 0, tradeResource: 0, declineBuybacks: [{ kind: 'temple', cost: 5 }] })
    expect(spending.p2).toBeUndefined()
  })

  it('records one entry per purchase, not summed by kind — across two rounds since the purchase queue only lets a player buy back one card per round', () => {
    const base = makeActiveGame()
    const p1Index = base.players.findIndex((p) => p.id === 'p1')
    let p1 = { ...base.players[p1Index], resources: { ...base.players[p1Index].resources, gold: 100 } }
    p1 = moveCard(p1, cardIdFor('p1', 'temple'), 'decline')
    p1 = moveCard(p1, cardIdFor('p1', 'nomad'), 'decline')
    const players = [...base.players]
    players[p1Index] = p1
    const genesis = { ...base, players, claimedByAchievementId: { 'city-mastery': 'p2' } }

    // Round 1: both play City, both pass actions, p1 buys temple back — the
    // only pending purchaser, so this empties the queue and chains straight
    // into round 2's selectCards (see round.test.ts's matching case above).
    let result = applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    expect(result.state.roundPhase).toBe('purchase')

    result = applyAction(result.state, { type: 'PURCHASE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'temple') }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    expect(result.state.roundPhase).toBe('selectCards')
    expect(result.state.turn).toBe(1)

    // Round 2: both play Merchant, both pass actions, p1 buys the
    // still-declined nomad back.
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'merchant') }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'merchant') }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)
    expect(result.state.roundPhase).toBe('purchase')

    result = applyAction(result.state, { type: 'PURCHASE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') }, undefined, achievementContent)
    if (!result.ok) throw new Error(result.error)

    const spending = calculateGoldSpendingByCategory(genesis, result.state.actionHistory, undefined, achievementContent)
    expect(spending.p1?.declineBuybacks).toEqual([
      { kind: 'temple', cost: 5 },
      { kind: 'nomad', cost: 5 },
    ])
  })

  it("attributes a site-create effect's cost to unitCreation", () => {
    const portActions: UnitAction[] = [
      { id: 'build-ship', name: 'Build Ship', description: '', effect: { actionType: 'site-create', targetUnit: 'ship', blockedByKinds: [], cost: { gold: 4 } } },
    ]
    const unitContent: UnitContent = {
      actionsByKind: { city: portActions },
      movementByKind: {},
      terrainLevels: {},
      resourceCaps: {},
      unitSupplyCaps: {},
      companionKindsByCardKind: {},
      activationsPerTurnByKind: {},
    }

    let board = createEmptyBoard('hex')
    board = setTile(board, { q: 0, r: 0 }, 'plain')
    const genesis = { ...makeActiveGame(), board, resourceBank: { gold: 100, wood: 100, stone: 100 } }
    const players = genesis.players.map((player) => (player.id === 'p1' ? { ...player, resources: { ...player.resources, gold: 10 } } : player))
    const genesisWithGold = { ...genesis, players }
    const cityUnit = genesisWithGold.units.find((u) => u.ownerId === 'p1' && u.kind === 'city') as Unit
    const genesisWithCityOnPlain = { ...genesisWithGold, units: genesisWithGold.units.map((u) => (u.id === cityUnit.id ? { ...u, coord: { q: 0, r: 0 } } : u)) }

    let result = applyAction(genesisWithCityOnPlain, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'temple') }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: cityUnit.id, actionId: 'build-ship' }] }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    expect(result.state.players.find((p) => p.id === 'p1')?.resources.gold).toBe(6)

    const spending = calculateGoldSpendingByCategory(genesisWithCityOnPlain, result.state.actionHistory, unitContent, achievementContent)
    expect(spending.p1).toEqual({ unitCreation: 4, transform: 0, convert: 0, tradeResource: 0, declineBuybacks: [] })
  })

  it("attributes a trade-resource buy effect's cost to tradeResource, but not a sell (which gains gold)", () => {
    const merchantActions: UnitAction[] = [
      { id: 'buy-wood', name: 'Buy Wood', description: '', effect: { actionType: 'trade-resource', resource: 'wood', mode: 'buy', resourceAmount: 1, goldPerResource: 3 } },
      { id: 'sell-stone', name: 'Sell Stone', description: '', effect: { actionType: 'trade-resource', resource: 'stone', mode: 'sell', resourceAmount: 1, goldPerResource: 2 } },
    ]
    const unitContent: UnitContent = {
      actionsByKind: { merchant: merchantActions },
      movementByKind: {},
      terrainLevels: {},
      resourceCaps: {},
      unitSupplyCaps: {},
      companionKindsByCardKind: {},
      activationsPerTurnByKind: { merchant: 2 },
    }

    const genesis = { ...makeActiveGame(), resourceBank: { gold: 100, wood: 100, stone: 100 } }
    const players = genesis.players.map((player) => (player.id === 'p1' ? { ...player, resources: { ...player.resources, gold: 10, stone: 1 } } : player))
    const genesisWithResources = { ...genesis, players }
    const merchantUnit = genesisWithResources.units.find((u) => u.ownerId === 'p1' && u.kind === 'merchant') as Unit

    let result = applyAction(genesisWithResources, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'merchant') }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'temple') }, unitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(
      result.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: merchantUnit.id, actionId: 'buy-wood' }, { unitId: merchantUnit.id, actionId: 'sell-stone' }] },
      unitContent,
      achievementContent,
    )
    if (!result.ok) throw new Error(result.error)

    const spending = calculateGoldSpendingByCategory(genesisWithResources, result.state.actionHistory, unitContent, achievementContent)
    expect(spending.p1).toEqual({ unitCreation: 0, transform: 0, convert: 0, tradeResource: 3, declineBuybacks: [] })
  })

  it('omits a player who never spent any gold, rather than an all-zero entry', () => {
    const genesis = makeActiveGame()
    const spending = calculateGoldSpendingByCategory(genesis, [], undefined, achievementContent)
    expect(spending).toEqual({})
  })
})
