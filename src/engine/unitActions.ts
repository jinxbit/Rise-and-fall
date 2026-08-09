import { getTile, neighborCoords } from './board'
import { syncCardZonesWithBoard } from './cards'
import { isCliffBetweenTerrains } from './cliffs'
import { gainResource, spendResource } from './resources'
import type {
  ActionCost,
  ConvertEffect,
  CreateEffect,
  IncomeEffect,
  ProduceEffect,
  TradeEffect,
  TradeResourceEffect,
  TransformEffect,
  UnitAction,
  UnitContent,
} from './unitContent'
import type { Coordinate, GameState, Resources, Unit } from './types'
import { coordKey } from './types'

// --- board/adjacency helpers -----------------------------------------------

function unitsAt(state: GameState, coord: Coordinate): Unit[] {
  const key = coordKey(coord)
  return state.units.filter((u) => coordKey(u.coord) === key)
}

function isAdjacent(state: GameState, a: Coordinate, b: Coordinate): boolean {
  const key = coordKey(b)
  return neighborCoords(state.board, a).some((c) => coordKey(c) === key)
}

function adjacentUnits(state: GameState, coord: Coordinate): Unit[] {
  const neighborKeys = new Set(neighborCoords(state.board, coord).map(coordKey))
  return state.units.filter((u) => neighborKeys.has(coordKey(u.coord)))
}

function crossesCliff(state: GameState, from: Coordinate, to: Coordinate, terrainLevels: Record<string, number>): boolean {
  const fromTile = getTile(state.board, from)
  const toTile = getTile(state.board, to)
  if (!fromTile || !toTile) return false
  return isCliffBetweenTerrains(fromTile.terrain, toTile.terrain, terrainLevels)
}

// --- resource helpers --------------------------------------------------------

function updatePlayerResources(state: GameState, playerId: string, resources: Resources, bank: Resources): GameState {
  const playerIndex = state.players.findIndex((p) => p.id === playerId)
  if (playerIndex === -1) return state
  const players = [...state.players]
  players[playerIndex] = { ...players[playerIndex], resources }
  return { ...state, players, resourceBank: bank }
}

function creditResource(
  state: GameState,
  playerId: string,
  resourceId: keyof Resources,
  amount: number,
  resourceCaps: Partial<Record<keyof Resources, number | null>>,
): GameState {
  if (amount <= 0) return state
  const player = state.players.find((p) => p.id === playerId)
  if (!player) return state
  const cap = resourceCaps[resourceId] ?? null
  const { resources, bank } = gainResource(player.resources, state.resourceBank, resourceId, amount, cap)
  return updatePlayerResources(state, playerId, resources, bank)
}

/** Attempts to pay a full cost (gold/wood/stone) atomically; null if the player can't afford any part of it. */
function tryPayCost(state: GameState, playerId: string, cost: ActionCost): GameState | null {
  const player = state.players.find((p) => p.id === playerId)
  if (!player) return null

  let resources = player.resources
  let bank = state.resourceBank
  for (const key of ['gold', 'wood', 'stone'] as const) {
    const amount = cost[key] ?? 0
    if (amount <= 0) continue
    const result = spendResource(resources, bank, key, amount)
    if (!result) return null
    resources = result.resources
    bank = result.bank
  }
  return updatePlayerResources(state, playerId, resources, bank)
}

function hasReachedSupplyCap(state: GameState, playerId: string, kind: string, unitSupplyCaps: Record<string, number>): boolean {
  const cap = unitSupplyCaps[kind]
  if (cap === undefined) return false
  const count = state.units.filter((u) => u.ownerId === playerId && u.kind === kind).length
  return count >= cap
}

let createdUnitCounter = 0
function nextCreatedUnitId(): string {
  createdUnitCounter += 1
  return `created_unit_${createdUnitCounter}`
}

// --- per-actionType handlers, one acting unit at a time ---------------------

