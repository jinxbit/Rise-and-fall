import { describe, expect, it } from 'vitest'
import { createEmptyBoard, setTile } from '../board'
import { legalMoveDestinations } from '../movement'
import type { Coordinate, GameState, Player, Terrain, Unit, UnitMovement } from '../types'
import { coordKey } from '../types'

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
function makeUnit(ownerId: string, kind: string, coord: Coordinate, movement: UnitMovement): Unit {
  unitCounter += 1
  return {
    id: `unit_${unitCounter}`,
    ownerId,
    kind,
    coord,
    movement,
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

function hasCoord(destinations: Coordinate[], coord: Coordinate): boolean {
  return destinations.some((c) => coordKey(c) === coordKey(coord))
}

describe('legalMoveDestinations', () => {
  it('returns nothing for an immobile unit', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const unit = makeUnit('p1', 'city', { q: 0, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const state = makeState({ board, units: [unit] })

    expect(legalMoveDestinations(state, unit, unit.movement, TERRAIN_LEVELS)).toEqual([])
  })

  it('caps the search at moveDistance steps', () => {
    // A straight line of plain hexes; moveDistance: 1 should only reach the immediate neighbor.
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [2, 0, 'plain'],
    ])
    const unit = makeUnit('p1', 'nomad', { q: 0, r: 0 }, {
      isMobile: true,
      terrains: ['plain'],
      canCrossCliffs: false,
      moveDistance: 1,
      blockedByUnits: 'all',
    })
    const state = makeState({ board, units: [unit] })

    const destinations = legalMoveDestinations(state, unit, unit.movement, TERRAIN_LEVELS)

    expect(hasCoord(destinations, { q: 1, r: 0 })).toBe(true)
    expect(hasCoord(destinations, { q: 2, r: 0 })).toBe(false)
  })

  it('only steps onto terrain the unit is allowed on', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'water'],
      [1, -1, 'forest'],
    ])
    const unit = makeUnit('p1', 'nomad', { q: 0, r: 0 }, {
      isMobile: true,
      terrains: ['plain', 'forest', 'mountain'],
      canCrossCliffs: false,
      moveDistance: 1,
      blockedByUnits: 'all',
    })
    const state = makeState({ board, units: [unit] })

    const destinations = legalMoveDestinations(state, unit, unit.movement, TERRAIN_LEVELS)

    expect(hasCoord(destinations, { q: 1, r: 0 })).toBe(false)
    expect(hasCoord(destinations, { q: 1, r: -1 })).toBe(true)
  })

  it('blocks crossing a cliff edge unless canCrossCliffs is true', () => {
    // plain (level 1) -> glacier (level 4): |4-1| = 3 > 1, a cliff edge.
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'glacier'],
    ])
    const blocked = makeUnit('p1', 'nomad', { q: 0, r: 0 }, {
      isMobile: true,
      terrains: ['plain', 'glacier'],
      canCrossCliffs: false,
      moveDistance: 1,
      blockedByUnits: 'all',
    })
    const state1 = makeState({ board, units: [blocked] })
    expect(hasCoord(legalMoveDestinations(state1, blocked, blocked.movement, TERRAIN_LEVELS), { q: 1, r: 0 })).toBe(false)

    const crosser = makeUnit('p1', 'mountaineer', { q: 0, r: 0 }, {
      isMobile: true,
      terrains: ['plain', 'glacier'],
      canCrossCliffs: true,
      moveDistance: 1,
      blockedByUnits: 'enemy',
    })
    const state2 = makeState({ board, units: [crosser] })
    expect(hasCoord(legalMoveDestinations(state2, crosser, crosser.movement, TERRAIN_LEVELS), { q: 1, r: 0 })).toBe(true)
  })

  describe('blockedByUnits', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [2, 0, 'plain'],
    ])

    it("'none' passes through an occupied hex to reach hexes beyond it, but can't land on top of the occupant", () => {
      const mover = makeUnit('p1', 'ship', { q: 0, r: 0 }, {
        isMobile: true,
        terrains: ['plain'],
        canCrossCliffs: false,
        moveDistance: 'unlimited',
        blockedByUnits: 'none',
      })
      const blocker = makeUnit('p2', 'nomad', { q: 1, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
      const state = makeState({ board, units: [mover, blocker] })

      const destinations = legalMoveDestinations(state, mover, mover.movement, TERRAIN_LEVELS)

      expect(hasCoord(destinations, { q: 1, r: 0 })).toBe(false)
      expect(hasCoord(destinations, { q: 2, r: 0 })).toBe(true)
    })

    it("'enemy' blocks past an enemy unit but not past an own unit", () => {
      const mover = makeUnit('p1', 'mountaineer', { q: 0, r: 0 }, {
        isMobile: true,
        terrains: ['plain'],
        canCrossCliffs: false,
        moveDistance: 5,
        blockedByUnits: 'enemy',
      })
      const enemy = makeUnit('p2', 'nomad', { q: 1, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
      const state = makeState({ board, units: [mover, enemy] })

      const destinations = legalMoveDestinations(state, mover, mover.movement, TERRAIN_LEVELS)

      expect(hasCoord(destinations, { q: 1, r: 0 })).toBe(false)
      expect(hasCoord(destinations, { q: 2, r: 0 })).toBe(false)
    })

    it("'all' blocks past any occupied hex, friend or foe", () => {
      const mover = makeUnit('p1', 'nomad', { q: 0, r: 0 }, {
        isMobile: true,
        terrains: ['plain'],
        canCrossCliffs: false,
        moveDistance: 5,
        blockedByUnits: 'all',
      })
      const own = makeUnit('p1', 'nomad', { q: 1, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
      const state = makeState({ board, units: [mover, own] })

      const destinations = legalMoveDestinations(state, mover, mover.movement, TERRAIN_LEVELS)

      expect(hasCoord(destinations, { q: 1, r: 0 })).toBe(false)
      expect(hasCoord(destinations, { q: 2, r: 0 })).toBe(false)
    })
  })

  it('canEndMoveOnUnitTypes allows landing on an allowed occupant while blockedByUnits still governs pass-through', () => {
    // Merchant: blockedByUnits 'none', canEndMoveOnUnitTypes ['city'] — can pass through and land on a City,
    // but a non-City occupant should still just be a legal-to-land-on-if-empty hex beyond it.
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [2, 0, 'plain'],
    ])
    const merchant = makeUnit('p1', 'merchant', { q: 0, r: 0 }, {
      isMobile: true,
      terrains: ['plain'],
      canCrossCliffs: false,
      moveDistance: 5,
      blockedByUnits: 'none',
      canEndMoveOnUnitTypes: ['city'],
    })
    const city = makeUnit('p2', 'city', { q: 1, r: 0 }, { isMobile: false, terrains: [], canCrossCliffs: false })
    const state = makeState({ board, units: [merchant, city] })

    const destinations = legalMoveDestinations(state, merchant, merchant.movement, TERRAIN_LEVELS)

    expect(hasCoord(destinations, { q: 1, r: 0 })).toBe(true)
    expect(hasCoord(destinations, { q: 2, r: 0 })).toBe(true)
  })

  it('does not allow landing on an occupied hex whose occupant kind is not in canEndMoveOnUnitTypes', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const merchant = makeUnit('p1', 'merchant', { q: 0, r: 0 }, {
      isMobile: true,
      terrains: ['plain'],
      canCrossCliffs: false,
      moveDistance: 5,
      blockedByUnits: 'none',
      canEndMoveOnUnitTypes: ['city'],
    })
    const nomad = makeUnit('p2', 'nomad', { q: 1, r: 0 }, { isMobile: true, terrains: ['plain'], canCrossCliffs: false })
    const state = makeState({ board, units: [merchant, nomad] })

    const destinations = legalMoveDestinations(state, merchant, merchant.movement, TERRAIN_LEVELS)

    expect(hasCoord(destinations, { q: 1, r: 0 })).toBe(false)
  })

  it("Ship ('unlimited' + water-only) reaches its entire connected water region and no further", () => {
    // A 5-hex water region in a line, then a plain hex that should block further spread,
    // plus a disconnected water hex (not adjacent) that should be unreachable.
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [2, 0, 'water'],
      [3, 0, 'water'],
      [4, 0, 'water'],
      [5, 0, 'plain'],
      [10, 10, 'water'],
    ])
    const ship = makeUnit('p1', 'ship', { q: 0, r: 0 }, {
      isMobile: true,
      terrains: ['water'],
      canCrossCliffs: false,
      moveDistance: 'unlimited',
      blockedByUnits: 'none',
    })
    const state = makeState({ board, units: [ship] })

    const destinations = legalMoveDestinations(state, ship, ship.movement, TERRAIN_LEVELS)

    expect(hasCoord(destinations, { q: 1, r: 0 })).toBe(true)
    expect(hasCoord(destinations, { q: 4, r: 0 })).toBe(true)
    expect(hasCoord(destinations, { q: 5, r: 0 })).toBe(false)
    expect(hasCoord(destinations, { q: 10, r: 10 })).toBe(false)
    expect(destinations).toHaveLength(4)
  })

  it('ships can cross hexes occupied by other players to reach hexes beyond, without landing on top of them', () => {
    const board = boardOf([
      [0, 0, 'water'],
      [1, 0, 'water'],
      [2, 0, 'water'],
    ])
    const ship = makeUnit('p1', 'ship', { q: 0, r: 0 }, {
      isMobile: true,
      terrains: ['water'],
      canCrossCliffs: false,
      moveDistance: 'unlimited',
      blockedByUnits: 'none',
    })
    const enemyShip = makeUnit('p2', 'ship', { q: 1, r: 0 }, {
      isMobile: true,
      terrains: ['water'],
      canCrossCliffs: false,
      moveDistance: 'unlimited',
      blockedByUnits: 'none',
    })
    const state = makeState({ board, units: [ship, enemyShip] })

    const destinations = legalMoveDestinations(state, ship, ship.movement, TERRAIN_LEVELS)

    expect(hasCoord(destinations, { q: 1, r: 0 })).toBe(false)
    expect(hasCoord(destinations, { q: 2, r: 0 })).toBe(true)
  })

  it('does not move onto a hex with no tile', () => {
    const board = boardOf([[0, 0, 'plain']])
    const unit = makeUnit('p1', 'nomad', { q: 0, r: 0 }, {
      isMobile: true,
      terrains: ['plain', 'forest', 'mountain'],
      canCrossCliffs: false,
      moveDistance: 1,
      blockedByUnits: 'all',
    })
    const state = makeState({ board, units: [unit] })

    expect(legalMoveDestinations(state, unit, unit.movement, TERRAIN_LEVELS)).toEqual([])
  })
})
