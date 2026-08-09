// Bridges the JSON content files to the engine's content-agnostic input
// types (BoardGenerationContent, UnitContent, etc. — see each engine
// module's own comments for why the engine never imports JSON directly).
// This is the one place in the app that actually imports the JSON, so any
// caller that needs real content (LobbyPage starting a game, GamePage
// resolving actions) goes through here instead of reaching into
// content/*.json itself.

import resourcesJson from './resources.json'
import terrainJson from './terrain.json'
import unitsJson from './units.json'
import type { BoardGenerationContent, TileTierContent } from '../engine/boardGenerationContent'
import type { UnitAction, UnitContent } from '../engine/unitContent'
import type { Resources, Terrain, UnitMovement } from '../engine/types'

const TILE_TIER_ORDER: Terrain[] = ['water', 'plain', 'forest', 'mountain', 'glacier']

export function resolveBoardGenerationContent(playerCount: number): BoardGenerationContent {
  const key = String(playerCount)
  const water = terrainJson.terrainTypes.find((t) => t.id === 'water')
  const startingWaterShapeCells = water?.shapeGroups.find((g) => g.id === 'initial')?.shapes[0]?.cells ?? []

  const tiers: TileTierContent[] = []
  for (const terrain of TILE_TIER_ORDER) {
    const terrainType = terrainJson.terrainTypes.find((t) => t.id === terrain)
    if (!terrainType) continue
    const groupId = terrain === 'water' ? 'expansion' : 'standard'
    const group = terrainType.shapeGroups.find((g) => g.id === groupId)
    const shape = group?.shapes[0]
    if (!group || !shape) continue
    tiers.push({
      terrain,
      shapeCells: shape.cells,
      placesOn: terrainType.placesOn as Terrain[] | null,
      poolSize: group.limits.byPlayerCount[key as keyof typeof group.limits.byPlayerCount] ?? 0,
    })
  }

  return { startingWaterShapeCells, tiers }
}

export function resolveUnitContent(playerCount: number): UnitContent {
  const key = String(playerCount)
  const actionsByKind: Record<string, UnitAction[]> = {}
  const movementByKind: Record<string, UnitMovement> = {}
  const unitSupplyCaps: Record<string, number> = {}
  for (const unit of unitsJson.units) {
    actionsByKind[unit.id] = unit.actions as UnitAction[]
    movementByKind[unit.id] = unit.movement as UnitMovement
    unitSupplyCaps[unit.id] = unit.supply.byPlayerCount[key as keyof typeof unit.supply.byPlayerCount] ?? 0
  }

  const terrainLevels: Record<string, number> = {}
  for (const terrainType of terrainJson.terrainTypes) {
    terrainLevels[terrainType.id] = terrainType.level
  }

  const resourceCaps: Partial<Record<keyof Resources, number | null>> = {}
  for (const resource of resourcesJson.resources) {
    resourceCaps[resource.id as keyof Resources] = resource.playerCap
  }

  return { actionsByKind, movementByKind, terrainLevels, resourceCaps, unitSupplyCaps }
}

export function resolveResourceBank(playerCount: number): Resources {
  const key = String(playerCount)
  const bank: Partial<Resources> = {}
  for (const resource of resourcesJson.resources) {
    bank[resource.id as keyof Resources] = resource.globalSupply.byPlayerCount[key as keyof typeof resource.globalSupply.byPlayerCount] ?? 0
  }
  return { gold: bank.gold ?? 0, wood: bank.wood ?? 0, stone: bank.stone ?? 0 }
}

export function resolveUnitLimits(playerCount: number): Record<string, number> {
  const key = String(playerCount)
  const limits: Record<string, number> = {}
  for (const unit of unitsJson.units) {
    limits[unit.id] = unit.supply.byPlayerCount[key as keyof typeof unit.supply.byPlayerCount] ?? 0
  }
  return limits
}
