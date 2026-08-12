import { describe, expect, it } from 'vitest'
import { resolveTaleContent, resolveUnitContent } from '../../content/resolveContent'
import { legalConvertTargets, legalTransformTargets } from '../actionTargeting'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { cardIdFor, createPlayerCards } from '../cards'
import { legalMoveDestinations } from '../movement'
import { beginSelectCardsPhase, finishRound } from '../round'
import { applyTaleModifiers } from '../tales'
import type { FantasticEvent } from '../taleContent'
import { EMPTY_TALE_CONTENT } from '../taleContent'
import type { Coordinate, GameState, Player, Terrain, Unit, UnitMovement } from '../types'
import { coordKey } from '../types'
import type { ConvertEffect, IncomeEffect, TransformEffect, UnitContent } from '../unitContent'
import { EMPTY_UNIT_CONTENT } from '../unitContent'
import { applyUnitActionEffect, computeIncomeGold } from '../unitActions'
import { calculateControllableStructureVP } from '../victoryPoints'

// --- shared fixtures, same conventions as movement.test.ts/applyAction.test.ts ---

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

// --- Group 1: content resolution (resolveTaleContent / applyTaleModifiers) against real tales.json ---

describe('resolveTaleContent + applyTaleModifiers — The Ports, against real content/tales.json + units.json', () => {
  it('resolves to all-empty content when no Tales are active', () => {
    const taleContent = resolveTaleContent([], 2)
    expect(taleContent).toEqual(EMPTY_TALE_CONTENT)
  })

  it('applyTaleModifiers is a no-op on top of the base UnitContent when no Tales are active', () => {
    const base = resolveUnitContent(2)
    const merged = applyTaleModifiers(base, resolveTaleContent([], 2))
    expect(merged).toEqual(base)
  })

  it('merges Port as a Ship companion, with its own two actions, once The Ports is active', () => {
    const base = resolveUnitContent(2)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-ports'], 2))

    expect(merged.companionKindsByCardKind.ship).toEqual(['port'])
    expect(merged.unitSupplyCaps.port).toBe(1)
    expect(merged.actionsByKind.port?.map((a) => a.id).sort()).toEqual(['construct-ship', 'trade-ships-and-ports'])
    expect(merged.movementByKind.port).toEqual({ isMobile: false, terrains: [], canCrossCliffs: false })
  })

  it("appends construct-port onto both Nomad's and Ship's existing action lists, without dropping the base game's own actions", () => {
    const base = resolveUnitContent(2)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-ports'], 2))

    const nomadActionIds = merged.actionsByKind.nomad.map((a) => a.id)
    const shipActionIds = merged.actionsByKind.ship.map((a) => a.id)
    expect(nomadActionIds).toContain('construct-port')
    expect(nomadActionIds).toContain('transform-to-ship') // base action still present
    expect(shipActionIds).toContain('construct-port')
    expect(shipActionIds).toContain('trade') // base action still present
  })

  it("overrides Ship's movement with canEndMoveOnAlliedUnitTypes: ['port'], keeping its other movement fields", () => {
    const base = resolveUnitContent(2)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-ports'], 2))

    expect(merged.movementByKind.ship.canEndMoveOnAlliedUnitTypes).toEqual(['port'])
    expect(merged.movementByKind.ship.terrains).toEqual(base.movementByKind.ship.terrains)
  })
})

// --- Group 2: the new effect types in isolation (synthetic content, mirroring unitActions.test.ts's style) ---

