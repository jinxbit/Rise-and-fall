// Validates unitContent.ts's types against the ACTUAL content/*.json files
// (not just hand-built fixtures) and exercises a few representative real
// actions end to end. Catches any drift between the engine's UnitAction
// effect types and the real JSON shape.
import { describe, expect, it } from 'vitest'
import { createEmptyBoard, setTile } from '../board'
import { legalMoveDestinations } from '../movement'
import { applyUnitActionEffect } from '../unitActions'
import type { UnitAction, UnitContent } from '../unitContent'
import type { GameState, Player, Resources, Unit, UnitMovement } from '../types'
import unitsJson from '../../content/units.json'
import terrainJson from '../../content/terrain.json'
import resourcesJson from '../../content/resources.json'

function buildUnitContent(): UnitContent {
  const actionsByKind: Record<string, UnitAction[]> = {}
  const movementByKind: Record<string, UnitMovement> = {}
  const unitSupplyCaps: Record<string, number> = {}

  for (const unit of unitsJson.units) {
    actionsByKind[unit.id] = unit.actions as unknown as UnitAction[]
    movementByKind[unit.id] = {
      isMobile: unit.movement.isMobile,
      terrains: unit.movement.terrains as UnitMovement['terrains'],
      canCrossCliffs: unit.movement.canCrossCliffs,
      moveDistance: unit.movement.moveDistance as UnitMovement['moveDistance'],
      blockedByUnits: unit.movement.blockedByUnits as UnitMovement['blockedByUnits'],
      canEndMoveOnUnitTypes: unit.movement.canEndMoveOnUnitTypes,
    }
    unitSupplyCaps[unit.id] = unit.supply.byPlayerCount['2']
  }

  const terrainLevels: Record<string, number> = {}
  for (const terrain of terrainJson.terrainTypes) {
    terrainLevels[terrain.id] = terrain.level
  }

  const resourceCaps: Partial<Record<keyof Resources, number | null>> = {}
  for (const resource of resourcesJson.resources) {
    resourceCaps[resource.id as keyof Resources] = resource.playerCap
  }

  return { actionsByKind, movementByKind, terrainLevels, resourceCaps, unitSupplyCaps }
}

function makePlayer(id: string, resources: Resources = { gold: 0, wood: 0, stone: 0 }): Player {
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
    resources,
  }
}

function findAction(kind: string, actionId: string, content: UnitContent): UnitAction {
  const action = content.actionsByKind[kind]?.find((a) => a.id === actionId)
  if (!action) throw new Error(`fixture error: no action ${actionId} for ${kind}`)
  return action
}

