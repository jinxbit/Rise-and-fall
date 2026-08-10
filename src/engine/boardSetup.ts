import { getTile } from './board'
import { applyTilePlacement, isLegalTilePlacement, placedShapeCells, seedStartingWaterTiles } from './boardGeneration'
import type { BoardGenerationContent, TileTierContent } from './boardGenerationContent'
import { syncCardZonesWithBoard } from './cards'
import { nextSequenceId } from './idSequence'
import { beginSelectCardsPhase } from './round'
import type { ActionResult, Board, BoardSetupState, Coordinate, GameState, Terrain, Unit } from './types'
import type { UnitContent } from './unitContent'

/** Per ruling: every player's three starting units, one of each kind. */
const STARTING_UNIT_KINDS = ['city', 'nomad', 'ship'] as const

function findTierContent(content: BoardGenerationContent, terrain: Terrain): TileTierContent | undefined {
  return content.tiers.find((t) => t.terrain === terrain)
}

/** Advances tileTierQueue past any tier whose pool is already exhausted (<= 0), syncing tilesRemainingInTier to whatever's now at the front. */
function skipExhaustedTiers(boardSetup: BoardSetupState, content: BoardGenerationContent): BoardSetupState {
  let queue = boardSetup.tileTierQueue
  let remaining = boardSetup.tilesRemainingInTier
  while (queue.length > 0 && remaining <= 0) {
    queue = queue.slice(1)
    remaining = queue.length > 0 ? (findTierContent(content, queue[0])?.poolSize ?? 0) : 0
  }
  return { ...boardSetup, tileTierQueue: queue, tilesRemainingInTier: remaining }
}

/** Once tile placement is fully done, populates unitsRemainingByPlayerId to kick off the unit-placement sub-phase. A no-op if tiles aren't done yet, or if this has already run. */
function beginUnitPlacementIfTilesDone(state: GameState, turnOrder: string[]): GameState {
  const boardSetup = state.boardSetup
  if (!boardSetup || boardSetup.tileTierQueue.length > 0) return state
  if (Object.keys(boardSetup.unitsRemainingByPlayerId).length > 0) return state

  const unitsRemainingByPlayerId = Object.fromEntries(turnOrder.map((id) => [id, [...STARTING_UNIT_KINDS]]))
  return { ...state, boardSetup: { ...boardSetup, unitsRemainingByPlayerId, unitPlacerIndex: 0 } }
}

/**
 * Kicks off the `boardSetup` game status: seeds the starting water tiles
 * (see seedStartingWaterTiles in ./boardGeneration.ts — fully automatic,
 * no player choice involved) and begins the interactive tile-placement
 * queue at its first non-empty tier.
 */
export function beginBoardSetup(state: GameState, content: BoardGenerationContent): GameState {
  const board = seedStartingWaterTiles(state.turnOrder.length, content.startingWaterShapeCells)
  const initialQueue = content.tiers.map((t) => t.terrain)
  const boardSetup = skipExhaustedTiers(
    {
      tileTierQueue: initialQueue,
      tilesRemainingInTier: initialQueue.length > 0 ? (findTierContent(content, initialQueue[0])?.poolSize ?? 0) : 0,
      tilePlacerIndex: 0,
      unitsRemainingByPlayerId: {},
      unitPlacerIndex: 0,
    },
    content,
  )

  const nextState: GameState = { ...state, status: 'boardSetup', board, boardSetup }
  return beginUnitPlacementIfTilesDone(nextState, state.turnOrder)
}

/**
 * Alternative to beginBoardSetup() for games starting from a pre-made map
 * (see content/mapTemplates.json, resolved via resolveMapTemplateBoard in
 * content/resolveContent.ts): skips the interactive tile-placement
 * sub-phase entirely — `board` is used exactly as given, with an empty
 * `tileTierQueue` — and goes straight into starting-unit placement, which
 * proceeds exactly as normal from there (see placeUnit below).
 */
export function beginBoardSetupWithPresetBoard(state: GameState, board: Board): GameState {
  const boardSetup: BoardSetupState = {
    tileTierQueue: [],
    tilesRemainingInTier: 0,
    tilePlacerIndex: 0,
    unitsRemainingByPlayerId: {},
    unitPlacerIndex: 0,
  }
  const nextState: GameState = { ...state, status: 'boardSetup', board, boardSetup }
  return beginUnitPlacementIfTilesDone(nextState, state.turnOrder)
}

/** Whose turn it is to place the next tile, or null if tile placement isn't currently active. */
export function currentTilePlacerId(state: GameState): string | null {
  const boardSetup = state.boardSetup
  if (state.status !== 'boardSetup' || !boardSetup || boardSetup.tileTierQueue.length === 0) return null
  if (state.turnOrder.length === 0) return null
  return state.turnOrder[boardSetup.tilePlacerIndex % state.turnOrder.length]
}

/** Whose turn it is to place the next starting unit, or null if unit placement isn't currently active. */
export function currentUnitPlacerId(state: GameState): string | null {
  const boardSetup = state.boardSetup
  if (state.status !== 'boardSetup' || !boardSetup || boardSetup.tileTierQueue.length > 0) return null
  if (Object.keys(boardSetup.unitsRemainingByPlayerId).length === 0) return null
  if (state.turnOrder.length === 0) return null
  return state.turnOrder[boardSetup.unitPlacerIndex % state.turnOrder.length]
}

