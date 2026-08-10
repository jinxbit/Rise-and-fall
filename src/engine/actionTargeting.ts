import { getTile, neighborCoords } from './board'
import { legalMoveDestinations } from './movement'
import { canAffordCost, crossesCliff, hasReachedSupplyCap, isCreationAllowedOnTerrain, unitsAt } from './unitActions'
import type { ConvertEffect, CreateEffect, TransformEffect, UnitAction, UnitContent } from './unitContent'
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
  if (!player || !canAffordCost(player.resources, effect.cost)) return []
  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return []

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
    if (crossesCliff(state, unit.coord, coord, content.terrainLevels)) return false
    return true
  })
}

export function legalConvertTargets(state: GameState, playerId: string, unit: Unit, effect: ConvertEffect, content: UnitContent): Coordinate[] {
  const player = state.players.find((p) => p.id === playerId)
  if (!player || !canAffordCost(player.resources, effect.cost)) return []

  return neighborCoords(state.board, unit.coord).filter((coord) => {
    if (crossesCliff(state, unit.coord, coord, content.terrainLevels)) return false
    const target = unitsAt(state, coord).find((u) => u.ownerId !== playerId)
    if (!target) return false
    if (effect.targetMobileOnly && !content.movementByKind[target.kind]?.isMobile) return false
    return true
  })
}

/**
 * Whether `unit` could actually perform `action` right now — used to
 * disable options in the radial action menu (see ActionMenuOption in
 * ../components/HexBoard.tsx) before the player even picks one, so a
 * choice that's guaranteed to be rejected by RESOLVE_UNIT_ACTION (see
 * applyResolveUnitAction in ./applyAction.ts) never gets offered as if it
 * were live. income/produce/trade have no cost or required target, so
 * they're always available even when their numeric payout would be zero
 * (e.g. no adjacent qualifying units) — same "always succeeds" rule
 * applyResolveUnitAction uses to decide which action types can fail at
 * all.
 */
export function isActionAvailableForUnit(state: GameState, playerId: string, unit: Unit, action: UnitAction, content: UnitContent): boolean {
  const effect = action.effect
  switch (effect.actionType) {
    case 'income':
    case 'produce':
    case 'trade':
      return true
    case 'create':
      return legalCreateTargets(state, playerId, unit, effect, content).length > 0
    case 'transform':
      return legalTransformTargets(state, playerId, unit, effect, content).length > 0
    case 'convert':
      return legalConvertTargets(state, playerId, unit, effect, content).length > 0
    case 'trade-resource': {
      const player = state.players.find((p) => p.id === playerId)
      if (!player) return false
      if (effect.mode === 'sell') return player.resources[effect.resource] >= effect.resourceAmount
      return player.resources.gold >= effect.resourceAmount * effect.goldPerResource
    }
    case 'move':
      return legalMoveDestinations(state, unit, unit.movement, content.terrainLevels).length > 0
  }
}
