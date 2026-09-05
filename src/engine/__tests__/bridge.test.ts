import { describe, expect, it } from 'vitest'
import { resolveAchievementContent, resolveTaleContent, resolveUnitContent } from '../../content/resolveContent'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { cardIdFor, createPlayerCards } from '../cards'
import { isDeclineTriggered } from '../decline'
import { eliminatePlayer } from '../elimination'
import { legalMoveDestinations } from '../movement'
import { beginSelectCardsPhase } from '../round'
import { applyTaleAchievementModifiers, applyTaleModifiers } from '../tales'
import type { Coordinate, GameState, Player, Terrain, Unit, UnitMovement } from '../types'
import { coordKey } from '../types'
import type { TransformEffect, UnitContent } from '../unitContent'
import { EMPTY_UNIT_CONTENT } from '../unitContent'
import { applyUnitActionEffect, findMirroredPartnerUnit } from '../unitActions'

// --- shared fixtures, same conventions as capital.test.ts/tales.test.ts ---

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
    resources: { gold: 0, wood: 5, stone: 5 },
    ...overrides,
  }
}

let unitCounter = 0
function makeUnit(ownerId: string, kind: string, coord: Coordinate, movement: UnitMovement): Unit {
  unitCounter += 1
  return { id: `unit_${unitCounter}`, ownerId, kind, coord, movement, traits: [] }
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
    activeTaleIds: [],
    gameLength: Infinity,
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
    ...overrides,
  }
}

const TERRAIN_LEVELS: Record<string, number> = { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 }
const nomadMovement: UnitMovement = { isMobile: true, terrains: ['plain', 'forest', 'mountain'], canCrossCliffs: false, moveDistance: 1, blockedByUnits: 'all' }
const bridgeMovement: UnitMovement = { isMobile: false, terrains: [], canCrossCliffs: false }

// --- Group 1: findMirroredPartnerUnit geometry ---

describe('findMirroredPartnerUnit', () => {
  it("finds the partner Nomad straight across the Sea hex, on a hex sharing the acting Nomad's own terrain", () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA, nomadB] })

    const partner = findMirroredPartnerUnit(state, 'p1', nomadA.coord, { q: 1, r: 0 }, 'nomad')

    expect(partner?.id).toBe(nomadB.id)
  })

  it('returns null when the far hex has no matching own unit', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA] })

    expect(findMirroredPartnerUnit(state, 'p1', nomadA.coord, { q: 1, r: 0 }, 'nomad')).toBeNull()
  })

  it("returns null when the far unit's terrain doesn't match the acting unit's own terrain", () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'forest']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA, nomadB] })

    expect(findMirroredPartnerUnit(state, 'p1', nomadA.coord, { q: 1, r: 0 }, 'nomad')).toBeNull()
  })

  it('returns null when the far unit belongs to another player', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const enemyNomad = makeUnit('p2', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA, enemyNomad] })

    expect(findMirroredPartnerUnit(state, 'p1', nomadA.coord, { q: 1, r: 0 }, 'nomad')).toBeNull()
  })

  it('returns null when the far unit already resolved an action this turn', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA, nomadB], resolvedUnitIdsThisTurn: [nomadB.id] })

    expect(findMirroredPartnerUnit(state, 'p1', nomadA.coord, { q: 1, r: 0 }, 'nomad')).toBeNull()
  })

  it('returns null when the acting hex and target hex are not adjacent', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA, nomadB] })

    expect(findMirroredPartnerUnit(state, 'p1', nomadA.coord, { q: 5, r: 5 }, 'nomad')).toBeNull()
  })
})

// --- Group 2: resolveTaleContent + applyTaleModifiers against real content/tales.json ---

