import { getTile, neighborCoords } from './board'
import { canAffordCost, crossesCliff, hasReachedSupplyCap, isCreationAllowedOnTerrain, unitsAt } from './unitActions'
import type { ConvertEffect, CreateEffect, TransformEffect, UnitContent } from './unitContent'
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