function applyIncome(
  state: GameState,
  playerId: string,
  unit: Unit,
  effect: IncomeEffect,
  resourceCaps: Partial<Record<keyof Resources, number | null>>,
): GameState {
  let gold = 0

  if (effect.goldByTerrain) {
    const tile = getTile(state.board, unit.coord)
    if (tile) gold += effect.goldByTerrain[tile.terrain] ?? 0
  }

  if (effect.goldPerAdjacentOwnUnit !== undefined) {
    const exclude = new Set(effect.excludeUnitTypes ?? [])
    const count = adjacentUnits(state, unit.coord).filter((u) => u.ownerId === playerId && !exclude.has(u.kind)).length
    gold += count * effect.goldPerAdjacentOwnUnit
  }

  if (effect.goldPerAdjacentUnit) {
    for (const neighbor of adjacentUnits(state, unit.coord)) {
      const table = neighbor.ownerId === playerId ? effect.goldPerAdjacentUnit.own : effect.goldPerAdjacentUnit.enemy
      gold += table?.[neighbor.kind] ?? 0
    }
  }

  return creditResource(state, playerId, 'gold', gold, resourceCaps)
}

function applyProduce(
  state: GameState,
  playerId: string,
  unit: Unit,
  effect: ProduceEffect,
  resourceCaps: Partial<Record<keyof Resources, number | null>>,
): GameState {
  const tile = getTile(state.board, unit.coord)
  if (!tile) return state
  const amounts = effect.resourceByTerrain[tile.terrain]
  if (!amounts) return state

  let nextState = state
  for (const key of ['gold', 'wood', 'stone'] as const) {
    const amount = amounts[key]
    if (amount) nextState = creditResource(nextState, playerId, key, amount, resourceCaps)
  }
  return nextState
}

/** Per ruling: no own/enemy split — goldPerCity per adjacent City regardless of owner. */
function applyTrade(
  state: GameState,
  playerId: string,
  unit: Unit,
  effect: TradeEffect,
  resourceCaps: Partial<Record<keyof Resources, number | null>>,
): GameState {
  const cityCount = adjacentUnits(state, unit.coord).filter((u) => u.kind === 'city').length
  return creditResource(state, playerId, 'gold', cityCount * effect.goldPerCity, resourceCaps)
}

