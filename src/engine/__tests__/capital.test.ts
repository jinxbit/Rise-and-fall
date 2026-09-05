import { describe, expect, it } from 'vitest'
import { resolveAchievementContent, resolveTaleContent, resolveUnitContent } from '../../content/resolveContent'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { cardIdFor, createPlayerCards } from '../cards'
import { isDeclineTriggered } from '../decline'
import { beginSelectCardsPhase } from '../round'
import { applyTaleAchievementModifiers, applyTaleModifiers } from '../tales'
import type { Coordinate, GameState, Player, Terrain, Unit, UnitMovement } from '../types'
import { coordKey } from '../types'
import type { TransformEffect, UnitContent } from '../unitContent'
import { EMPTY_UNIT_CONTENT } from '../unitContent'
import { applyUnitActionEffect, computeTradeGold, findAdjacentRhombusCluster } from '../unitActions'

// --- shared fixtures, same conventions as tales.test.ts ---

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
const cityMovement: UnitMovement = { isMobile: false, terrains: [], canCrossCliffs: false }

// A concrete 4-hex rhombus on the axial hex grid (see board.ts's HEX_DIRECTIONS):
// (0,0) and (1,-1) are the "spine" (adjacent to each other); (1,0) and
// (2,-1) are the two hexes adjacent to BOTH spine hexes (the "wings").
// (0,0)-(2,-1) are NOT adjacent — the rhombus's long diagonal.
const RHOMBUS: Coordinate[] = [
  { q: 0, r: 0 },
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 2, r: -1 },
]

function rhombusBoard(): ReturnType<typeof boardOf> {
  return boardOf(RHOMBUS.map(({ q, r }) => [q, r, 'plain' as Terrain]))
}

// --- Group 1: findAdjacentRhombusCluster geometry ---

describe('findAdjacentRhombusCluster', () => {
  it('finds the rhombus starting from a spine hex', () => {
    const cities = RHOMBUS.map((coord) => makeUnit('p1', 'city', coord, cityMovement))
    const state = makeState({ board: rhombusBoard(), units: cities })

    const cluster = findAdjacentRhombusCluster(state, 'p1', RHOMBUS[0], 'city')

    expect(cluster).not.toBeNull()
    const found = new Set([RHOMBUS[0], ...(cluster ?? [])].map(coordKey))
    expect(found).toEqual(new Set(RHOMBUS.map(coordKey)))
  })

  it('finds the rhombus starting from a wing hex', () => {
    const cities = RHOMBUS.map((coord) => makeUnit('p1', 'city', coord, cityMovement))
    const state = makeState({ board: rhombusBoard(), units: cities })

    // RHOMBUS[1] = (1,0) is a wing, not a spine hex.
    const cluster = findAdjacentRhombusCluster(state, 'p1', RHOMBUS[1], 'city')

    expect(cluster).not.toBeNull()
    const found = new Set([RHOMBUS[1], ...(cluster ?? [])].map(coordKey))
    expect(found).toEqual(new Set(RHOMBUS.map(coordKey)))
  })

  it('returns null with only 3 of the 4 cities present', () => {
    const cities = RHOMBUS.slice(0, 3).map((coord) => makeUnit('p1', 'city', coord, cityMovement))
    const state = makeState({ board: rhombusBoard(), units: cities })

    expect(findAdjacentRhombusCluster(state, 'p1', RHOMBUS[0], 'city')).toBeNull()
  })

  it('returns null for 4 Cities in a straight line (not a rhombus)', () => {
    const line: Coordinate[] = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }, { q: 3, r: 0 }]
    const board = boardOf(line.map(({ q, r }) => [q, r, 'plain' as Terrain]))
    const cities = line.map((coord) => makeUnit('p1', 'city', coord, cityMovement))
    const state = makeState({ board, units: cities })

    expect(findAdjacentRhombusCluster(state, 'p1', line[0], 'city')).toBeNull()
  })

  it("ignores an opposing player's Cities — the whole rhombus must be one player's", () => {
    const cities = RHOMBUS.map((coord, i) => makeUnit(i === 3 ? 'p2' : 'p1', 'city', coord, cityMovement))
    const state = makeState({ board: rhombusBoard(), units: cities })

    expect(findAdjacentRhombusCluster(state, 'p1', RHOMBUS[0], 'city')).toBeNull()
  })

  it('ignores a cluster-mate City that already resolved an action this turn', () => {
    const cities = RHOMBUS.map((coord) => makeUnit('p1', 'city', coord, cityMovement))
    // RHOMBUS[1] is one of the 3 cluster mates for RHOMBUS[0] — already
    // spent its action this turn, so it can no longer count towards the
    // Capital merge, same as if it weren't there at all.
    const state = makeState({ board: rhombusBoard(), units: cities, resolvedUnitIdsThisTurn: [cities[1].id] })

    expect(findAdjacentRhombusCluster(state, 'p1', RHOMBUS[0], 'city')).toBeNull()
  })
})