describe('resolveTaleContent + applyTaleModifiers — The Majestic Bridge, against real content/tales.json + units.json', () => {
  it('merges Bridge as a Nomad companion, with no actions of its own', () => {
    const base = resolveUnitContent(2)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-majestic-bridge'], 2))

    expect(merged.companionKindsByCardKind.nomad).toEqual(['bridge'])
    expect(merged.unitSupplyCaps.bridge).toBe(1)
    expect(merged.actionsByKind.bridge).toEqual([])
    expect(merged.movementByKind.bridge).toEqual(bridgeMovement)
  })

  it("appends construct-the-bridge onto Nomad's own action list, without dropping Nomad's base actions", () => {
    const base = resolveUnitContent(2)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-majestic-bridge'], 2))

    const nomadActionIds = merged.actionsByKind.nomad.map((a) => a.id)
    expect(nomadActionIds).toContain('construct-the-bridge')
    expect(nomadActionIds).toContain('transform-to-ship') // base action still present
  })

  it('grants Nomad, Merchant, and Mountaineer canCrossOntoStructureKinds: [bridge], leaving their other movement fields alone', () => {
    const base = resolveUnitContent(2)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-majestic-bridge'], 2))

    for (const kind of ['nomad', 'merchant', 'mountaineer'] as const) {
      expect(merged.movementByKind[kind].canCrossOntoStructureKinds).toEqual(['bridge'])
      expect(merged.movementByKind[kind].terrains).toEqual(base.movementByKind[kind].terrains)
    }
    // Ship needs no override — see the movement group below.
    expect(merged.movementByKind.ship.canCrossOntoStructureKinds).toBeUndefined()
  })

  it('applyTaleAchievementModifiers merges a real 20 VP Bridge Trophy tied to full Bridge supply (1)', () => {
    const base = resolveAchievementContent()
    const taleContent = resolveTaleContent(['the-majestic-bridge'], 2)
    const merged = applyTaleAchievementModifiers(base, taleContent)

    expect(merged.unitKindByAchievementId.bridge).toBe('bridge')
    expect(merged.achievementVictoryPoints.bridge).toBe(20)
  })
})

// --- Group 3: the mirrored-partner transform effect in isolation ---

describe("transform effect's requiredMirroredPartnerOfKind + costByOwnTerrain (Nomad: Constructing the Bridge)", () => {
  const content: UnitContent = {
    ...EMPTY_UNIT_CONTENT,
    movementByKind: { bridge: bridgeMovement },
    terrainLevels: TERRAIN_LEVELS,
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: { bridge: 1 },
  }
  const effect: TransformEffect = {
    actionType: 'transform',
    targetUnit: 'bridge',
    targetHex: { terrainType: ['water'], location: 'adj' },
    destroySelf: true,
    cost: {},
    costByOwnTerrain: {
      plain: { stone: 4 },
      forest: { wood: 4 },
      mountain: { wood: 5 },
    },
    requiredMirroredPartnerOfKind: 'nomad',
    ignoresCliff: true,
    forbiddenIfBoardHasKind: 'bridge',
  }
  const action = { id: 'construct-the-bridge', name: 'Constructing the Bridge', description: '', effect }

  it('between two Plains: costs 4 Stone, removes both Nomads, places the Bridge on the Sea hex between them', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA, nomadB], players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomadA.id]: { q: 1, r: 0 } }, content, [nomadA.id])

    expect(next.units.find((u) => u.id === nomadA.id)).toBeUndefined()
    expect(next.units.find((u) => u.id === nomadB.id)).toBeUndefined()
    const bridge = next.units.find((u) => u.kind === 'bridge')
    expect(bridge).toBeDefined()
    expect(coordKey(bridge!.coord)).toBe(coordKey({ q: 1, r: 0 }))
    expect(bridge!.connectedNeighborCoords?.map(coordKey).sort()).toEqual([coordKey({ q: 0, r: 0 }), coordKey({ q: 2, r: 0 })].sort())
    expect(next.players.find((p) => p.id === 'p1')?.resources).toEqual({ gold: 0, wood: 5, stone: 1 })
  })

  it('between two Forests: costs 4 Wood', () => {
    const board = boardOf([[0, 0, 'forest'], [1, 0, 'water'], [2, 0, 'forest']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA, nomadB], players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomadA.id]: { q: 1, r: 0 } }, content, [nomadA.id])

    expect(next.units.some((u) => u.kind === 'bridge')).toBe(true)
    expect(next.players.find((p) => p.id === 'p1')?.resources).toEqual({ gold: 0, wood: 1, stone: 5 })
  })

  it('between two Mountains: costs 5 Wood', () => {
    const board = boardOf([[0, 0, 'mountain'], [1, 0, 'water'], [2, 0, 'mountain']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA, nomadB], players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomadA.id]: { q: 1, r: 0 } }, content, [nomadA.id])

    expect(next.players.find((p) => p.id === 'p1')?.resources).toEqual({ gold: 0, wood: 0, stone: 5 })
  })

  it('is rejected without a matching partner Nomad across the Sea hex', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA], players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomadA.id]: { q: 1, r: 0 } }, content, [nomadA.id])

    expect(next).toBe(state)
  })

  it('ignores the cliff rule between a Forest/Mountain Nomad and the adjacent Sea hex', () => {
    // Forest(2) - Water(0): elevation diff 2, a cliff under the ordinary rule.
    const board = boardOf([[0, 0, 'forest'], [1, 0, 'water'], [2, 0, 'forest']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [nomadA, nomadB], players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomadA.id]: { q: 1, r: 0 } }, content, [nomadA.id])

    expect(next.units.some((u) => u.kind === 'bridge')).toBe(true)
  })

  it('is rejected once a Bridge already exists anywhere on the board', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain'], [9, 9, 'water']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const existingBridge = makeUnit('p2', 'bridge', { q: 9, r: 9 }, bridgeMovement)
    const state = makeState({
      board,
      units: [nomadA, nomadB, existingBridge],
      players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } }), makePlayer('p2')],
    })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomadA.id]: { q: 1, r: 0 } }, content, [nomadA.id])

    expect(next).toBe(state)
  })

  it('is rejected when the target Sea hex is not empty', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, nomadMovement)
    const blockingShip = makeUnit('p2', 'ship', { q: 1, r: 0 }, { isMobile: true, terrains: ['water'], canCrossCliffs: false })
    const state = makeState({
      board,
      units: [nomadA, nomadB, blockingShip],
      players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } }), makePlayer('p2')],
    })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, { [nomadA.id]: { q: 1, r: 0 } }, content, [nomadA.id])

    expect(next).toBe(state)
  })
})