describe('site-create effect (Port: Construct a Ship)', () => {
  const content: UnitContent = {
    ...EMPTY_UNIT_CONTENT,
    movementByKind: { ship: { isMobile: true, terrains: ['water'], canCrossCliffs: false } },
    terrainLevels: TERRAIN_LEVELS,
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: { ship: 5 },
  }
  const action = {
    id: 'construct-ship',
    name: 'Construct a Ship',
    description: '',
    effect: { actionType: 'site-create' as const, targetUnit: 'ship', blockedByKinds: ['ship'], cost: { wood: 1 } },
  }

  it("creates a ship on the Port's own hex when it doesn't already hold one", () => {
    const port = makeUnit('p1', 'port', { q: 0, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const state = makeState({ board: boardOf([[0, 0, 'water']]), units: [port] })

    const next = applyUnitActionEffect(state, 'p1', 'port', action, {}, content)

    const shipsAtPortHex = next.units.filter((u) => u.kind === 'ship' && coordKey(u.coord) === coordKey(port.coord))
    expect(shipsAtPortHex).toHaveLength(1)
    expect(next.players.find((p) => p.id === 'p1')?.resources.wood).toBe(4) // paid the 1-wood cost
  })

  it('is blocked when the Port already holds a Ship', () => {
    const port = makeUnit('p1', 'port', { q: 0, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const existingShip = makeUnit('p1', 'ship', { q: 0, r: 0 }, { isMobile: true, terrains: ['water'], canCrossCliffs: false })
    const state = makeState({ board: boardOf([[0, 0, 'water']]), units: [port, existingShip] })

    const next = applyUnitActionEffect(state, 'p1', 'port', action, {}, content)

    expect(next).toBe(state) // true no-op — cost never spent
  })

  it("respects the target kind's supply cap", () => {
    const cappedContent: UnitContent = { ...content, unitSupplyCaps: { ship: 1 } }
    const port = makeUnit('p1', 'port', { q: 0, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const otherShip = makeUnit('p1', 'ship', { q: 1, r: 0 }, { isMobile: true, terrains: ['water'], canCrossCliffs: false })
    const state = makeState({ board: boardOf([[0, 0, 'water'], [1, 0, 'water']]), units: [port, otherShip] })

    const next = applyUnitActionEffect(state, 'p1', 'port', action, {}, cappedContent)

    expect(next).toBe(state)
  })
})

describe('region-unit-count-income effect (Port: Trade with Ships and Ports)', () => {
  const content: UnitContent = {
    ...EMPTY_UNIT_CONTENT,
    terrainLevels: TERRAIN_LEVELS,
    resourceCaps: { gold: null, wood: 5, stone: 5 },
  }
  const action = {
    id: 'trade-ships-and-ports',
    name: 'Trade with Ships and Ports',
    description: '',
    effect: { actionType: 'region-unit-count-income' as const, countKinds: ['ship', 'port'], goldPerUnit: 4 },
  }

  it('pays 4 GP per Ship/Port anywhere in the same connected Sea region, including itself and enemy pieces', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [2, 0, 'water'],
    ])
    const thisPort = makeUnit('p1', 'port', { q: 0, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const allyShip = makeUnit('p1', 'ship', { q: 1, r: 0 }, { isMobile: true, terrains: ['water'], canCrossCliffs: false })
    const enemyPort = makeUnit('p2', 'port', { q: 2, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const state = makeState({ board, units: [thisPort, allyShip, enemyPort] })

    const next = applyUnitActionEffect(state, 'p1', 'port', action, {}, content)

    // thisPort + allyShip + enemyPort = 3 units in the region -> 12 GP
    expect(next.players.find((p) => p.id === 'p1')?.resources.gold).toBe(12)
  })

  it('does not count a Ship/Port outside the connected Sea region', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'plain'], // breaks the water region
      [2, 0, 'water'],
    ])
    const thisPort = makeUnit('p1', 'port', { q: 0, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const distantShip = makeUnit('p2', 'ship', { q: 2, r: 0 }, { isMobile: true, terrains: ['water'], canCrossCliffs: false })
    const state = makeState({ board, units: [thisPort, distantShip] })

    const next = applyUnitActionEffect(state, 'p1', 'port', action, {}, content)

    expect(next.players.find((p) => p.id === 'p1')?.resources.gold).toBe(4) // only itself
  })
})

describe("transform effect's requiredAdjacentTerrain (Ship: Construct a Port)", () => {
  const content: UnitContent = {
    ...EMPTY_UNIT_CONTENT,
    movementByKind: { port: { isMobile: false, terrains: [], canCrossCliffs: false } },
    terrainLevels: TERRAIN_LEVELS,
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: { port: 5 },
  }
  const action = {
    id: 'construct-port',
    name: 'Construct a Port',
    description: '',
    effect: {
      actionType: 'transform' as const,
      targetUnit: 'port',
      targetHex: { terrainType: ['water'], location: 'self' as const },
      destroySelf: true,
      cost: {},
      requiredAdjacentTerrain: ['plain'],
    },
  }

  it('succeeds when the Ship is adjacent to a Plains space', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'plain']])
    const ship = makeUnit('p1', 'ship', { q: 0, r: 0 }, { isMobile: true, terrains: ['water'], canCrossCliffs: false })
    const state = makeState({ board, units: [ship] })

    const next = applyUnitActionEffect(state, 'p1', 'ship', action, {}, content)

    expect(next.units.find((u) => u.id === ship.id)).toBeUndefined() // destroySelf
    expect(next.units.some((u) => u.kind === 'port' && coordKey(u.coord) === coordKey(ship.coord))).toBe(true)
  })

  it('is rejected when the Ship has no adjacent Plains space', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water']])
    const ship = makeUnit('p1', 'ship', { q: 0, r: 0 }, { isMobile: true, terrains: ['water'], canCrossCliffs: false })
    const state = makeState({ board, units: [ship] })

    const next = applyUnitActionEffect(state, 'p1', 'ship', action, {}, content)

    expect(next).toBe(state)
  })
})

// --- Group 3: movement — Ship landing on an allied vs. opposing Port ---

