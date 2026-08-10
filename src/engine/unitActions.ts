import { getTile, neighborCoords } from './board'
import { syncCardZonesWithBoard } from './cards'
import { isCliffBetweenTerrains } from './cliffs'
import { nextSequenceId } from './idSequence'
import { legalMoveDestinations } from './movement'
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
import type { Coordinate, GameState, Resources, Terrain, Unit } from './types'
import { coordKey } from './types'

// --- board/adjacency helpers -----------------------------------------------

export function unitsAt(state: GameState, coord: Coordinate): Unit[] {
  const key = coordKey(coord)
  return state.units.filter((u) => coordKey(u.coord) === key)
}

export function isAdjacent(state: GameState, a: Coordinate, b: Coordinate): boolean {
  const key = coordKey(b)
  return neighborCoords(state.board, a).some((c) => coordKey(c) === key)
}

function adjacentUnits(state: GameState, coord: Coordinate): Unit[] {
  const neighborKeys = new Set(neighborCoords(state.board, coord).map(coordKey))
  return state.units.filter((u) => neighborKeys.has(coordKey(u.coord)))
}

export function crossesCliff(state: GameState, from: Coordinate, to: Coordinate, terrainLevels: Record<string, number>): boolean {
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

/** Read-only affordability check (no state change) — used by UI to preview legal targets before submitting. */
export function canAffordCost(resources: Resources, cost: ActionCost): boolean {
  return (cost.gold ?? 0) <= resources.gold && (cost.wood ?? 0) <= resources.wood && (cost.stone ?? 0) <= resources.stone
}

export function hasReachedSupplyCap(state: GameState, playerId: string, kind: string, unitSupplyCaps: Record<string, number>): boolean {
  const cap = unitSupplyCaps[kind]
  if (cap === undefined) return false
  const count = state.units.filter((u) => u.ownerId === playerId && u.kind === kind).length
  return count >= cap
}

/**
 * Per ruling: some terrain types restrict which single unit kind may be
 * created/transformed into existence there, regardless of that kind's own
 * movement profile (a Merchant can travel onto Water once it exists, but
 * can't be *built* there) and regardless of whatever terrain restriction
 * the action's own content already specifies. Water: only a Ship. Glacier:
 * only a Mountaineer — 'create' effects have no `targetHex.terrainType`
 * field in content at all (see CreateEffect in ./unitContent.ts), so
 * without this a City's "Create Nomad" would happily place a Nomad on
 * Glacier with nothing to stop it. Applied as a hard engine-level
 * guarantee in both applyCreate and applyTransform below (and mirrored in
 * ./actionTargeting.ts's legalCreateTargets/legalTransformTargets for the
 * UI), so a future content mistake can't reintroduce either violation.
 */
const SOLE_CREATABLE_KIND_BY_TERRAIN: Partial<Record<Terrain, string>> = {
  water: 'ship',
  glacier: 'mountaineer',
}

export function isCreationAllowedOnTerrain(targetUnit: string, terrain: Terrain): boolean {
  const soleAllowedKind = SOLE_CREATABLE_KIND_BY_TERRAIN[terrain]
  return soleAllowedKind === undefined || soleAllowedKind === targetUnit
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

/** Per ruling: creation can never cross a cliff, always respects the target kind's supply cap, and can never target Water/Glacier unless the created kind is the one sole kind allowed there (see isCreationAllowedOnTerrain). */
function applyCreate(state: GameState, playerId: string, unit: Unit, effect: CreateEffect, targetCoord: Coordinate | undefined, content: UnitContent): GameState {
  if (!targetCoord) return state
  if (!isAdjacent(state, unit.coord, targetCoord)) return state
  const targetTile = getTile(state.board, targetCoord)
  if (!targetTile) return state
  if (!isCreationAllowedOnTerrain(effect.targetUnit, targetTile.terrain)) return state
  if (unitsAt(state, targetCoord).length > 0) return state
  if (crossesCliff(state, unit.coord, targetCoord, content.terrainLevels)) return state
  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return state

  const afterCost = tryPayCost(state, playerId, effect.cost)
  if (!afterCost) return state

  const { id, idSequence } = nextSequenceId(afterCost, 'created_unit')
  const newUnit: Unit = {
    id,
    ownerId: playerId,
    kind: effect.targetUnit,
    coord: targetCoord,
    movement: content.movementByKind[effect.targetUnit] ?? { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }

  return { ...afterCost, idSequence, units: [...afterCost.units, newUnit] }
}

/** Per ruling: like create, an 'adj'-location transform can never cross a cliff. */
function applyTransform(state: GameState, playerId: string, unit: Unit, effect: TransformEffect, targetCoord: Coordinate | undefined, content: UnitContent): GameState {
  const resolvedTargetCoord = effect.targetHex.location === 'self' ? unit.coord : targetCoord
  if (!resolvedTargetCoord) return state

  const targetTile = getTile(state.board, resolvedTargetCoord)
  if (!targetTile || !effect.targetHex.terrainType.includes(targetTile.terrain)) return state
  if (!isCreationAllowedOnTerrain(effect.targetUnit, targetTile.terrain)) return state

  if (effect.targetHex.location === 'adj') {
    if (!isAdjacent(state, unit.coord, resolvedTargetCoord)) return state
    if (unitsAt(state, resolvedTargetCoord).length > 0) return state
    if (crossesCliff(state, unit.coord, resolvedTargetCoord, content.terrainLevels)) return state
  }

  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return state

  const afterCost = tryPayCost(state, playerId, effect.cost)
  if (!afterCost) return state

  const { id, idSequence } = nextSequenceId(afterCost, 'created_unit')
  const newUnit: Unit = {
    id,
    ownerId: playerId,
    kind: effect.targetUnit,
    coord: resolvedTargetCoord,
    movement: content.movementByKind[effect.targetUnit] ?? { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }

  const units = effect.destroySelf ? afterCost.units.filter((u) => u.id !== unit.id) : afterCost.units
  return { ...afterCost, idSequence, units: [...units, newUnit] }
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

/**
 * A real conversion: `resource`/`mode` are fixed on the effect (Merchant
 * has a separate action per resource+direction — Buy/Sell Wood/Stone), so
 * no target is needed; it just applies to every acting Merchant like any
 * other no-target action. Skips (per unit) if the player can't afford the
 * gold (buy) or doesn't have the resource (sell).
 */
function applyTradeResource(
  state: GameState,
  playerId: string,
  effect: TradeResourceEffect,
  resourceCaps: Partial<Record<keyof Resources, number | null>>,
): GameState {
  const player = state.players.find((p) => p.id === playerId)
  if (!player) return state
  const goldAmount = effect.goldPerResource * effect.resourceAmount

  if (effect.mode === 'sell') {
    const sold = spendResource(player.resources, state.resourceBank, effect.resource, effect.resourceAmount)
    if (!sold) return state
    return creditResource(updatePlayerResources(state, playerId, sold.resources, sold.bank), playerId, 'gold', goldAmount, resourceCaps)
  }

  const paid = spendResource(player.resources, state.resourceBank, 'gold', goldAmount)
  if (!paid) return state
  return creditResource(updatePlayerResources(state, playerId, paid.resources, paid.bank), playerId, effect.resource, effect.resourceAmount, resourceCaps)
}

/**
 * A normal targeted action like any other (create/transform/convert): each
 * acting unit moves to its own `targetCoord`, independently. A unit with no
 * target supplied, or whose target isn't among its legalMoveDestinations
 * (./movement.ts — e.g. an immobile kind like City/Temple, or outside its
 * movement profile), simply does nothing this turn.
 */
function applyMove(state: GameState, unit: Unit, targetCoord: Coordinate | undefined, content: UnitContent): GameState {
  if (!targetCoord) return state

  const legalDestinations = legalMoveDestinations(state, unit, unit.movement, content.terrainLevels)
  if (!legalDestinations.some((c) => coordKey(c) === coordKey(targetCoord))) return state

  const units = state.units.map((u) => (u.id === unit.id ? { ...u, coord: targetCoord } : u))
  return { ...state, units }
}

// --- dispatcher --------------------------------------------------------------

/**
 * Rule: playing a card lets the player choose an action per unit of that
 * kind — not one action shared by all of them; different units of the same
 * kind may each perform a different action the same round (see
 * applyResolveUnitAction in ./applyAction.ts, which groups units by their
 * chosen action id and calls this once per group). `unitIds`, when given,
 * restricts which of the player's units of this kind this call actually
 * acts on; omitted (the default), every one of them acts — the shape a
 * single shared action takes, kept as the default so callers that only
 * ever use one action for the whole kind (most direct engine tests) don't
 * need to pass it. A unit with no legal target (or no target supplied, for
 * a targeted action) simply does nothing; the others still act
 * independently, each paying/gaining its own share.
 */
export function applyUnitActionEffect(
  state: GameState,
  playerId: string,
  kind: string,
  action: UnitAction,
  targets: Record<string, Coordinate>,
  content: UnitContent,
  unitIds?: string[],
): GameState {
  const eligibleUnitIds = unitIds ? new Set(unitIds) : null
  const actingUnits = state.units.filter(
    (u) => u.ownerId === playerId && u.kind === kind && (!eligibleUnitIds || eligibleUnitIds.has(u.id)),
  )
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
      case 'move':
        nextState = applyMove(nextState, unit, target, content)
        break
    }
  }

  // A destroySelf transform or a convert can change who owns/has a unit of
  // a given kind — resync hand/supply zones for every affected card. Skipped
  // when nothing about `state` actually changed (every acting unit's action
  // turned out to be illegal/unaffordable), so a genuine no-op is
  // detectable by callers via reference equality — see
  // applyResolveUnitAction in ./applyAction.ts, which rejects a
  // RESOLVE_UNIT_ACTION outright rather than silently accepting a no-op as
  // the unit's turn.
  return nextState === state ? nextState : syncCardZonesWithBoard(nextState)
}
