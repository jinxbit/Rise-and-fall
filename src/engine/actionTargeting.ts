import { getTile, neighborCoords } from './board'
import { legalMoveDestinations } from './movement'
import { wouldGainResource } from './resources'
import {
  canAffordCost,
  computeEffectiveTransformCost,
  computeIncomeGold,
  computeProduceAmounts,
  computeRegionUnitCountGold,
  computeTradeGold,
  crossesCliff,
  hasAdjacentOwnUnitKind,
  hasAdjacentTerrain,
  hasReachedSupplyCap,
  isCreationAllowedOnTerrain,
  unitsAt,
} from './unitActions'
import type { ConvertEffect, CreateEffect, SiteCreateEffect, TransformEffect, UnitAction, UnitContent } from './unitContent'
import type { Coordinate, GameState, Unit } from './types'

/**
 * Read-only "which hexes could this unit legally target right now" queries,
 * mirroring the same rules applyCreate/applyTransform/applyConvert in
 * ./unitActions.ts enforce when an action actually resolves — used by the UI
 * to highlight legal targets before a player commits to one (see
 * RESOLVE_UNIT_ACTION's `targets`), without duplicating the rules
 * themselves: this and unitActions.ts both call the same exported
 * isAdjacent/crossesCliff/unitsAt/hasReachedSupplyCap/canAffordCost/
 * isCreationAllowedOnTerrain predicates. `move`'s targeting reuses legalMoveDestinations from
 * ./movement.ts directly, and no-target/self-location effects need no
 * targeting UI at all, so neither is duplicated here.
 */

export function legalCreateTargets(state: GameState, playerId: string, unit: Unit, effect: CreateEffect, content: UnitContent): Coordinate[] {
  const player = state.players.find((p) => p.id === playerId)
  if (!player || !canAffordCost(player.resources, effect.cost)) return []
  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return []

  return neighborCoords(state.board, unit.coord).filter((coord) => {
    const tile = getTile(state.board, coord)
    if (!tile) return false
    if (!isCreationAllowedOnTerrain(effect.targetUnit, tile.terrain)) return false
    if (unitsAt(state, coord).length > 0) return false
    if (crossesCliff(state, unit.coord, coord, content.terrainLevels)) return false
    return true
  })
}

export function legalTransformTargets(state: GameState, playerId: string, unit: Unit, effect: TransformEffect, content: UnitContent): Coordinate[] {
  const player = state.players.find((p) => p.id === playerId)
  if (!player || !canAffordCost(player.resources, computeEffectiveTransformCost(state, effect))) return []
  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return []
  if (effect.requiredAdjacentTerrain && !hasAdjacentTerrain(state, unit.coord, effect.requiredAdjacentTerrain)) return []
  if (effect.requiredAdjacentOwnUnitKind && !hasAdjacentOwnUnitKind(state, playerId, unit.coord, effect.requiredAdjacentOwnUnitKind)) return []

  if (effect.targetHex.location === 'self') {
    const tile = getTile(state.board, unit.coord)
    if (!tile || !effect.targetHex.terrainType.includes(tile.terrain)) return []
    return isCreationAllowedOnTerrain(effect.targetUnit, tile.terrain) ? [unit.coord] : []
  }

  return neighborCoords(state.board, unit.coord).filter((coord) => {
    const tile = getTile(state.board, coord)
    if (!tile || !effect.targetHex.terrainType.includes(tile.terrain)) return false
    if (!isCreationAllowedOnTerrain(effect.targetUnit, tile.terrain)) return false
    if (unitsAt(state, coord).length > 0) return false
    // See applyTransform's matching comment (./unitActions.ts): an
    // 'adj'-location transform relocates the acting unit itself, so it
    // respects the acting unit's own canCrossCliffs, unlike create/convert.
    if (!unit.movement.canCrossCliffs && crossesCliff(state, unit.coord, coord, content.terrainLevels)) return false
    return true
  })
}

/** Whether a site-create action's fixed conditions (occupant block + supply cap + cost) are currently satisfied — the action has no target to choose (it always applies to the acting unit's own hex), so this is a plain boolean, not a coordinate list. */
export function isSiteCreateAvailable(state: GameState, playerId: string, unit: Unit, effect: SiteCreateEffect, content: UnitContent): boolean {
  const player = state.players.find((p) => p.id === playerId)
  if (!player || !canAffordCost(player.resources, effect.cost)) return false
  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return false
  const tile = getTile(state.board, unit.coord)
  if (!tile || !isCreationAllowedOnTerrain(effect.targetUnit, tile.terrain)) return false
  const blockedKinds = new Set(effect.blockedByKinds)
  return !unitsAt(state, unit.coord).some((u) => u.id !== unit.id && blockedKinds.has(u.kind))
}