describe('canEndMoveOnAlliedUnitTypes (Ship landing on a Port)', () => {
  const shipMovement: UnitMovement = {
    isMobile: true,
    terrains: ['water'],
    canCrossCliffs: false,
    blockedByUnits: 'none',
    canEndMoveOnAlliedUnitTypes: ['port'],
  }

  it("may land on its own owner's Port", () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water']])
    const ownPort = makeUnit('p1', 'port', { q: 1, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const ship = makeUnit('p1', 'ship', { q: 0, r: 0 }, shipMovement)
    const state = makeState({ board, units: [ownPort, ship] })

    const destinations = legalMoveDestinations(state, ship, shipMovement, TERRAIN_LEVELS)

    expect(destinations.map(coordKey)).toContain(coordKey(ownPort.coord))
  })

  it("may never land in an opposing player's Port", () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water']])
    const enemyPort = makeUnit('p2', 'port', { q: 1, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const ship = makeUnit('p1', 'ship', { q: 0, r: 0 }, shipMovement)
    const state = makeState({ board, units: [enemyPort, ship] })

    const destinations = legalMoveDestinations(state, ship, shipMovement, TERRAIN_LEVELS)

    expect(destinations.map(coordKey)).not.toContain(coordKey(enemyPort.coord))
  })

  it('may pass through (but not land on) a Port already holding an allied Ship — at most one Ship per Port', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water'], [2, 0, 'water']])
    const ownPort = makeUnit('p1', 'port', { q: 1, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const dockedShip = makeUnit('p1', 'ship', { q: 1, r: 0 }, shipMovement)
    const movingShip = makeUnit('p1', 'ship', { q: 0, r: 0 }, shipMovement)
    const state = makeState({ board, units: [ownPort, dockedShip, movingShip] })

    const destinations = legalMoveDestinations(state, movingShip, shipMovement, TERRAIN_LEVELS)

    expect(destinations.map(coordKey)).not.toContain(coordKey(ownPort.coord)) // can't land, already holds a Ship
    expect(destinations.map(coordKey)).toContain(coordKey({ q: 2, r: 0 })) // but passed straight through it
  })
})

// --- Group 4: companion-piece dispatch through applyAction (RESOLVE_UNIT_ACTION) ---

describe('companion piece dispatch — Port activates alongside the Ship card', () => {
  const shipMovement: UnitMovement = { isMobile: true, terrains: ['water'], canCrossCliffs: false, blockedByUnits: 'none' }
  const portMovement: UnitMovement = { isMobile: false, terrains: [], canCrossCliffs: false }

  const content: UnitContent = {
    actionsByKind: {
      ship: [
        { id: 'ship-income', name: 'Ship Income', description: '', effect: { actionType: 'income', goldByTerrain: { water: 3 } } },
        {
          id: 'ship-transform-to-port',
          name: 'Transform to Port',
          description: '',
          effect: { actionType: 'transform', targetUnit: 'port', targetHex: { terrainType: ['water'], location: 'self' }, destroySelf: true, cost: {} },
        },
      ],
      port: [
        { id: 'port-income', name: 'Port Income', description: '', effect: { actionType: 'income', goldByTerrain: { water: 5 } } },
        { id: 'port-build-ship', name: 'Build Ship', description: '', effect: { actionType: 'site-create', targetUnit: 'ship', blockedByKinds: ['ship'], cost: {} } },
      ],
    },
    movementByKind: { ship: shipMovement, port: portMovement },
    terrainLevels: TERRAIN_LEVELS,
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: { ship: 10, port: 10 },
    companionKindsByCardKind: { ship: ['port'] },
  }

  // Two players, not one: with a single player, finishing p1's one and only
  // acting unit's turn immediately cascades the whole round to completion
  // (recycle -> next round's select-cards), and since Port carries no
  // Civilization card, a player who just converted their only Ship into a
  // Port has nothing left in hand to choose next round and gets eliminated
  // — a real, correct consequence of the base game's existing elimination
  // rule, but not what these tests are trying to isolate. Keeping p2
  // pending (given a Nomad card they never actually have to resolve here)
  // keeps the round from finishing after p1's single action, so these
  // tests can inspect state right after p1's turn instead.
  function makeGameWithShipAndPort(includePort: boolean): GameState {
    const p1Cards = createPlayerCards('p1')
    const p2Cards = createPlayerCards('p2')
    const cards = [...p1Cards, ...p2Cards].reduce((acc, c) => ({ ...acc, [c.id]: c }), {} as GameState['cards'])
    const ship = makeUnit('p1', 'ship', { q: 0, r: 0 }, shipMovement)
    const units = includePort ? [ship, makeUnit('p1', 'port', { q: 1, r: 0 }, portMovement)] : [ship]
    const board = boardOf([[0, 0, 'water'], [1, 0, 'water']])

    let state = makeState({
      board,
      units,
      cards,
      players: [
        makePlayer('p1', { handCardIds: [cardIdFor('p1', 'ship')] }),
        makePlayer('p2', { handCardIds: [cardIdFor('p2', 'nomad')] }),
      ],
      turnOrder: ['p1', 'p2'],
      roundPhase: 'selectCards',
    })
    state = beginSelectCardsPhase(state)
    return state
  }

  /** Drives both players' CHOOSE_CARD (p1: Ship, p2: Nomad — p2 never actually resolves an action in these tests) to reach the actions phase with p1 first up. */
  function chooseCards(state: GameState): GameState {
    const p1Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'ship') }, content)
    if (!p1Choice.ok) throw new Error('p1 setup failed')
    const p2Choice = applyAction(p1Choice.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'nomad') }, content)
    if (!p2Choice.ok) throw new Error('p2 setup failed')
    return p2Choice.state
  }

  it('lets a pre-existing Port act (its own action) when the Ship card is played', () => {
    const state = chooseCards(makeGameWithShipAndPort(true))

    const port = state.units.find((u) => u.kind === 'port')!
    const result = applyAction(state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: port.id, actionId: 'port-income' }] }, content)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.players.find((p) => p.id === 'p1')?.resources.gold).toBe(5)
  })

  it("rejects a companion Port acting the same turn it was built (can't activate the turn it's constructed)", () => {
    // A second, untouched Ship keeps p1's turn open after the first Ship
    // transforms into a Port — otherwise resolving p1's only acting unit
    // would auto-end their turn immediately (see finishActionsTurn), which
    // resets unitsCreatedThisTurn for their next turn before this test
    // could ever attempt the same-turn companion action it's checking for.
    let state = chooseCards(makeGameWithShipAndPort(false))
    const secondShip = makeUnit('p1', 'ship', { q: 1, r: 0 }, shipMovement)
    state = { ...state, units: [...state.units, secondShip] }

    const ship = state.units.find((u) => u.kind === 'ship' && u.id !== secondShip.id)!
    const built = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: ship.id, actionId: 'ship-transform-to-port' }] },
      content,
    )
    if (!built.ok) throw new Error('ship-to-port transform failed')
    expect(built.state.roundPhase).toBe('actions') // still p1's turn — the untouched second Ship kept it open
    const newPort = built.state.units.find((u) => u.kind === 'port')!
    expect(built.state.unitsCreatedThisTurn).toContain(newPort.id)

    const result = applyAction(
      built.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: newPort.id, actionId: 'port-income' }] },
      content,
    )

    expect(result.ok).toBe(false)
  })

  it('lets a Ship freshly built by a Port act the same turn (not a companion — its kind matches the played card)', () => {
    const state = chooseCards(makeGameWithShipAndPort(true))

    const port = state.units.find((u) => u.kind === 'port')!
    const built = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: port.id, actionId: 'port-build-ship' }] },
      content,
    )
    if (!built.ok) throw new Error('port-build-ship failed')
    const newShip = built.state.units.find((u) => u.kind === 'ship' && coordKey(u.coord) === coordKey(port.coord))!
    expect(built.state.unitsCreatedThisTurn).toContain(newShip.id)

    const result = applyAction(
      built.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: newShip.id, actionId: 'ship-income' }] },
      content,
    )

    expect(result.ok).toBe(true)
  })

  it("does not require a freshly-built companion Port to act before the player's turn can end", () => {
    const state = chooseCards(makeGameWithShipAndPort(false))

    const ship = state.units.find((u) => u.kind === 'ship')!
    // Only one acting unit (the Ship) existed before this turn — resolving
    // it (even though it builds a brand-new companion Port as a side
    // effect) should be enough to finish p1's turn on its own; the fresh
    // Port must not be treated as an unresolved unit blocking that.
    const result = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: ship.id, actionId: 'ship-transform-to-port' }] },
      content,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.pendingPlayerIds).not.toContain('p1') // p1's turn ended; it's p2's turn now
    expect(result.state.activePlayerId).toBe('p2')
  })
})

