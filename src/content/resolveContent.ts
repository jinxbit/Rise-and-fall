// Bridges the JSON content files to the engine's content-agnostic input
// types (BoardGenerationContent, UnitContent, etc. — see each engine
// module's own comments for why the engine never imports JSON directly).
// This is the one place in the app that actually imports the JSON, so any
// caller that needs real content (LobbyPage starting a game, GamePage
// resolving actions) goes through here instead of reaching into
// content/*.json itself.

import achievementsJson from './achievements.json'
import mapTemplatesJson from './mapTemplates.json'
import resourcesJson from './resources.json'
import talesJson from './tales.json'
import terrainJson from './terrain.json'
import unitsJson from './units.json'
import type { AchievementContent } from '../engine/achievementContent'
import { createEmptyBoard, setTile } from '../engine/board'
import type { BoardGenerationContent, TileTierContent } from '../engine/boardGenerationContent'
import type { FantasticEvent, TaleContent, TaleExtraUnitContent } from '../engine/taleContent'
import type { UnitAction, UnitContent } from '../engine/unitContent'
import type { Board, BoardShape, Resources, Terrain, UnitMovement } from '../engine/types'

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

  return { actionsByKind, movementByKind, terrainLevels, resourceCaps, unitSupplyCaps, companionKindsByCardKind: {} }
}

export interface TaleSummary {
  id: string
  number: number
  name: string
  description: string
  category: string
}

/** Every Tale in the game, for a Tale-selection UI (draft or host-pick) — see content/tales.json. */
export function listTales(): TaleSummary[] {
  return talesJson.tales
    .map((t) => ({ id: t.id, number: t.number, name: t.name, description: t.description, category: t.category }))
    .sort((a, b) => a.number - b.number)
}

/**
 * Resolves the merged TaleContent for whichever Tales are active in a
 * given game (content/tales.json, filtered to `activeTaleIds`) — pass to
 * src/engine/tales.ts's applyTaleModifiers on top of resolveUnitContent's
 * result to get the game's effective UnitContent. Returns
 * EMPTY_TALE_CONTENT's shape (all-empty) if activeTaleIds is empty, same
 * "no Tales active" no-op behavior as EMPTY_TALE_CONTENT itself.
 */
export function resolveTaleContent(activeTaleIds: string[], playerCount: number): TaleContent {
  const key = String(playerCount)
  const activeIds = new Set(activeTaleIds)
  const activeTales = talesJson.tales.filter((t) => activeIds.has(t.id)).sort((a, b) => a.number - b.number)

  const extraUnitKinds: Record<string, TaleExtraUnitContent> = {}
  const extraActionsByKind: Record<string, UnitAction[]> = {}
  const movementOverridesByKind: Record<string, Partial<UnitMovement>> = {}
  const fantasticEvents: FantasticEvent[] = []

  for (const tale of activeTales) {
    for (const unit of tale.extraUnits ?? []) {
      extraUnitKinds[unit.id] = {
        movement: unit.movement as UnitMovement,
        actions: unit.actions as UnitAction[],
        supplyCap: unit.supply.byPlayerCount[key as keyof typeof unit.supply.byPlayerCount] ?? 0,
        companionOfKind: unit.companionOfKind,
      }
    }
    for (const [kind, actions] of Object.entries(tale.extraActionsByKind ?? {})) {
      extraActionsByKind[kind] = [...(extraActionsByKind[kind] ?? []), ...(actions as UnitAction[])]
    }
    for (const [kind, override] of Object.entries(tale.movementOverridesByKind ?? {})) {
      movementOverridesByKind[kind] = { ...movementOverridesByKind[kind], ...(override as Partial<UnitMovement>) }
    }
    fantasticEvents.push(...((tale as { fantasticEvents?: FantasticEvent[] }).fantasticEvents ?? []))
  }

  return { extraUnitKinds, extraActionsByKind, movementOverridesByKind, fantasticEvents }
}

export function resolveResourceBank(playerCount: number): Resources {
  const key = String(playerCount)
  const bank: Partial<Resources> = {}
  for (const resource of resourcesJson.resources) {
    bank[resource.id as keyof Resources] = resource.globalSupply.byPlayerCount[key as keyof typeof resource.globalSupply.byPlayerCount] ?? 0
  }
  return { gold: bank.gold ?? 0, wood: bank.wood ?? 0, stone: bank.stone ?? 0 }
}