/** PLACE_TILE: places one tile of the current tier (see PlaceTileAction in ./actions.ts). */
export function placeTile(
  state: GameState,
  playerId: string,
  anchor: Coordinate,
  rotationSteps: number,
  content: BoardGenerationContent,
): ActionResult {
  if (state.status !== 'boardSetup') {
    return { ok: false, error: `Not currently placing tiles (status: ${state.status})` }
  }
  const boardSetup = state.boardSetup
  if (!boardSetup || boardSetup.tileTierQueue.length === 0) {
    return { ok: false, error: 'Tile placement is already finished' }
  }
  const placerId = currentTilePlacerId(state)
  if (placerId !== playerId) {
    return { ok: false, error: "It is not this player's turn to place a tile" }
  }

  const tierTerrain = boardSetup.tileTierQueue[0]
  const tierContent = findTierContent(content, tierTerrain)
  if (!tierContent) {
    return { ok: false, error: `No board-generation content for tier '${tierTerrain}'` }
  }

  const placedCells = placedShapeCells(tierContent.shapeCells, anchor, rotationSteps)
  if (!isLegalTilePlacement(state.board, placedCells, tierContent.placesOn)) {
    return { ok: false, error: 'Illegal tile placement' }
  }

  const board = applyTilePlacement(state.board, placedCells, tierContent.terrain)
  let nextBoardSetup: BoardSetupState = {
    ...boardSetup,
    tilesRemainingInTier: boardSetup.tilesRemainingInTier - 1,
    tilePlacerIndex: boardSetup.tilePlacerIndex + 1,
  }
  nextBoardSetup = skipExhaustedTiers(nextBoardSetup, content)

  let nextState: GameState = { ...state, board, boardSetup: nextBoardSetup }
  nextState = beginUnitPlacementIfTilesDone(nextState, state.turnOrder)

  return { ok: true, state: nextState }
}

/**
 * Corrected ruling (see todo.md #12): only Ship may start on Water — City
 * and Nomad go anywhere except Glacier *and* Water. The original reading
 * ("City and Nomad anywhere except Glacier") let both start on Water,
 * which stranded a Nomad there permanently, since Water isn't in its
 * movement.terrains. Also requires the hex to be currently unoccupied —
 * not an explicitly stated rule for this specific phase, but consistent
 * with how every other unit-placing effect in the engine already behaves
 * (see applyCreate/applyTransform in ./unitActions.ts).
 */
export function isLegalStartingUnitPlacement(board: GameState['board'], units: Unit[], unitKind: string, coord: Coordinate): boolean {
  const tile = getTile(board, coord)
  if (!tile) return false
  if (units.some((u) => u.coord.q === coord.q && u.coord.r === coord.r)) return false
  if (unitKind === 'ship') return tile.terrain === 'water'
  return tile.terrain !== 'glacier' && tile.terrain !== 'water'
}

/** PLACE_UNIT: places one of the player's three starting units (see PlaceUnitAction in ./actions.ts). */
export function placeUnit(state: GameState, playerId: string, unitKind: string, coord: Coordinate, unitContent: UnitContent): ActionResult {
  if (state.status !== 'boardSetup') {
    return { ok: false, error: `Not currently placing units (status: ${state.status})` }
  }
  const boardSetup = state.boardSetup
  if (!boardSetup || boardSetup.tileTierQueue.length > 0) {
    return { ok: false, error: 'Tile placement must finish before units can be placed' }
  }
  const placerId = currentUnitPlacerId(state)
  if (placerId !== playerId) {
    return { ok: false, error: "It is not this player's turn to place a unit" }
  }

  const remaining = boardSetup.unitsRemainingByPlayerId[playerId] ?? []
  if (!remaining.includes(unitKind)) {
    return { ok: false, error: `Player has no starting ${unitKind} left to place` }
  }
  if (!isLegalStartingUnitPlacement(state.board, state.units, unitKind, coord)) {
    return { ok: false, error: 'Illegal starting unit placement' }
  }

  const { id, idSequence } = nextSequenceId(state, 'starting_unit')
  const newUnit: Unit = {
    id,
    ownerId: playerId,
    kind: unitKind,
    coord,
    movement: unitContent.movementByKind[unitKind] ?? { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }
  const units = [...state.units, newUnit]
  const unitsRemainingByPlayerId = {
    ...boardSetup.unitsRemainingByPlayerId,
    [playerId]: remaining.filter((k) => k !== unitKind),
  }
  const nextBoardSetup: BoardSetupState = { ...boardSetup, unitsRemainingByPlayerId, unitPlacerIndex: boardSetup.unitPlacerIndex + 1 }

  let nextState: GameState = { ...state, units, boardSetup: nextBoardSetup, idSequence }
  nextState = syncCardZonesWithBoard(nextState)

  const everyoneDone = Object.values(unitsRemainingByPlayerId).every((k) => k.length === 0)
  if (everyoneDone) {
    nextState = { ...nextState, status: 'active', boardSetup: null }
    nextState = beginSelectCardsPhase(nextState)
  }

  return { ok: true, state: nextState }
}