// --- Group 4: movement — land units crossing the Bridge; Ships passing under but never docking ---

describe('canCrossOntoStructureKinds (land units moving over/onto the Bridge)', () => {
  const crossingNomadMovement: UnitMovement = { ...nomadMovement, canCrossOntoStructureKinds: ['bridge'] }

  it('may move onto the Bridge hex despite it being Water, a terrain outside its normal movement.terrains', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const bridge = makeUnit('neutral', 'bridge', { q: 1, r: 0 }, bridgeMovement)
    const nomad = makeUnit('p1', 'nomad', { q: 0, r: 0 }, crossingNomadMovement)
    const state = makeState({ board, units: [bridge, nomad] })

    const destinations = legalMoveDestinations(state, nomad, crossingNomadMovement, TERRAIN_LEVELS)

    expect(destinations.map(coordKey)).toContain(coordKey(bridge.coord))
  })

  it('may continue moving past the Bridge onto the far Plains, ignoring blockedByUnits: all', () => {
    const farMovement: UnitMovement = { ...crossingNomadMovement, moveDistance: 2 }
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const bridge = makeUnit('neutral', 'bridge', { q: 1, r: 0 }, bridgeMovement)
    const nomad = makeUnit('p1', 'nomad', { q: 0, r: 0 }, farMovement)
    const state = makeState({ board, units: [bridge, nomad] })

    const destinations = legalMoveDestinations(state, nomad, farMovement, TERRAIN_LEVELS)

    expect(destinations.map(coordKey)).toContain(coordKey({ q: 2, r: 0 }))
  })

  it('cannot reach the Bridge hex without canCrossOntoStructureKinds set (the ordinary terrain rule still applies)', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])
    const bridge = makeUnit('neutral', 'bridge', { q: 1, r: 0 }, bridgeMovement)
    const nomad = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const state = makeState({ board, units: [bridge, nomad] })

    const destinations = legalMoveDestinations(state, nomad, nomadMovement, TERRAIN_LEVELS)

    expect(destinations.map(coordKey)).not.toContain(coordKey(bridge.coord))
  })
})

describe("Ship movement — passes under the Bridge but can never dock there (no engine change needed for Ships)", () => {
  const shipMovement: UnitMovement = { isMobile: true, terrains: ['water'], canCrossCliffs: false, moveDistance: 'unlimited', blockedByUnits: 'none' }

  it('may sail through the Bridge hex to reach water beyond it', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water'], [2, 0, 'water']])
    const bridge = makeUnit('neutral', 'bridge', { q: 1, r: 0 }, bridgeMovement)
    const ship = makeUnit('p1', 'ship', { q: 0, r: 0 }, shipMovement)
    const state = makeState({ board, units: [bridge, ship] })

    const destinations = legalMoveDestinations(state, ship, shipMovement, TERRAIN_LEVELS)

    expect(destinations.map(coordKey)).toContain(coordKey({ q: 2, r: 0 }))
  })

  it('may never end its move on the Bridge hex itself', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water'], [2, 0, 'water']])
    const bridge = makeUnit('neutral', 'bridge', { q: 1, r: 0 }, bridgeMovement)
    const ship = makeUnit('p1', 'ship', { q: 0, r: 0 }, shipMovement)
    const state = makeState({ board, units: [bridge, ship] })

    const destinations = legalMoveDestinations(state, ship, shipMovement, TERRAIN_LEVELS)

    expect(destinations.map(coordKey)).not.toContain(coordKey(bridge.coord))
  })
})