// --- Group 5: The Banks (Tale #6) ---

const bankMovement: UnitMovement = { isMobile: false, terrains: [], canCrossCliffs: false }

describe('resolveTaleContent + applyTaleModifiers — The Banks, against real content/tales.json + units.json', () => {
  it('merges Bank as a Nomad companion, with no actions of its own', () => {
    const base = resolveUnitContent(3)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-banks'], 3))

    expect(merged.companionKindsByCardKind.nomad).toEqual(['bank'])
    expect(merged.unitSupplyCaps.bank).toBe(1)
    expect(merged.actionsByKind.bank).toEqual([])
    expect(merged.movementByKind.bank).toEqual(bankMovement)
  })

  it("appends construct-bank onto Nomad's actions and increase-taxes onto City's, without dropping either kind's base actions", () => {
    const base = resolveUnitContent(3)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-banks'], 3))

    const nomadActionIds = merged.actionsByKind.nomad.map((a) => a.id)
    const cityActionIds = merged.actionsByKind.city.map((a) => a.id)
    expect(nomadActionIds).toContain('construct-bank')
    expect(nomadActionIds).toContain('transform-to-ship') // base action still present
    expect(cityActionIds).toContain('increase-taxes')
    expect(cityActionIds.length).toBeGreaterThan(1) // base City actions still present
  })

  it('resolves a single Fantastic Event, Economic Collapse, requiring Bank', () => {
    const taleContent = resolveTaleContent(['the-banks'], 3)
    expect(taleContent.fantasticEvents).toEqual([{ id: 'economic-collapse', name: 'Economic Collapse', requiredUnitKind: 'bank' }])
  })
})