/** Per ruling: creation can never cross a cliff, and always respects the target kind's supply cap. */
function applyCreate(state: GameState, playerId: string, unit: Unit, effect: CreateEffect, targetCoord: Coordinate | undefined, content: UnitContent): GameState {
  if (!targetCoord) return state
  if (!isAdjacent(state, unit.coord, targetCoord)) return state
  if (!getTile(state.board, targetCoord)) return state
  if (unitsAt(state, targetCoord).length > 0) return state
  if (crossesCliff(state, unit.coord, targetCoord, content.terrainLevels)) return state
  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return state

  const afterCost = tryPayCost(state, playerId, effect.cost)
  if (!afterCost) return state

  const newUnit: Unit = {
    id: nextCreatedUnitId(),
    ownerId: playerId,
    kind: effect.targetUnit,
    coord: targetCoord,
    movement: content.movementByKind[effect.targetUnit] ?? { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }

  return { ...afterCost, units: [...afterCost.units, newUnit] }
}

/** Per ruling: like create, an 'adj'-location transform can never cross a cliff. */
function applyTransform(state: GameState, playerId: string, unit: Unit, effect: TransformEffect, targetCoord: Coordinate | undefined, content: UnitContent): GameState {
  const resolvedTargetCoord = effect.targetHex.location === 'self' ? unit.coord : targetCoord
  if (!resolvedTargetCoord) return state

  const targetTile = getTile(state.board, resolvedTargetCoord)
  if (!targetTile || !effect.targetHex.terrainType.includes(targetTile.terrain)) return state

  if (effect.targetHex.location === 'adj') {
    if (!isAdjacent(state, unit.coord, resolvedTargetCoord)) return state
    if (unitsAt(state, resolvedTargetCoord).length > 0) return state
    if (crossesCliff(state, unit.coord, resolvedTargetCoord, content.terrainLevels)) return state
  }

  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return state

  const afterCost = tryPayCost(state, playerId, effect.cost)
  if (!afterCost) return state

  const newUnit: Unit = {
    id: nextCreatedUnitId(),
    ownerId: playerId,
    kind: effect.targetUnit,
    coord: resolvedTargetCoord,
    movement: content.movementByKind[effect.targetUnit] ?? { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }

  const units = effect.destroySelf ? afterCost.units.filter((u) => u.id !== unit.id) : afterCost.units
  return { ...afterCost, units: [...units, newUnit] }
}

/** Per ruling: convert can never cross a cliff either (same rule as create/transform). */
function applyConvert(state: GameState, playerId: string, unit: Unit, effect: ConvertEffect, targetCoord: Coordinate | undefined, content: UnitContent): GameState {
  if (!targetCoord) return state
  if (!isAdjacent(state, unit.coord, targetCoord)) return state
  if (crossesCliff(state, unit.coord, targetCoord, content.terrainLevels)) return state

  const targetUnit = unitsAt(state, targetCoord).find((u) => u.ownerId !== playerId)
  if (!targetUnit) return state

  if (effect.targetMobileOnly && !content.movementByKind[targetUnit.kind]?.isMobile) return state

  const afterCost = tryPayCost(state, playerId, effect.cost)
  if (!afterCost) return state

  const units = afterCost.units.map((u) => (u.id === targetUnit.id ? { ...u, ownerId: playerId } : u))
  return { ...afterCost, units }
}

/** Per ruling: despite the name, not a real trade — Merchant just generates flat gold, no target needed. */
function applyTradeResource(
  state: GameState,
  playerId: string,
  effect: TradeResourceEffect,
  resourceCaps: Partial<Record<keyof Resources, number | null>>,
): GameState {
  return creditResource(state, playerId, 'gold', effect.gold, resourceCaps)
}

// --- dispatcher --------------------------------------------------------------

/**
 * Rule: playing a card lets the player choose one action, and it applies
 * simultaneously to every unit of that kind they control — not a single
 * unit. A unit with no legal target (or no target supplied, for a targeted
 * action) simply does nothing; the others still act independently, each
 * paying/gaining its own share.
 */
export function applyUnitActionEffect(
  state: GameState,
  playerId: string,
  kind: string,
  action: UnitAction,
  targets: Record<string, Coordinate>,
  content: UnitContent,
): GameState {
  const actingUnits = state.units.filter((u) => u.ownerId === playerId && u.kind === kind)
  let nextState = state

  for (const unit of actingUnits) {
    const target = targets[unit.id]
    const effect = action.effect
    switch (effect.actionType) {
      case 'income':
        nextState = applyIncome(nextState, playerId, unit, effect, content.resourceCaps)
        break
      case 'produce':
        nextState = applyProduce(nextState, playerId, unit, effect, content.resourceCaps)
        break
      case 'trade':
        nextState = applyTrade(nextState, playerId, unit, effect, content.resourceCaps)
        break
      case 'create':
        nextState = applyCreate(nextState, playerId, unit, effect, target, content)
        break
      case 'transform':
        nextState = applyTransform(nextState, playerId, unit, effect, target, content)
        break
      case 'convert':
        nextState = applyConvert(nextState, playerId, unit, effect, target, content)
        break
      case 'trade-resource':
        nextState = applyTradeResource(nextState, playerId, effect, content.resourceCaps)
        break
    }
  }

  // A destroySelf transform or a convert can change who owns/has a unit of
  // a given kind — resync hand/supply zones for every affected card.
  return syncCardZonesWithBoard(nextState)
}
