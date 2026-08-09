// Validates unitContent.ts's types against the ACTUAL content/*.json files
// (not just hand-built fixtures) and exercises a few representative real
// actions end to end. Catches any drift between the engine's UnitAction
// effect types and the real JSON shape.
import { describe, expect, it } from 'vitest'
import { createEmptyBoard, setTile } from '../board'
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
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1')],
      units: [{ id: 'u1', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      unitLimits: {},
      log: [],
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
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
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1', { gold: 0, wood: 1, stone: 1 })],
      units: [nomad],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      unitLimits: {},
      log: [],
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
    }

    const action = findAction('nomad', 'transform-to-city', content)
    const next = applyUnitActionEffect(state, 'p1', 'nomad', action, {}, content)

    expect(next.units).toHaveLength(1)
    expect(next.units[0].kind).toBe('city')
    expect(next.players[0].resources).toEqual({ gold: 0, wood: 0, stone: 0 })
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
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1')],
      units: [ship],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      unitLimits: {},
      log: [],
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
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
      turnOrder: ['p1'],
      board,
      players: [makePlayer('p1')],
      units: [ship],
      cards: {},
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
      unitLimits: {},
      log: [],
      winnerPlayerIds: [],
      claimedByAchievementId: {},
      achievementsClaimedThisRound: 0,
      boardSetup: null,
      idSequence: 0,
    }

    const action = findAction('ship', 'move', content)

    const toFarWater = applyUnitActionEffect(state, 'p1', 'ship', action, { [ship.id]: { q: 3, r: 0 } }, content)
    expect(toFarWater.units[0].coord).toEqual({ q: 3, r: 0 })

    const toPlain = applyUnitActionEffect(state, 'p1', 'ship', action, { [ship.id]: { q: 4, r: 0 } }, content)
    expect(toPlain.units[0].coord).toEqual({ q: 0, r: 0 })
  })
})