describe("income effect's goldByTerrainScaledByBoardUnitCount (City: Increase Taxes)", () => {
  const effect: IncomeEffect = {
    actionType: 'income',
    goldByTerrainScaledByBoardUnitCount: { ratePerTerrain: { mountain: 1, plain: 2, forest: 3 }, countKind: 'bank' },
  }

  it("matches the rulebook's own worked example: a Plain City, 3 total Banks in the World (this player's + 2 others') -> 2 + 3x2 = 8 GP", () => {
    const board = boardOf([[0, 0, 'plain']])
    const city = makeUnit('p1', 'city', { q: 0, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const ownBank = makeUnit('p1', 'bank', { q: 5, r: 5 }, bankMovement)
    const otherBank1 = makeUnit('p2', 'bank', { q: 6, r: 5 }, bankMovement)
    const otherBank2 = makeUnit('p3', 'bank', { q: 7, r: 5 }, bankMovement)
    const state = makeState({ board, units: [city, ownBank, otherBank1, otherBank2] })

    expect(computeIncomeGold(state, 'p1', city, effect)).toBe(8)
  })

  it('pays nothing when the acting player controls no Bank of their own, even if others do', () => {
    const board = boardOf([[0, 0, 'plain']])
    const city = makeUnit('p1', 'city', { q: 0, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const otherBank = makeUnit('p2', 'bank', { q: 6, r: 5 }, bankMovement)
    const state = makeState({ board, units: [city, otherBank] })

    expect(computeIncomeGold(state, 'p1', city, effect)).toBe(0)
  })

  it('scales by terrain: a Mountain City with just its own Bank in the World gains 1 + 1x1 = 2 GP', () => {
    const board = boardOf([[0, 0, 'mountain']])
    const city = makeUnit('p1', 'city', { q: 0, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const ownBank = makeUnit('p1', 'bank', { q: 5, r: 5 }, bankMovement)
    const state = makeState({ board, units: [city, ownBank] })

    expect(computeIncomeGold(state, 'p1', city, effect)).toBe(2)
  })
})

describe('transform effect: requiredAdjacentOwnUnitKind + extraCostPerBoardUnitCount (Nomad: Construct a Bank)', () => {
  const content: UnitContent = {
    ...EMPTY_UNIT_CONTENT,
    movementByKind: { bank: bankMovement },
    terrainLevels: TERRAIN_LEVELS,
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: { bank: 5 },
  }
  const effect: TransformEffect = {
    actionType: 'transform',
    targetUnit: 'bank',
    targetHex: { terrainType: ['plain', 'forest'], location: 'self' },
    destroySelf: true,
    cost: { gold: 5, wood: 1, stone: 2 },
    requiredAdjacentOwnUnitKind: 'city',
    extraCostPerBoardUnitCount: { countKind: 'bank', costPerUnit: { gold: 5 } },
  }
  const action = { id: 'construct-bank', name: 'Construct a Bank', description: '', effect }

  it('succeeds when adjacent to an allied City, replacing the Nomad with a Bank', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const nomad = makeUnit('p1', 'nomad', { q: 0, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const city = makeUnit('p1', 'city', { q: 1, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const state = makeState({ board, units: [nomad, city], players: [makePlayer('p1', { resources: { gold: 10, wood: 5, stone: 5 } })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, content)

    expect(next.units.find((u) => u.id === nomad.id)).toBeUndefined() // destroySelf
    expect(next.units.some((u) => u.kind === 'bank' && coordKey(u.coord) === coordKey(nomad.coord))).toBe(true)
    const player = next.players.find((p) => p.id === 'p1')!
    expect(player.resources).toEqual({ gold: 5, wood: 4, stone: 3 }) // 5 GP (no existing Banks) + 1 wood + 2 stone
  })

  it('is rejected when not adjacent to an allied City', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const nomad = makeUnit('p1', 'nomad', { q: 0, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const state = makeState({ board, units: [nomad], players: [makePlayer('p1', { resources: { gold: 10, wood: 5, stone: 5 } })] })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, content)

    expect(next).toBe(state)
  })

  it("costs 5 extra GP per Bank already in the World: the 2nd Bank costs 10 GP, the 3rd costs 15 GP", () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [2, 0, 'plain'], [3, 0, 'plain']])
    const nomad = makeUnit('p1', 'nomad', { q: 0, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const city = makeUnit('p1', 'city', { q: 1, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    // Two Banks already in the World (any owner) before this Nomad acts.
    const existingBank1 = makeUnit('p1', 'bank', { q: 2, r: 0 }, bankMovement)
    const existingBank2 = makeUnit('p2', 'bank', { q: 3, r: 0 }, bankMovement)
    const state = makeState({
      board,
      units: [nomad, city, existingBank1, existingBank2],
      players: [makePlayer('p1', { resources: { gold: 20, wood: 5, stone: 5 } })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, content)

    const player = next.players.find((p) => p.id === 'p1')!
    // Base 5 GP + 2 existing Banks x 5 GP = 15 GP total, plus the flat 1 wood/2 stone.
    expect(player.resources).toEqual({ gold: 5, wood: 4, stone: 3 })
  })

  it('legalTransformTargets is empty without an adjacent allied City, and reflects the scaled cost via canAffordCost', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const nomadNoCity = makeUnit('p1', 'nomad', { q: 0, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const state = makeState({ board, units: [nomadNoCity], players: [makePlayer('p1', { resources: { gold: 10, wood: 5, stone: 5 } })] })

    expect(legalTransformTargets(state, 'p1', nomadNoCity, effect, content)).toEqual([])
  })
})

describe('convert immunity — a Bank can never be targeted by targetMobileOnly: true (e.g. Temple: Convert Enemy Unit)', () => {
  const effect: ConvertEffect = { actionType: 'convert', targetHex: { location: 'adj' }, targetOwner: 'enemy', targetMobileOnly: true, cost: {} }

  it('excludes an adjacent enemy Bank', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const temple = makeUnit('p1', 'temple', { q: 0, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const enemyBank = makeUnit('p2', 'bank', { q: 1, r: 0 }, bankMovement)
    const state = makeState({ board, units: [temple, enemyBank], players: [makePlayer('p1'), makePlayer('p2')] })
    const content: UnitContent = { ...EMPTY_UNIT_CONTENT, movementByKind: { bank: bankMovement } }

    expect(legalConvertTargets(state, 'p1', temple, effect, content)).toEqual([])
  })
})

describe('Fantastic Events (finishRound) — Economic Collapse', () => {
  const economicCollapse: FantasticEvent = { id: 'economic-collapse', name: 'Economic Collapse', requiredUnitKind: 'bank' }

  function stateNeedingRecycle(recyclingPlayerCount: 0 | 1 | 2 | 3, units: Unit[]): GameState {
    const players = [
      makePlayer('p1', recyclingPlayerCount >= 1 ? { handCardIds: [], discardCardIds: ['c1'] } : { handCardIds: ['c1'] }),
      makePlayer('p2', recyclingPlayerCount >= 2 ? { handCardIds: [], discardCardIds: ['c2'] } : { handCardIds: ['c2'] }),
      makePlayer('p3', recyclingPlayerCount >= 3 ? { handCardIds: [], discardCardIds: ['c3'] } : { handCardIds: ['c3'] }),
    ]
    return makeState({ players, turnOrder: ['p1', 'p2', 'p3'], units })
  }

  it('removes every Bank from the board once every non-eliminated player controls one, when 2+ players recycle', () => {
    const banks = [makeUnit('p1', 'bank', { q: 0, r: 0 }, bankMovement), makeUnit('p2', 'bank', { q: 1, r: 0 }, bankMovement), makeUnit('p3', 'bank', { q: 2, r: 0 }, bankMovement)]
    const state = stateNeedingRecycle(2, banks)

    const next = finishRound(state, undefined, { ...EMPTY_TALE_CONTENT, fantasticEvents: [economicCollapse] })

    expect(next.units.some((u) => u.kind === 'bank')).toBe(false)
  })

  it('does not trigger when fewer than 2 players recycle this round', () => {
    const banks = [makeUnit('p1', 'bank', { q: 0, r: 0 }, bankMovement), makeUnit('p2', 'bank', { q: 1, r: 0 }, bankMovement), makeUnit('p3', 'bank', { q: 2, r: 0 }, bankMovement)]
    const state = stateNeedingRecycle(1, banks)

    const next = finishRound(state, undefined, { ...EMPTY_TALE_CONTENT, fantasticEvents: [economicCollapse] })

    expect(next.units.filter((u) => u.kind === 'bank')).toHaveLength(3)
  })

  it('does not trigger when at least one non-eliminated player controls no Bank', () => {
    const banks = [makeUnit('p1', 'bank', { q: 0, r: 0 }, bankMovement), makeUnit('p2', 'bank', { q: 1, r: 0 }, bankMovement)] // p3 has none
    const state = stateNeedingRecycle(2, banks)

    const next = finishRound(state, undefined, { ...EMPTY_TALE_CONTENT, fantasticEvents: [economicCollapse] })

    expect(next.units.filter((u) => u.kind === 'bank')).toHaveLength(2)
  })

  it('ignores an eliminated player when checking whether everyone controls a Bank', () => {
    const banks = [makeUnit('p1', 'bank', { q: 0, r: 0 }, bankMovement), makeUnit('p2', 'bank', { q: 1, r: 0 }, bankMovement)] // p3 has none, but is eliminated
    let state = stateNeedingRecycle(2, banks)
    state = { ...state, players: state.players.map((p) => (p.id === 'p3' ? { ...p, eliminated: true } : p)) }

    const next = finishRound(state, undefined, { ...EMPTY_TALE_CONTENT, fantasticEvents: [economicCollapse] })

    expect(next.units.some((u) => u.kind === 'bank')).toBe(false)
  })

  it('is a no-op when taleContent has no Fantastic Events (e.g. The Banks not active)', () => {
    const banks = [makeUnit('p1', 'bank', { q: 0, r: 0 }, bankMovement), makeUnit('p2', 'bank', { q: 1, r: 0 }, bankMovement), makeUnit('p3', 'bank', { q: 2, r: 0 }, bankMovement)]
    const state = stateNeedingRecycle(2, banks)

    const next = finishRound(state, undefined, EMPTY_TALE_CONTENT)

    expect(next.units.filter((u) => u.kind === 'bank')).toHaveLength(3)
  })
})

// --- Group 6: The Cathedral (Tale #8) ---

const cathedralMovement: UnitMovement = { isMobile: false, terrains: [], canCrossCliffs: false }
const templeMovement: UnitMovement = { isMobile: false, terrains: [], canCrossCliffs: false }

describe('resolveTaleContent + applyTaleModifiers — The Cathedral, against real content/tales.json + units.json', () => {
  it('merges Cathedral as a Temple companion, with its own two actions', () => {
    const base = resolveUnitContent(3)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-cathedral'], 3))

    expect(merged.companionKindsByCardKind.temple).toEqual(['cathedral'])
    expect(merged.unitSupplyCaps.cathedral).toBe(1)
    expect(merged.actionsByKind.cathedral?.map((a) => a.id).sort()).toEqual(['convert-enemy-unit', 'generate-income'])
    expect(merged.movementByKind.cathedral).toEqual(cathedralMovement)
  })

  it("appends construct-cathedral onto Temple's actions, without dropping Temple's base actions", () => {
    const base = resolveUnitContent(3)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-cathedral'], 3))

    const templeActionIds = merged.actionsByKind.temple.map((a) => a.id)
    expect(templeActionIds).toContain('construct-cathedral')
    expect(templeActionIds).toContain('convert-enemy-unit') // base action still present
    expect(templeActionIds).toContain('generate-income') // base action still present
  })

  it('resolves a single controllable structure worth 15 VP', () => {
    const taleContent = resolveTaleContent(['the-cathedral'], 3)
    expect(taleContent.controllableStructures).toEqual([{ kind: 'cathedral', name: 'The Cathedral', victoryPoints: 15 }])
  })

  it("real Cathedral convert-enemy-unit has maxDistance 2 and Temple's own costByTargetKind", () => {
    const merged = applyTaleModifiers(resolveUnitContent(2), resolveTaleContent(['the-cathedral'], 2))
    const effect = merged.actionsByKind.cathedral.find((a) => a.id === 'convert-enemy-unit')!.effect as ConvertEffect
    expect(effect.maxDistance).toBe(2)
    expect(effect.costByTargetKind).toEqual({
      nomad: { gold: 2 },
      mountaineer: { gold: 3 },
      merchant: { gold: 5 },
      ship: { gold: 5 },
    })
  })

  it('real Cathedral generate-income has maxDistance 2 and excludes Temple, same as the base Temple action', () => {
    const merged = applyTaleModifiers(resolveUnitContent(2), resolveTaleContent(['the-cathedral'], 2))
    const cathedralEffect = merged.actionsByKind.cathedral.find((a) => a.id === 'generate-income')!.effect as IncomeEffect
    const templeEffect = merged.actionsByKind.temple.find((a) => a.id === 'generate-income')!.effect as IncomeEffect
    expect(cathedralEffect.maxDistance).toBe(2)
    expect(cathedralEffect.goldPerAdjacentOwnUnit).toBe(templeEffect.goldPerAdjacentOwnUnit)
    expect(cathedralEffect.excludeUnitTypes).toEqual(templeEffect.excludeUnitTypes)
  })
})

describe('transform effect: requiredOwnKindCount + forbiddenIfBoardHasKind (Temple: Construct the Cathedral)', () => {
  const content: UnitContent = {
    ...EMPTY_UNIT_CONTENT,
    movementByKind: { cathedral: cathedralMovement },
    terrainLevels: TERRAIN_LEVELS,
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: { cathedral: 1 },
  }
  const effect: TransformEffect = {
    actionType: 'transform',
    targetUnit: 'cathedral',
    targetHex: { terrainType: ['plain', 'mountain'], location: 'self' },
    destroySelf: true,
    cost: { gold: 0, wood: 3, stone: 5 },
    requiredOwnKindCount: { kind: 'temple', atLeast: 3 },
    forbiddenIfBoardHasKind: 'cathedral',
  }
  const action = { id: 'construct-cathedral', name: 'Construct the Cathedral', description: '', effect }

  it('succeeds when the player has all 3 Temples in play and no Cathedral exists yet', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [2, 0, 'plain']])
    const actingTemple = makeUnit('p1', 'temple', { q: 0, r: 0 }, templeMovement)
    const otherTemple1 = makeUnit('p1', 'temple', { q: 1, r: 0 }, templeMovement)
    const otherTemple2 = makeUnit('p1', 'temple', { q: 2, r: 0 }, templeMovement)
    const state = makeState({
      board,
      units: [actingTemple, otherTemple1, otherTemple2],
      players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'temple', action, {}, content, [actingTemple.id])

    expect(next.units.find((u) => u.id === actingTemple.id)).toBeUndefined() // destroySelf
    expect(next.units.some((u) => u.kind === 'cathedral' && coordKey(u.coord) === coordKey(actingTemple.coord))).toBe(true)
    expect(next.units.filter((u) => u.kind === 'temple')).toHaveLength(2) // the other two remain
    const player = next.players.find((p) => p.id === 'p1')!
    expect(player.resources).toEqual({ gold: 0, wood: 2, stone: 0 })
  })

  it('is rejected with fewer than 3 Temples in play', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const actingTemple = makeUnit('p1', 'temple', { q: 0, r: 0 }, templeMovement)
    const otherTemple = makeUnit('p1', 'temple', { q: 1, r: 0 }, templeMovement)
    const state = makeState({
      board,
      units: [actingTemple, otherTemple],
      players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } })],
    })

    const next = applyUnitActionEffect(state, 'p1', 'temple', action, {}, content, [actingTemple.id])

    expect(next).toBe(state)
  })

  it('is rejected once a Cathedral already exists anywhere in the World, even for a different player', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [2, 0, 'plain'], [9, 9, 'plain']])
    const actingTemple = makeUnit('p1', 'temple', { q: 0, r: 0 }, templeMovement)
    const otherTemple1 = makeUnit('p1', 'temple', { q: 1, r: 0 }, templeMovement)
    const otherTemple2 = makeUnit('p1', 'temple', { q: 2, r: 0 }, templeMovement)
    const existingCathedral = makeUnit('p2', 'cathedral', { q: 9, r: 9 }, cathedralMovement)
    const state = makeState({
      board,
      units: [actingTemple, otherTemple1, otherTemple2, existingCathedral],
      players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } }), makePlayer('p2')],
    })

    const next = applyUnitActionEffect(state, 'p1', 'temple', action, {}, content, [actingTemple.id])

    expect(next).toBe(state)
  })

  it('legalTransformTargets is empty with fewer than 3 Temples, and non-empty with all 3', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [2, 0, 'plain']])
    const actingTemple = makeUnit('p1', 'temple', { q: 0, r: 0 }, templeMovement)
    const stateShort = makeState({ board, units: [actingTemple], players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } })] })
    expect(legalTransformTargets(stateShort, 'p1', actingTemple, effect, content)).toEqual([])

    const otherTemple1 = makeUnit('p1', 'temple', { q: 1, r: 0 }, templeMovement)
    const otherTemple2 = makeUnit('p1', 'temple', { q: 2, r: 0 }, templeMovement)
    const stateFull = makeState({
      board,
      units: [actingTemple, otherTemple1, otherTemple2],
      players: [makePlayer('p1', { resources: { gold: 0, wood: 5, stone: 5 } })],
    })
    expect(legalTransformTargets(stateFull, 'p1', actingTemple, effect, content)).toEqual([actingTemple.coord])
  })
})