// --- Group 2: resolveTaleContent + applyTaleModifiers against real content/tales.json ---

describe('resolveTaleContent + applyTaleModifiers — The Capital, against real content/tales.json + units.json', () => {
  it('merges Capital as a City companion, reusing City\'s own action list, activating twice per turn', () => {
    const base = resolveUnitContent(2)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-capital'], 2))

    expect(merged.companionKindsByCardKind.city).toEqual(['capital'])
    expect(merged.unitSupplyCaps.capital).toBe(1)
    expect(merged.activationsPerTurnByKind.capital).toBe(2)
    expect(merged.actionsByKind.capital?.map((a) => a.id).sort()).toEqual(merged.actionsByKind.city.map((a) => a.id).sort())
    expect(merged.actionsByKind.capital?.map((a) => a.id)).toContain('construct-capital')
  })

  it("appends construct-capital onto City's own action list, without dropping the base game's own actions", () => {
    const base = resolveUnitContent(2)
    const merged = applyTaleModifiers(base, resolveTaleContent(['the-capital'], 2))

    const cityActionIds = merged.actionsByKind.city.map((a) => a.id)
    expect(cityActionIds).toContain('construct-capital')
    expect(cityActionIds).toContain('create-nomad') // base action still present
  })

  it('applyTaleAchievementModifiers merges a real 20 VP Capital Trophy tied to full Capital supply (1)', () => {
    const base = resolveAchievementContent()
    const taleContent = resolveTaleContent(['the-capital'], 2)
    const merged = applyTaleAchievementModifiers(base, taleContent)

    expect(merged.unitKindByAchievementId.capital).toBe('capital')
    expect(merged.achievementVictoryPoints.capital).toBe(20)
  })
})

// --- Group 3: the cluster-consuming transform effect in isolation ---

describe("transform effect's requiredAdjacentRhombusOfKind (City: Construct the Capital)", () => {
  const content: UnitContent = {
    ...EMPTY_UNIT_CONTENT,
    movementByKind: { capital: cityMovement },
    terrainLevels: TERRAIN_LEVELS,
    resourceCaps: { gold: null, wood: 5, stone: 5 },
    unitSupplyCaps: { capital: 1 },
  }
  const action = {
    id: 'construct-capital',
    name: 'Construct the Capital',
    description: '',
    effect: {
      actionType: 'transform' as const,
      targetUnit: 'capital',
      targetHex: { terrainType: ['plain', 'forest', 'mountain'], location: 'self' as const },
      destroySelf: true,
      cost: {},
      requiredAdjacentRhombusOfKind: 'city',
      forbiddenIfBoardHasKind: 'capital',
    } satisfies TransformEffect,
  }

  it('removes all 4 Cities and places the Capital on the acting City\'s own hex', () => {
    const cities = RHOMBUS.map((coord) => makeUnit('p1', 'city', coord, cityMovement))
    const state = makeState({ board: rhombusBoard(), units: cities })

    const next = applyUnitActionEffect(state, 'p1', 'city', action, {}, content, [cities[0].id])

    expect(next.units.filter((u) => u.kind === 'city')).toHaveLength(0)
    const capital = next.units.find((u) => u.kind === 'capital')
    expect(capital).toBeDefined()
    expect(coordKey(capital!.coord)).toBe(coordKey(cities[0].coord))
  })

  it('is rejected without a full 4-City rhombus', () => {
    const cities = RHOMBUS.slice(0, 3).map((coord) => makeUnit('p1', 'city', coord, cityMovement))
    const state = makeState({ board: rhombusBoard(), units: cities })

    const next = applyUnitActionEffect(state, 'p1', 'city', action, {}, content, [cities[0].id])

    expect(next).toBe(state)
  })

  it('is rejected once a Capital already exists anywhere in the World', () => {
    const cities = RHOMBUS.map((coord) => makeUnit('p1', 'city', coord, cityMovement))
    const existingCapital = makeUnit('p2', 'capital', { q: 10, r: 10 }, cityMovement)
    const board = boardOf([...RHOMBUS.map(({ q, r }): [number, number, Terrain] => [q, r, 'plain']), [10, 10, 'plain']])
    const state = makeState({ board, units: [...cities, existingCapital] })

    const next = applyUnitActionEffect(state, 'p1', 'city', action, {}, content, [cities[0].id])

    expect(next).toBe(state)
  })

  it('is rejected when one of the 3 replaced cluster-mate Cities already resolved an action this turn', () => {
    const cities = RHOMBUS.map((coord) => makeUnit('p1', 'city', coord, cityMovement))
    // cities[1] is a cluster mate (not the acting City) that already took
    // its own action earlier this turn — the merge can no longer consume it.
    const state = makeState({ board: rhombusBoard(), units: cities, resolvedUnitIdsThisTurn: [cities[1].id] })

    const next = applyUnitActionEffect(state, 'p1', 'city', action, {}, content, [cities[0].id])

    expect(next).toBe(state)
  })
})