describe('real content/units.json + terrain.json + resources.json', () => {
  const content = buildUnitContent()

  it('every unit action effect matches a known actionType (parses cleanly against UnitActionEffect)', () => {
    const seenTypes = new Set<string>()
    for (const actions of Object.values(content.actionsByKind)) {
      for (const action of actions) {
        seenTypes.add(action.effect.actionType)
      }
    }
    expect([...seenTypes].sort()).toEqual(['convert', 'create', 'income', 'move', 'produce', 'trade', 'trade-resource', 'transform'])
  })

  // Bug report: "Merchant shouldn't be able to walk on water" — confirmed
  // against the real content, not just a synthetic movement profile that
  // could drift from it.
  it("Merchant's real movement profile excludes Water, but still includes Plain/Forest/Mountain", () => {
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 1, r: 0 }, 'water')
    const merchant: Unit = { id: 'u1', ownerId: 'p1', kind: 'merchant', coord: { q: 0, r: 0 }, movement: content.movementByKind.merchant, traits: [] }
    const state: GameState = {
      gameId: 'g',
      playMode: 'hotseat',
      status: 'active',
      turn: 1,
      activePlayerId: null,
      roundPhase: 'actions',
      chosenCardIdByPlayerId: {},
      pendingPlayerIds: [],
      resolvedUnitIdsThisTurn: [],
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1')],
      units: [merchant],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
      actionHistory: [],
    }

    expect(content.movementByKind.merchant.terrains).toEqual(['plain', 'forest', 'mountain'])

    const destinations = legalMoveDestinations(state, merchant, merchant.movement, content.terrainLevels)
    expect(destinations.some((c) => c.q === 1 && c.r === 0)).toBe(false)
  })

  it("City's Generate Income pays out per the real goldByTerrain table", () => {
    const board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'forest')
    const state: GameState = {
      gameId: 'g',
      playMode: 'hotseat',
      status: 'active',
      turn: 1,
      activePlayerId: null,
      roundPhase: 'actions',
      chosenCardIdByPlayerId: {},
      pendingPlayerIds: [],
      resolvedUnitIdsThisTurn: [],
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1')],
      units: [{ id: 'u1', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
      actionHistory: [],
    }

    const action = findAction('city', 'generate-income', content)
    const next = applyUnitActionEffect(state, 'p1', 'city', action, {}, content)

    expect(next.players[0].resources.gold).toBe(3) // Forest: 3 gold per units.json
  })

  it("Nomad's Transform to City real cost/terrain gate resolves correctly", () => {
    const board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain')
    const nomad: Unit = { id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const state: GameState = {
      gameId: 'g',
      playMode: 'hotseat',
      status: 'active',
      turn: 1,
      activePlayerId: null,
      roundPhase: 'actions',
      chosenCardIdByPlayerId: {},
      pendingPlayerIds: [],
      resolvedUnitIdsThisTurn: [],
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1', { gold: 0, wood: 1, stone: 1 })],
      units: [nomad],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
      actionHistory: [],
    }

    const action = findAction('nomad', 'transform-to-city', content)
    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, content)

    expect(next.units).toHaveLength(1)
    expect(next.units[0].kind).toBe('city')
    expect(next.players[0].resources).toEqual({ gold: 0, wood: 0, stone: 0 })
  })

  it("Nomad's Transform to Temple (real cost: 2 stone) is a true no-op when unaffordable — same state reference back, no Temple created", () => {
    // Reproduces the reported shape exactly: a fresh round-1 Nomad, with the
    // real starting 0/0/0 resources, attempting the real Transform to
    // Temple action (content/units.json: cost 2 stone). applyResolveUnitAction
    // (./applyAction.ts) relies on this reference-equality no-op to reject
    // the whole RESOLVE_UNIT_ACTION rather than silently accepting it.
    const board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain')
    const nomad: Unit = { id: 'u1', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const state: GameState = {
      gameId: 'g',
      playMode: 'hotseat',
      status: 'active',
      turn: 1,
      activePlayerId: null,
      roundPhase: 'actions',
      chosenCardIdByPlayerId: {},
      pendingPlayerIds: [],
      resolvedUnitIdsThisTurn: [],
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1', { gold: 0, wood: 0, stone: 0 })],
      units: [nomad],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
      actionHistory: [],
    }

    const action = findAction('nomad', 'transform-to-temple', content)
    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, content, ['u1'])

    expect(next).toBe(state)
    expect(next.units).toHaveLength(1)
    expect(next.units[0].kind).toBe('nomad')
  })

  it("City's Convert to Merchant (real cost: 2 gold) upgrades an adjacent own Nomad in place, rather than creating one from nothing", () => {
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 1, r: 0 }, 'plain')
    const city: Unit = { id: 'city1', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const nomad: Unit = { id: 'nomad1', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const state: GameState = {
      gameId: 'g',
      playMode: 'hotseat',
      status: 'active',
      turn: 1,
      activePlayerId: null,
      roundPhase: 'actions',
      chosenCardIdByPlayerId: {},
      pendingPlayerIds: [],
      resolvedUnitIdsThisTurn: [],
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1', { gold: 2, wood: 0, stone: 0 })],
      units: [city, nomad],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
      actionHistory: [],
    }

    const action = findAction('city', 'create-merchant', content)
    const next = applyUnitActionEffect(state, 'p1', 'city', action, { [city.id]: nomad.coord }, content, [city.id])

    // No new unit appeared — the Nomad itself became the Merchant.
    expect(next.units).toHaveLength(2)
    expect(next.units.find((u) => u.id === city.id)?.kind).toBe('city')
    expect(next.units.find((u) => u.id === nomad.id)?.kind).toBe('merchant')
    expect(next.players[0].resources.gold).toBe(0)
  })

  it("Ship's Transform to Nomad (0 cost, real 'plain' terrainType) resolves onto an adjacent hex", () => {
    const board = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'water'), { q: 1, r: 0 }, 'plain')
    const ship: Unit = { id: 'u1', ownerId: 'p1', kind: 'ship', coord: { q: 0, r: 0 }, movement: content.movementByKind.ship, traits: [] }
    const state: GameState = {
      gameId: 'g',
      playMode: 'hotseat',
      status: 'active',
      turn: 1,
      activePlayerId: null,
      roundPhase: 'actions',
      chosenCardIdByPlayerId: {},
      pendingPlayerIds: [],
      resolvedUnitIdsThisTurn: [],
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1')],
      units: [ship],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
      actionHistory: [],
    }

    const action = findAction('ship', 'transform-to-nomad', content)
    const next = applyUnitActionEffect(state, 'p1', 'ship', action, { [ship.id]: { q: 1, r: 0 } }, content)

    expect(next.units).toHaveLength(1)
    expect(next.units[0]).toMatchObject({ kind: 'nomad', coord: { q: 1, r: 0 } })
  })

  it("Ship's Move (real moveDistance: 'unlimited', blockedByUnits: 'none') can reach across its water region but not onto a non-water hex", () => {
    let board = createEmptyBoard('hex')
    for (const [q, r] of [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]) {
      board = setTile(board, { q, r }, 'water')
    }
    board = setTile(board, { q: 4, r: 0 }, 'plain')

    const ship: Unit = { id: 'u1', ownerId: 'p1', kind: 'ship', coord: { q: 0, r: 0 }, movement: content.movementByKind.ship, traits: [] }
    const state: GameState = {
      gameId: 'g',
      playMode: 'hotseat',
      status: 'active',
      turn: 1,
      activePlayerId: null,
      roundPhase: 'actions',
      chosenCardIdByPlayerId: {},
      pendingPlayerIds: [],
      resolvedUnitIdsThisTurn: [],
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1')],
      units: [ship],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
      actionHistory: [],
    }

    const action = findAction('ship', 'move', content)

    const toFarWater = applyUnitActionEffect(state, 'p1', 'ship', action, { [ship.id]: { q: 3, r: 0 } }, content)
    expect(toFarWater.units[0].coord).toEqual({ q: 3, r: 0 })

    const toPlain = applyUnitActionEffect(state, 'p1', 'ship', action, { [ship.id]: { q: 4, r: 0 } }, content)
    expect(toPlain.units[0].coord).toEqual({ q: 0, r: 0 })
  })

  it("Mountaineer cannot move onto Water (bug report: Mountaineers aren't allowed on Water)", () => {
    let board = createEmptyBoard('hex')
    board = setTile(board, { q: 0, r: 0 }, 'mountain')
    board = setTile(board, { q: 1, r: 0 }, 'water')
    board = setTile(board, { q: -1, r: 0 }, 'forest')

    const mountaineer: Unit = { id: 'u1', ownerId: 'p1', kind: 'mountaineer', coord: { q: 0, r: 0 }, movement: content.movementByKind.mountaineer, traits: [] }
    const state: GameState = {
      gameId: 'g',
      playMode: 'hotseat',
      status: 'active',
      turn: 1,
      activePlayerId: null,
      roundPhase: 'actions',
      chosenCardIdByPlayerId: {},
      pendingPlayerIds: [],
      resolvedUnitIdsThisTurn: [],
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1')],
      units: [mountaineer],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
      actionHistory: [],
    }

    const action = findAction('mountaineer', 'move', content)

    const toWater = applyUnitActionEffect(state, 'p1', 'mountaineer', action, { [mountaineer.id]: { q: 1, r: 0 } }, content)
    expect(toWater.units[0].coord).toEqual({ q: 0, r: 0 }) // rejected, stayed put

    const toForest = applyUnitActionEffect(state, 'p1', 'mountaineer', action, { [mountaineer.id]: { q: -1, r: 0 } }, content)
    expect(toForest.units[0].coord).toEqual({ q: -1, r: 0 }) // every other terrain still works
  })

  it("Temple's Convert Enemy Unit charges the real per-target-kind gold cost (2 Nomad, 3 Mountaineer, 5 Merchant/Ship)", () => {
    // Temple at (0,0), one enemy on each of 4 of its 6 neighboring hexes —
    // all genuinely adjacent, unlike a straight line out from the temple.
    let board = createEmptyBoard('hex')
    for (const [q, r] of [[0, 0], [1, 0], [1, -1], [0, -1], [-1, 0]] as const) board = setTile(board, { q, r }, 'plain')
    const temple: Unit = { id: 'temple', ownerId: 'p1', kind: 'temple', coord: { q: 0, r: 0 }, movement: content.movementByKind.temple, traits: [] }
    const enemyUnit = (kind: string, coord: { q: number; r: number }): Unit => ({
      id: `enemy_${kind}`,
      ownerId: 'p2',
      kind,
      coord,
      movement: content.movementByKind[kind],
      traits: [],
    })
    const enemies = [
      enemyUnit('nomad', { q: 1, r: 0 }),
      enemyUnit('mountaineer', { q: 1, r: -1 }),
      enemyUnit('merchant', { q: 0, r: -1 }),
      enemyUnit('ship', { q: -1, r: 0 }),
    ]

    const state: GameState = {
      gameId: 'g',
      playMode: 'hotseat',
      status: 'active',
      turn: 1,
      activePlayerId: null,
      roundPhase: 'actions',
      chosenCardIdByPlayerId: {},
      pendingPlayerIds: [],
      resolvedUnitIdsThisTurn: [],
      turnOrder: ['p1', 'p2'],
      board,
      players: [makePlayer('p1', { gold: 3, wood: 0, stone: 0 }), makePlayer('p2')],
      units: [temple, ...enemies],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
      actionHistory: [],
    }

    const action = findAction('temple', 'convert-enemy-unit', content)

    // 3 gold: too little for the Mountaineer (3 leaves 0, but let's confirm
    // the exact charge instead) — spend it converting the Nomad (costs 2).
    const afterNomad = applyUnitActionEffect(state, 'p1', 'temple', action, { [temple.id]: { q: 1, r: 0 } }, content)
    expect(afterNomad.units.find((u) => u.id === 'enemy_nomad')!.ownerId).toBe('p1')
    expect(afterNomad.players.find((p) => p.id === 'p1')!.resources.gold).toBe(1)

    // Not enough gold left (1) for the Mountaineer (costs 3) — rejected.
    const afterMountaineerAttempt = applyUnitActionEffect(afterNomad, 'p1', 'temple', action, { [temple.id]: { q: 1, r: -1 } }, content)
    expect(afterMountaineerAttempt.units.find((u) => u.id === 'enemy_mountaineer')!.ownerId).toBe('p2')
    expect(afterMountaineerAttempt.players.find((p) => p.id === 'p1')!.resources.gold).toBe(1)

    // Fully funded: Mountaineer costs 3, Merchant/Ship cost 5 each.
    const funded = { ...state, players: [makePlayer('p1', { gold: 3 + 5 + 5, wood: 0, stone: 0 }), makePlayer('p2')] }
    const afterMountaineer = applyUnitActionEffect(funded, 'p1', 'temple', action, { [temple.id]: { q: 1, r: -1 } }, content)
    expect(afterMountaineer.units.find((u) => u.id === 'enemy_mountaineer')!.ownerId).toBe('p1')
    expect(afterMountaineer.players.find((p) => p.id === 'p1')!.resources.gold).toBe(10)

    const afterMerchant = applyUnitActionEffect(afterMountaineer, 'p1', 'temple', action, { [temple.id]: { q: 0, r: -1 } }, content)
    expect(afterMerchant.units.find((u) => u.id === 'enemy_merchant')!.ownerId).toBe('p1')
    expect(afterMerchant.players.find((p) => p.id === 'p1')!.resources.gold).toBe(5)

    const afterShip = applyUnitActionEffect(afterMerchant, 'p1', 'temple', action, { [temple.id]: { q: -1, r: 0 } }, content)
    expect(afterShip.units.find((u) => u.id === 'enemy_ship')!.ownerId).toBe('p1')
    expect(afterShip.players.find((p) => p.id === 'p1')!.resources.gold).toBe(0)
  })
})