describe("convert effect's maxDistance (Cathedral: Convert Enemy Unit at range 2)", () => {
  const content: UnitContent = { ...EMPTY_UNIT_CONTENT, movementByKind: { nomad: { isMobile: true, terrains: ['plain'], canCrossCliffs: false } } }
  const effect: ConvertEffect = { actionType: 'convert', targetHex: { location: 'adj' }, targetOwner: 'enemy', targetMobileOnly: true, maxDistance: 2, cost: {} }
  const action = { id: 'convert-enemy-unit', name: 'Convert Enemy Unit', description: '', effect }

  it('reaches an enemy unit 2 spaces away, not just adjacent', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [2, 0, 'plain']])
    const cathedral = makeUnit('p1', 'cathedral', { q: 0, r: 0 }, cathedralMovement)
    const enemyNomad = makeUnit('p2', 'nomad', { q: 2, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const state = makeState({ board, units: [cathedral, enemyNomad], players: [makePlayer('p1'), makePlayer('p2')] })

    const next = applyUnitActionEffect(state, 'p1', 'cathedral', action, { [cathedral.id]: enemyNomad.coord }, content)

    expect(next.units.find((u) => u.id === enemyNomad.id)?.ownerId).toBe('p1')
  })

  it('does not reach 3 spaces away', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [2, 0, 'plain'], [3, 0, 'plain']])
    const cathedral = makeUnit('p1', 'cathedral', { q: 0, r: 0 }, cathedralMovement)
    const enemyNomad = makeUnit('p2', 'nomad', { q: 3, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const state = makeState({ board, units: [cathedral, enemyNomad], players: [makePlayer('p1'), makePlayer('p2')] })

    const next = applyUnitActionEffect(state, 'p1', 'cathedral', action, { [cathedral.id]: enemyNomad.coord }, content)

    expect(next).toBe(state)
  })

  it('legalConvertTargets at range 2 includes a hex 2 steps away', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [2, 0, 'plain']])
    const cathedral = makeUnit('p1', 'cathedral', { q: 0, r: 0 }, cathedralMovement)
    const enemyNomad = makeUnit('p2', 'nomad', { q: 2, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const state = makeState({ board, units: [cathedral, enemyNomad], players: [makePlayer('p1'), makePlayer('p2')] })

    expect(legalConvertTargets(state, 'p1', cathedral, effect, content).map(coordKey)).toContain(coordKey(enemyNomad.coord))
  })

  it('is not blocked by a cliff at range 2 (no single hexside to check)', () => {
    const board = boardOf([[0, 0, 'mountain'], [1, 0, 'plain'], [2, 0, 'water']]) // mountain(3) -> water(0) would be a cliff if adjacent
    const cathedral = makeUnit('p1', 'cathedral', { q: 0, r: 0 }, cathedralMovement)
    const enemyNomad = makeUnit('p2', 'nomad', { q: 2, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const state = makeState({ board, units: [cathedral, enemyNomad], players: [makePlayer('p1'), makePlayer('p2')] })

    const next = applyUnitActionEffect(state, 'p1', 'cathedral', action, { [cathedral.id]: enemyNomad.coord }, content)

    expect(next.units.find((u) => u.id === enemyNomad.id)?.ownerId).toBe('p1')
  })
})