// --- Group 4: end-to-end through applyAction — double activation, Trophy claim, decline trigger ---

describe('The Capital, end-to-end through applyAction', () => {
  function realContent() {
    const unitContent = applyTaleModifiers(resolveUnitContent(2), resolveTaleContent(['the-capital'], 2))
    const achievementContent = applyTaleAchievementModifiers(resolveAchievementContent(1), resolveTaleContent(['the-capital'], 2))
    return { unitContent, achievementContent }
  }

  function makeGameWithCapital(): GameState {
    const { unitContent } = realContent()
    const p1Cards = createPlayerCards('p1')
    const p2Cards = createPlayerCards('p2')
    const cards = [...p1Cards, ...p2Cards].reduce((acc, c) => ({ ...acc, [c.id]: c }), {} as GameState['cards'])
    const capital = makeUnit('p1', 'capital', { q: 0, r: 0 }, unitContent.movementByKind.capital)
    const board = boardOf([[0, 0, 'plain']])

    let state = makeState({
      board,
      units: [capital],
      cards,
      players: [
        makePlayer('p1', { handCardIds: [cardIdFor('p1', 'city')], resources: { gold: 0, wood: 5, stone: 5 } }),
        makePlayer('p2', { handCardIds: [cardIdFor('p2', 'nomad')] }),
      ],
      turnOrder: ['p1', 'p2'],
      roundPhase: 'selectCards',
    })
    state = beginSelectCardsPhase(state)
    return state
  }

  function chooseCards(state: GameState): GameState {
    const { unitContent } = realContent()
    // Both hands are a single card ('city'/'nomad') — p1's own CHOOSE_CARD
    // already folds p2's forced pick into the same applyAction() call
    // (RULE_ENFORCEMENT_PLAN.md §4.2/§4.3), so no separate submission for
    // p2 is needed (or possible — p2 is no longer pending afterward).
    const p1Choice = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, unitContent)
    if (!p1Choice.ok) throw new Error('p1 setup failed')
    return p1Choice.state
  }

  it('activates the Capital twice off the City card, with a 3rd activation rejected', () => {
    const { unitContent, achievementContent } = realContent()
    const state = chooseCards(makeGameWithCapital())
    const capital = state.units.find((u) => u.kind === 'capital')!

    const first = applyAction(
      state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: capital.id, actionId: 'generate-income' }] },
      unitContent,
      achievementContent,
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.state.roundPhase).toBe('actions') // Capital's 2nd activation still pending — p1's turn stays open

    const second = applyAction(
      first.state,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: capital.id, actionId: 'generate-income' }] },
      unitContent,
      achievementContent,
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.state.pendingPlayerIds).not.toContain('p1') // both activations spent — p1's turn ended

    // A state that already recorded 2 resolutions this turn (simulated here,
    // since the 2nd real activation above already ended the turn and reset
    // this list for p2) rejects a 3rd activation outright.
    const overActivated = { ...first.state, resolvedUnitIdsThisTurn: [...first.state.resolvedUnitIdsThisTurn, capital.id] }
    const rejected = applyAction(
      overActivated,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: capital.id, actionId: 'generate-income' }] },
      unitContent,
      achievementContent,
    )
    expect(rejected.ok).toBe(false)
  })

  it('claiming the Capital Trophy (via full Capital supply) triggers a real Decline phase', () => {
    const { unitContent, achievementContent } = realContent()
    const cities = RHOMBUS.map((coord) => makeUnit('p1', 'city', coord, unitContent.movementByKind.city))
    const p1Cards = createPlayerCards('p1')
    const p2Cards = createPlayerCards('p2')
    const cards = [...p1Cards, ...p2Cards].reduce((acc, c) => ({ ...acc, [c.id]: c }), {} as GameState['cards'])

    let state = makeState({
      board: rhombusBoard(),
      units: cities,
      cards,
      players: [
        makePlayer('p1', { handCardIds: [cardIdFor('p1', 'city')], resources: { gold: 0, wood: 5, stone: 5 } }),
        makePlayer('p2', { handCardIds: [cardIdFor('p2', 'nomad')] }),
      ],
      turnOrder: ['p1', 'p2'],
      roundPhase: 'selectCards',
    })
    state = beginSelectCardsPhase(state)
    const chosen = chooseCards(state)

    const acting = chosen.units.find((u) => u.kind === 'city')!
    const result = applyAction(
      chosen,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: acting.id, actionId: 'construct-capital' }] },
      unitContent,
      achievementContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.claimedByAchievementId.capital).toBe('p1')
    expect(isDeclineTriggered(result.state)).toBe(true)
  })

  it('counts the Capital as a City for card zone sync — the City card stays in hand even with 0 plain Cities left', () => {
    const { unitContent, achievementContent } = realContent()
    const cities = RHOMBUS.map((coord) => makeUnit('p1', 'city', coord, unitContent.movementByKind.city))
    const p1Cards = createPlayerCards('p1')
    const p2Cards = createPlayerCards('p2')
    const cards = [...p1Cards, ...p2Cards].reduce((acc, c) => ({ ...acc, [c.id]: c }), {} as GameState['cards'])

    let state = makeState({
      board: rhombusBoard(),
      units: cities,
      cards,
      players: [
        makePlayer('p1', { handCardIds: [cardIdFor('p1', 'city')], resources: { gold: 0, wood: 5, stone: 5 } }),
        makePlayer('p2', { handCardIds: [cardIdFor('p2', 'nomad')] }),
      ],
      turnOrder: ['p1', 'p2'],
      roundPhase: 'selectCards',
    })
    state = beginSelectCardsPhase(state)
    const chosen = chooseCards(state)

    const acting = chosen.units.find((u) => u.kind === 'city')!
    const result = applyAction(
      chosen,
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: acting.id, actionId: 'construct-capital' }] },
      unitContent,
      achievementContent,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.units.some((u) => u.ownerId === 'p1' && u.kind === 'city')).toBe(false)
    // The City card was played this turn (now in `discard`, per rules 3 & 4
    // — see finishActionsTurn) rather than `hand`, but the point still
    // holds: it must NOT have been forced into `supply` just because the 4
    // plain Cities that built the Capital are gone — the Capital counts as
    // a City.
    const p1 = result.state.players.find((p) => p.id === 'p1')!
    expect(p1.discardCardIds).toContain(cardIdFor('p1', 'city'))
    expect(p1.supplyCardIds).not.toContain(cardIdFor('p1', 'city'))
  })
})

// --- Group 5: Capital counts as a City for Ship's Trade (per rule text) ---

describe("Ship's Trade counts the Capital as a normal City", () => {
  it('pays goldPerCity for a Capital adjacent to the connected Sea area', () => {
    const board = boardOf([[0, 0, 'water'], [1, 0, 'plain']])
    const ship = makeUnit('p2', 'ship', { q: 0, r: 0 }, { isMobile: true, terrains: ['water'], canCrossCliffs: false })
    const capital = makeUnit('p1', 'capital', { q: 1, r: 0 }, cityMovement)
    const state = makeState({ board, units: [ship, capital] })

    expect(computeTradeGold(state, ship, { actionType: 'trade', goldPerCity: 4 })).toBe(4)
  })
})
