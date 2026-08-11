import { describe, expect, it } from 'vitest'
import { resolveTaleContent, resolveUnitContent } from '../../content/resolveContent'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { cardIdFor, createPlayerCards } from '../cards'
import { legalMoveDestinations } from '../movement'
import { beginSelectCardsPhase } from '../round'
import { applyTaleModifiers } from '../tales'
import { EMPTY_TALE_CONTENT } from '../taleContent'
import type { Coordinate, GameState, Player, Terrain, Unit, UnitMovement } from '../types'
import { coordKey } from '../types'
import type { UnitContent } from '../unitContent'
import { EMPTY_UNIT_CONTENT } from '../unitContent'
import { applyUnitActionEffect } from '../unitActions'

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