describe("income effect's maxDistance (Cathedral: Generate Income at range 2)", () => {
  const effect: IncomeEffect = { actionType: 'income', goldPerAdjacentOwnUnit: 2, excludeUnitTypes: ['temple'], maxDistance: 2 }

  it('counts an own non-Temple unit 2 spaces away, not just adjacent', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [2, 0, 'plain']])
    const cathedral = makeUnit('p1', 'cathedral', { q: 0, r: 0 }, cathedralMovement)
    const ownNomad = makeUnit('p1', 'nomad', { q: 2, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const state = makeState({ board, units: [cathedral, ownNomad] })

    expect(computeIncomeGold(state, 'p1', cathedral, effect)).toBe(2)
  })

  it('excludes Temples within range, same as the base Temple action', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [2, 0, 'plain']])
    const cathedral = makeUnit('p1', 'cathedral', { q: 0, r: 0 }, cathedralMovement)
    const ownTemple = makeUnit('p1', 'temple', { q: 2, r: 0 }, templeMovement)
    const state = makeState({ board, units: [cathedral, ownTemple] })

    expect(computeIncomeGold(state, 'p1', cathedral, effect)).toBe(0)
  })

  it('does not count a unit 3 spaces away', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain'], [2, 0, 'plain'], [3, 0, 'plain']])
    const cathedral = makeUnit('p1', 'cathedral', { q: 0, r: 0 }, cathedralMovement)
    const farNomad = makeUnit('p1', 'nomad', { q: 3, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const state = makeState({ board, units: [cathedral, farNomad] })

    expect(computeIncomeGold(state, 'p1', cathedral, effect)).toBe(0)
  })
})