export interface MapTemplateSummary {
  id: string
  name: string
  description: string
}

/** Every pre-made map template a player can choose at game creation (see mapTemplates.json), skipping interactive tile placement in board setup. */
export function listMapTemplates(): MapTemplateSummary[] {
  return mapTemplatesJson.mapTemplates.map((t) => ({ id: t.id, name: t.name, description: t.description }))
}

/**
 * Builds the finished Board for a map template id, or null if no template
 * with that id exists (e.g. a game's map_template_id references a template
 * that's since been renamed/removed). Passed to
 * src/engine/createGame.ts's startGameWithPresetBoard.
 */
export function resolveMapTemplateBoard(templateId: string): Board | null {
  const template = mapTemplatesJson.mapTemplates.find((t) => t.id === templateId)
  if (!template) return null

  let board = createEmptyBoard(template.shape as BoardShape)
  for (const tile of template.tiles) {
    board = setTile(board, { q: tile.q, r: tile.r }, tile.terrain as Terrain)
  }
  return board
}

export interface AchievementSummary {
  id: string
  name: string
  description: string
  unitId: string
  victoryPoints: number
}

/** Every achievement in the game, for display (see AchievementsPanel in RoundView.tsx) — name/description aren't part of AchievementContent since the engine itself never needs them, only the id/unitId/victoryPoints mapping. */
export function listAchievements(): AchievementSummary[] {
  return achievementsJson.achievements.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    unitId: a.unitId,
    victoryPoints: a.victoryPoints,
  }))
}

export interface TerrainSummary {
  id: string
  name: string
}

/** Every terrain type's display name, for resolving a terrain id (e.g. from calculateTerrainControlDetail) to something player-facing (e.g. EndGameView.tsx's score breakdown). */
export function listTerrainTypes(): TerrainSummary[] {
  return terrainJson.terrainTypes.map((t) => ({ id: t.id, name: t.name }))
}

export interface GameLengthBounds {
  default: number
  min: number
  max: number
}

/** content/achievements.json's gameLength bounds, for the game-length picker (see GameLengthSelector.tsx) — the same min/max resolveAchievementContent clamps `gameLength` to. */
export function listGameLengthBounds(): GameLengthBounds {
  return achievementsJson.gameLength
}

/**
 * `gameLength` is the players' chosen target (games.game_length — see
 * 0006_game_length.sql), clamped to content/achievements.json's
 * gameLength.min/max so a stale or malformed value can never push the
 * game-end check outside what the achievement table actually supports.
 * Omitted (the default) falls back to gameLength.default, same as before
 * this parameter existed.
 */
export function resolveAchievementContent(gameLength?: number): AchievementContent {
  const unitKindByAchievementId: Record<string, string> = {}
  const achievementVictoryPoints: Record<string, number> = {}
  for (const achievement of achievementsJson.achievements) {
    unitKindByAchievementId[achievement.id] = achievement.unitId
    achievementVictoryPoints[achievement.id] = achievement.victoryPoints
  }

  const unitBoardCountVP: Record<string, number[]> = {}
  for (const unit of unitsJson.units) {
    unitBoardCountVP[unit.id] = unit.victoryPoints.byBoardCount
  }

  const terrainVictoryPoints: Record<string, number> = {}
  const terrainScoresAs: Record<string, string> = {}
  for (const terrainType of terrainJson.terrainTypes) {
    terrainVictoryPoints[terrainType.id] = terrainType.victoryPoints
    terrainScoresAs[terrainType.id] = terrainType.scoresAs
  }

  const { default: defaultGameLength, min, max } = achievementsJson.gameLength
  const clampedGameLength = gameLength === undefined ? defaultGameLength : Math.min(max, Math.max(min, gameLength))

  return {
    unitKindByAchievementId,
    achievementVictoryPoints,
    purchaseCostTable: achievementsJson.purchaseCost.byAchievementCount,
    gameLength: clampedGameLength,
    unitBoardCountVP,
    terrainVictoryPoints,
    terrainScoresAs,
    goldPerVictoryPoint: achievementsJson.goldVictoryPoints.goldPerPoint,
  }
}