// --- Group 5: end-to-end through applyAction — Trophy claim, Decline trigger, indestructibility ---

describe('The Majestic Bridge, end-to-end through applyAction', () => {
  function realContent() {
    const unitContent = applyTaleModifiers(resolveUnitContent(2), resolveTaleContent(['the-majestic-bridge'], 2))
    const achievementContent = applyTaleAchievementModifiers(resolveAchievementContent(1), resolveTaleContent(['the-majestic-bridge'], 2))
    return { unitContent, achievementContent }
  }

  function makeGameWithTwoNomads(): GameState {
    const { unitContent } = realContent()
    const p1Cards = createPlayerCards('p1')
    const p2Cards = createPlayerCards('p2')
    const cards = [...p1Cards, ...p2Cards].reduce((acc, c) => ({ ...acc, [c.id]: c }), {} as GameState['cards'])
    const nomadA = makeUnit('p1', 'nomad', { q: 0, r: 0 }, unitContent.movementByKind.nomad)
    const nomadB = makeUnit('p1', 'nomad', { q: 2, r: 0 }, unitContent.movementByKind.nomad)
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'water'], [2, 0, 'plain']])

    let state = makeState({
      board,
      units: [nomadA, nomadB],
      cards,
      players: [
        makePlayer('p1', { handCardIds: [cardIdFor('p1', 'nomad')], resources: { gold: 0, wood: 5, stone: 5 } }),
        makePlayer('p2', { handCardIds: [cardIdFor('p2', 'ship')] }),
      ],
      turnOrder: ['p1', 'p2'],
      roundPhase: 'selectCards',
    })
    state = beginSelectCardsPhase(state)
    return state
  }

  function chooseCards(state: GameState): GameState {
    const { unitContent } = realContent()
    // Both hands are a single card ('nomad'/'ship') — p1's own CHOOSE_CARD
    // already folds p2's forced pick into the same applyAction() call
    // (RULE_ENFORCEMENT_PLAN.md §4.2/§4.3), so no separate submission for
    // p2 is needed (or possible — p2 is no longer pending afterward).
    const p1Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') }, unitContent)
    if (!p1Choice.ok) throw new Error('p1 setup failed')
    return p1Choice.state
  }

  it('constructing the Bridge claims its Trophy and triggers a real Decline phase', () => {
    const { unitContent, achievementContent } = realContent()
    const chosen = chooseCards(makeGameWithTwoNomads())
    const nomadA = chosen.units.find((u) => u.kind === 'nomad' && coordKey(u.coord) === coordKey({ q: 0, r: 0 }))!

    const result = applyAction(
      chosen,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: nomadA.id, actionId: 'construct-the-bridge', target: { q: 1, r: 0 } }] },
      unitContent,
      achievementContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.units.filter((u) => u.kind === 'nomad')).toHaveLength(0)
    expect(result.state.units.some((u) => u.kind === 'bridge')).toBe(true)
    expect(result.state.claimedByAchievementId.bridge).toBe('p1')
    expect(isDeclineTriggered(result.state)).toBe(true)
  })

  it("survives its own builder's elimination — the Bridge is indestructible, unlike every other unit that player owns", () => {
    const bridge = makeUnit('p1', 'bridge', { q: 1, r: 0 }, bridgeMovement)
    const otherUnit = makeUnit('p1', 'nomad', { q: 0, r: 0 }, nomadMovement)
    const state = makeState({
      board: boardOf([[0, 0, 'plain'], [1, 0, 'water']]),
      units: [bridge, otherUnit],
      players: [makePlayer('p1', { handCardIds: [] }), makePlayer('p2')],
      pendingPlayerIds: ['p1'],
      turnOrder: ['p1', 'p2'],
    })

    const next = eliminatePlayer(state, 'p1')

    expect(next.players.find((p) => p.id === 'p1')?.eliminated).toBe(true)
    expect(next.units.some((u) => u.kind === 'nomad')).toBe(false) // ordinary units are removed
    expect(next.units.some((u) => u.kind === 'bridge')).toBe(true) // the Bridge survives regardless of ownership
  })
})