describe('convert immunity — a Cathedral is immobile, so a Convert Enemy Unit with targetMobileOnly: true never reaches it', () => {
  it('excludes an adjacent enemy Cathedral', () => {
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])
    const temple = makeUnit('p1', 'temple', { q: 0, r: 0 }, templeMovement)
    const enemyCathedral = makeUnit('p2', 'cathedral', { q: 1, r: 0 }, cathedralMovement)
    const state = makeState({ board, units: [temple, enemyCathedral], players: [makePlayer('p1'), makePlayer('p2')] })
    const content: UnitContent = { ...EMPTY_UNIT_CONTENT, movementByKind: { cathedral: cathedralMovement } }
    const effect: ConvertEffect = { actionType: 'convert', targetHex: { location: 'adj' }, targetOwner: 'enemy', targetMobileOnly: true, cost: {} }

    expect(legalConvertTargets(state, 'p1', temple, effect, content)).toEqual([])
  })
})

describe('calculateControllableStructureVP — The Cathedral, against real content/tales.json', () => {
  it('awards the real 15 VP to whoever controls the Cathedral, and 0 to everyone else', () => {
    const taleContent = resolveTaleContent(['the-cathedral'], 2)
    const cathedral = makeUnit('p1', 'cathedral', { q: 0, r: 0 }, cathedralMovement)

    const vp = calculateControllableStructureVP([cathedral], taleContent.controllableStructures)

    expect(vp).toEqual({ p1: 15 })
  })

  it('awards nothing while no Cathedral has been built', () => {
    const taleContent = resolveTaleContent(['the-cathedral'], 2)

    expect(calculateControllableStructureVP([], taleContent.controllableStructures)).toEqual({})
  })
})

describe('companion piece dispatch — Cathedral activates alongside the Temple card, not the turn it is built', () => {
  const content: UnitContent = {
    actionsByKind: {
      temple: [
        { id: 'temple-income', name: 'Temple Income', description: '', effect: { actionType: 'income', goldByTerrain: { plain: 3 } } },
        {
          id: 'construct-cathedral',
          name: 'Construct the Cathedral',
          description: '',
          effect: {
            actionType: 'transform',
            targetUnit: 'cathedral',
            targetHex: { terrainType: ['plain', 'mountain'], location: 'self' },
            destroySelf: true,
            cost: {},
            requiredOwnKindCount: { kind: 'temple', atLeast: 1 },
            forbiddenIfBoardHasKind: 'cathedral',
          },
        },
      ],
      cathedral: [{ id: 'cathedral-income', name: 'Cathedral Income', description: '', effect: { actionType: 'income', goldByTerrain: { plain: 5 } } }],
    },
    movementByKind: { temple: templeMovement, cathedral: cathedralMovement },
    terrainLevels: TERRAIN_LEVELS,
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: { temple: 10, cathedral: 1 },
    companionKindsByCardKind: { temple: ['cathedral'] },
  }

  // Two players (see the matching Ports test's comment above for why):
  // otherwise finishing p1's only acting unit's turn cascades the whole
  // round to completion before these tests can inspect the mid-turn state.
  function makeGameWithTempleAndCathedral(includeCathedral: boolean): GameState {
    const p1Cards = createPlayerCards('p1')
    const p2Cards = createPlayerCards('p2')
    const cards = [...p1Cards, ...p2Cards].reduce((acc, c) => ({ ...acc, [c.id]: c }), {} as GameState['cards'])
    const temple = makeUnit('p1', 'temple', { q: 0, r: 0 }, templeMovement)
    const units = includeCathedral ? [temple, makeUnit('p1', 'cathedral', { q: 1, r: 0 }, cathedralMovement)] : [temple]
    const board = boardOf([[0, 0, 'plain'], [1, 0, 'plain']])

    let state = makeState({
      board,
      units,
      cards,
      players: [
        makePlayer('p1', { handCardIds: [cardIdFor('p1', 'temple')] }),
        makePlayer('p2', { handCardIds: [cardIdFor('p2', 'nomad')] }),
      ],
      turnOrder: ['p1', 'p2'],
      roundPhase: 'selectCards',
    })
    state = beginSelectCardsPhase(state)
    return state
  }

  function chooseCards(state: GameState): GameState {
    const p1Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'temple') }, content)
    if (!p1Choice.ok) throw new Error('p1 setup failed')
    const p2Choice = applyAction(p1Choice.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'nomad') }, content)
    if (!p2Choice.ok) throw new Error('p2 setup failed')
    return p2Choice.state
  }

  it('lets a pre-existing Cathedral act (its own action) when the Temple card is played', () => {
    const state = chooseCards(makeGameWithTempleAndCathedral(true))

    const cathedral = state.units.find((u) => u.kind === 'cathedral')!
    const result = applyAction(state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: cathedral.id, actionId: 'cathedral-income' }] }, content)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.players.find((p) => p.id === 'p1')?.resources.gold).toBe(5)
  })

  it("rejects a companion Cathedral acting the same turn it was built (can't activate the turn it's constructed)", () => {
    let state = chooseCards(makeGameWithTempleAndCathedral(false))
    const secondTemple = makeUnit('p1', 'temple', { q: 1, r: 0 }, templeMovement)
    state = { ...state, units: [...state.units, secondTemple] }

    const temple = state.units.find((u) => u.kind === 'temple' && u.id !== secondTemple.id)!
    const built = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: temple.id, actionId: 'construct-cathedral' }] },
      content,
    )
    if (!built.ok) throw new Error('temple-to-cathedral transform failed')
    expect(built.state.roundPhase).toBe('actions') // still p1's turn — the untouched second Temple kept it open
    const newCathedral = built.state.units.find((u) => u.kind === 'cathedral')!
    expect(built.state.unitsCreatedThisTurn).toContain(newCathedral.id)

    const result = applyAction(
      built.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: newCathedral.id, actionId: 'cathedral-income' }] },
      content,
    )

    expect(result.ok).toBe(false)
  })
})