export function legalConvertTargets(state: GameState, playerId: string, unit: Unit, effect: ConvertEffect, content: UnitContent): Coordinate[] {
  const player = state.players.find((p) => p.id === playerId)
  if (!player) return []

  return neighborCoords(state.board, unit.coord).filter((coord) => {
    if (crossesCliff(state, unit.coord, coord, content.terrainLevels)) return false
    const target = unitsAt(state, coord).find((u) =>
      effect.targetOwner === 'own'
        ? u.ownerId === playerId && (!effect.requiredTargetKind || u.kind === effect.requiredTargetKind)
        : u.ownerId !== playerId,
    )
    if (!target) return false
    if (effect.targetMobileOnly && !content.movementByKind[target.kind]?.isMobile) return false
    // Cost can vary by the target's own kind (e.g. Temple's Convert Enemy
    // Unit — see ConvertEffect.costByTargetKind), so affordability has to
    // be checked per candidate target, not once up front for the whole action.
    const cost = effect.costByTargetKind?.[target.kind] ?? effect.cost
    if (!canAffordCost(player.resources, cost)) return false
    const resultKind = effect.resultUnit ?? target.kind
    // The target only needs a supply-cap check if it's actually becoming a
    // *new* unit of resultKind under playerId's count — true whenever
    // ownership is changing (targetOwner: 'enemy', e.g. Temple's Convert
    // Enemy Unit — playerId didn't own it before, regardless of whether its
    // kind is changing too) or the kind is changing on a unit playerId
    // already owned (targetOwner: 'own', e.g. City's Create Merchant/
    // Mountaineer). Skipping the check just because resultKind happens to
    // equal target.kind was wrong for the 'enemy' case — that's exactly
    // Convert Enemy Unit's shape (no resultUnit override), which let it
    // capture unlimited enemy units regardless of the capturer's own supply.
    const becomesNewUnitForPlayer = target.ownerId !== playerId || resultKind !== target.kind
    if (becomesNewUnitForPlayer && hasReachedSupplyCap(state, playerId, resultKind, content.unitSupplyCaps)) return false
    return true
  })
}

/**
 * Whether `unit` could actually perform `action` right now — used to
 * disable options in the radial action menu (see ActionMenuOption in
 * ../components/HexBoard.tsx) before the player even picks one, so a
 * choice that's guaranteed to be rejected by RESOLVE_UNIT_ACTION (see
 * applyResolveUnitAction in ./applyAction.ts) never gets offered as if it
 * were live. income/produce/trade have no cost or required target, but
 * they're only actually available when they'd actually pay out something
 * — not just when their nominal effect amount is nonzero (e.g. a Nomad's
 * Produce Resource on Plain, where resourceByTerrain has no entry, isn't a
 * legal choice at all), but also when the player's already at that
 * resource's cap or the shared bank is empty, since either would clamp the
 * real gain to zero (wouldGainResource, ./resources.ts — the same check
 * creditResource in ./unitActions.ts uses, so this always agrees with what
 * RESOLVE_UNIT_ACTION would actually do). trade-resource's buy mode needs
 * the same check on the resource it would receive, on top of its own
 * affordability check.
 */
export function isActionAvailableForUnit(state: GameState, playerId: string, unit: Unit, action: UnitAction, content: UnitContent): boolean {
  const effect = action.effect
  const player = state.players.find((p) => p.id === playerId)
  if (!player) return false

  switch (effect.actionType) {
    case 'income':
      return wouldGainResource(player.resources, state.resourceBank, 'gold', computeIncomeGold(state, playerId, unit, effect), content.resourceCaps.gold ?? null)
    case 'produce': {
      const amounts = computeProduceAmounts(state, unit, effect)
      if (!amounts) return false
      return (['gold', 'wood', 'stone'] as const).some((key) =>
        wouldGainResource(player.resources, state.resourceBank, key, amounts[key] ?? 0, content.resourceCaps[key] ?? null),
      )
    }
    case 'trade':
      return wouldGainResource(player.resources, state.resourceBank, 'gold', computeTradeGold(state, unit, effect), content.resourceCaps.gold ?? null)
    case 'create':
      return legalCreateTargets(state, playerId, unit, effect, content).length > 0
    case 'transform':
      return legalTransformTargets(state, playerId, unit, effect, content).length > 0
    case 'convert':
      return legalConvertTargets(state, playerId, unit, effect, content).length > 0
    case 'trade-resource': {
      if (effect.mode === 'sell') return player.resources[effect.resource] >= effect.resourceAmount
      if (player.resources.gold < effect.resourceAmount * effect.goldPerResource) return false
      return wouldGainResource(player.resources, state.resourceBank, effect.resource, effect.resourceAmount, content.resourceCaps[effect.resource] ?? null)
    }
    case 'move':
      return legalMoveDestinations(state, unit, unit.movement, content.terrainLevels).length > 0
    case 'site-create':
      return isSiteCreateAvailable(state, playerId, unit, effect, content)
    case 'region-unit-count-income':
      return wouldGainResource(player.resources, state.resourceBank, 'gold', computeRegionUnitCountGold(state, unit, effect), content.resourceCaps.gold ?? null)
  }
}
