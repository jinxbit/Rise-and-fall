import { connectedTerrainRegion, coordsWithinDistance, getTile, neighborCoords } from './board'
import { syncCardZonesWithBoard } from './cards'
import { isCliffBetweenTerrains } from './cliffs'
import { nextSequenceId } from './idSequence'
import { legalMoveDestinations } from './movement'
import { gainResource, spendResource, wouldGainResource } from './resources'
import type {
  ActionCost,
  ConvertEffect,
  CreateEffect,
  IncomeEffect,
  ProduceEffect,
  RegionUnitCountIncomeEffect,
  SiteCreateEffect,
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

/** Whether `to` is within `maxDistance` hex-steps of `from` (not including `from` itself) — see ConvertEffect.maxDistance/IncomeEffect.maxDistance. `maxDistance: 1` is exactly isAdjacent. */
export function isWithinDistance(state: GameState, from: Coordinate, to: Coordinate, maxDistance: number): boolean {
  const key = coordKey(to)
  return coordsWithinDistance(state.board, from, maxDistance).some((c) => coordKey(c) === key)
}

/** Every unit within `maxDistance` hex-steps of `coord` (not including `coord` itself) — the longer-range counterpart to adjacentUnits, see IncomeEffect.maxDistance. */
function unitsWithinDistance(state: GameState, coord: Coordinate, maxDistance: number): Unit[] {
  const keys = new Set(coordsWithinDistance(state.board, coord, maxDistance).map(coordKey))
  return state.units.filter((u) => keys.has(coordKey(u.coord)))
}

export function crossesCliff(state: GameState, from: Coordinate, to: Coordinate, terrainLevels: Record<string, number>): boolean {
  const fromTile = getTile(state.board, from)
  const toTile = getTile(state.board, to)
  if (!fromTile || !toTile) return false
  return isCliffBetweenTerrains(fromTile.terrain, toTile.terrain, terrainLevels)
}

/** Whether an 'adj'-location transform's target hex is available to place on: empty, or occupied only by units whose kind is in allowedOccupantKinds (any owner) — see TransformEffect.allowedOccupantKinds in ./unitContent.ts. */
export function isTransformTargetAvailable(state: GameState, coord: Coordinate, allowedOccupantKinds: string[] | undefined): boolean {
  const occupants = unitsAt(state, coord)
  if (occupants.length === 0) return true
  const allowed = new Set(allowedOccupantKinds ?? [])
  return occupants.every((u) => allowed.has(u.kind))
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
  const player = state.players.find((p) => p.id === playerId)
  if (!player) return state
  const cap = resourceCaps[resourceId] ?? null
  // A fully-clamped credit (nothing left in the bank, or already at cap) is
  // a true no-op — return the same state reference, not a new-but-
  // value-identical one, so applyResolveUnitAction's "did this action
  // actually do anything" check (nextState === beforeState) still catches
  // it. See wouldGainResource's doc comment.
  if (!wouldGainResource(player.resources, state.resourceBank, resourceId, amount, cap)) return state
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
 * Per ruling: some terrain types restrict which unit kind(s) may be
 * created/transformed into existence there, regardless of that kind's own
 * movement profile (a Merchant can travel onto Water once it exists, but
 * can't be *built* there) and regardless of whatever terrain restriction
 * the action's own content already specifies. Water: only a Ship (base
 * game) or a Port (The Ports Tale — its whole point is a permanent
 * structure built ON a Sea space). Glacier: only a Mountaineer. 'create'
 * effects have no `targetHex.terrainType` field in content at all (see
 * CreateEffect in ./unitContent.ts), so without this a City's "Create
 * Nomad" would happily place a Nomad on Glacier with nothing to stop it.
 * Applied as a hard engine-level guarantee in both applyCreate and
 * applyTransform below (and mirrored in ./actionTargeting.ts's
 * legalCreateTargets/legalTransformTargets for the UI), so a future
 * content mistake can't reintroduce any of these violations.
 */
const CREATABLE_KINDS_BY_TERRAIN: Partial<Record<Terrain, string[]>> = {
  water: ['ship', 'port', 'bridge'],
  glacier: ['mountaineer'],
}

export function isCreationAllowedOnTerrain(targetUnit: string, terrain: Terrain): boolean {
  const allowedKinds = CREATABLE_KINDS_BY_TERRAIN[terrain]
  return allowedKinds === undefined || allowedKinds.includes(targetUnit)
}

/** Whether at least one hex adjacent to `coord` currently has one of `terrains` — see TransformEffect.requiredAdjacentTerrain. */
export function hasAdjacentTerrain(state: GameState, coord: Coordinate, terrains: string[]): boolean {
  return neighborCoords(state.board, coord).some((neighbor) => {
    const tile = getTile(state.board, neighbor)
    return tile !== undefined && terrains.includes(tile.terrain)
  })
}

/** Whether at least one hex adjacent to `coord` currently holds a unit of `kind` owned by `playerId` — see TransformEffect.requiredAdjacentOwnUnitKind. */
export function hasAdjacentOwnUnitKind(state: GameState, playerId: string, coord: Coordinate, kind: string): boolean {
  return adjacentUnits(state, coord).some((u) => u.ownerId === playerId && u.kind === kind)
}

/** Whether `playerId` currently controls at least `atLeast` units of `kind` anywhere on the board — see TransformEffect.requiredOwnKindCount. */
export function hasOwnKindCountAtLeast(state: GameState, playerId: string, kind: string, atLeast: number): boolean {
  return state.units.filter((u) => u.ownerId === playerId && u.kind === kind).length >= atLeast
}

/** Every hex adjacent to BOTH `a` and `b` — exactly 2 on an unbounded hex grid (the two hexes forming a triangle with each of `a`/`b`), fewer at a board edge. See findAdjacentRhombusCluster below. */
function commonNeighbors(state: GameState, a: Coordinate, b: Coordinate): Coordinate[] {
  const bNeighborKeys = new Set(neighborCoords(state.board, b).map(coordKey))
  return neighborCoords(state.board, a).filter((c) => bNeighborKeys.has(coordKey(c)))
}

/**
 * Finds a 4-hex rhombus of `playerId`'s own units of `kind`, one corner of
 * which is `coord` — see TransformEffect.requiredAdjacentRhombusOfKind's
 * doc comment (./unitContent.ts). A hex-grid rhombus is two adjacent hexes
 * (the "spine") plus the (exactly 2) hexes adjacent to both of them (the
 * "wings") — e.g. The Capital Tale's "control 4 adjacent Cities."
 *
 * `coord` may be either a spine hex or a wing hex of the rhombus found, so
 * this tries both roles: first, each neighbor of `coord` as the OTHER
 * spine hex (covers `coord` itself being a spine hex — the wings are then
 * that edge's 2 common neighbors); then, each pair of `coord`'s own
 * mutually-adjacent neighbors as the spine (covers `coord` being a wing —
 * the 4th hex is that spine edge's other common neighbor, since `coord`
 * itself is already one of the two). Returns the 3 other hexes (not
 * including `coord`) on the first valid rhombus found, or null if `coord`
 * isn't part of any.
 *
 * A candidate hex's unit doesn't count if it already resolved an action
 * this turn (`state.resolvedUnitIdsThisTurn`) — a City that already acted
 * can't also be folded into the Capital for free; the whole cluster must
 * still be un-acted. (Presence in that list is enough, not a cap check
 * against `UnitContent.activationsPerTurnByKind`, since every kind this
 * effect has ever targeted — City — activates at most once per turn.)
 */
export function findAdjacentRhombusCluster(state: GameState, playerId: string, coord: Coordinate, kind: string): Coordinate[] | null {
  const isOwnKind = (c: Coordinate) =>
    unitsAt(state, c).some((u) => u.ownerId === playerId && u.kind === kind && !state.resolvedUnitIdsThisTurn.includes(u.id))
  const neighbors = neighborCoords(state.board, coord)
  const ownNeighbors = neighbors.filter(isOwnKind)

  // coord as a spine hex: try each own-kind neighbor as the other spine hex.
  for (const spinePartner of ownNeighbors) {
    const wings = commonNeighbors(state, coord, spinePartner)
    if (wings.length === 2 && wings.every(isOwnKind)) {
      return [spinePartner, wings[0], wings[1]]
    }
  }

  // coord as a wing hex: try each mutually-adjacent pair of coord's own-kind
  // neighbors as the spine; the rhombus's 4th hex is that edge's other
  // common neighbor (besides coord itself).
  for (let i = 0; i < ownNeighbors.length; i++) {
    for (let j = i + 1; j < ownNeighbors.length; j++) {
      const [p, q] = [ownNeighbors[i], ownNeighbors[j]]
      if (!isAdjacent(state, p, q)) continue
      const wings = commonNeighbors(state, p, q)
      const other = wings.find((w) => coordKey(w) !== coordKey(coord))
      if (other && isOwnKind(other)) {
        return [p, q, other]
      }
    }
  }

  return null
}

/** Whether any unit of `kind` (any owner) currently exists anywhere on the board — see TransformEffect.forbiddenIfBoardHasKind. */
export function boardHasUnitOfKind(state: GameState, kind: string): boolean {
  return state.units.some((u) => u.kind === kind)
}

/**
 * The acting player's own unit of `kind`, on the far side of `targetCoord`
 * from `ownCoord` — its point-reflection through targetCoord (exactly 2
 * hex-steps from ownCoord, in the same direction ownCoord -> targetCoord) —
 * only if that far hex shares ownCoord's own terrain, so the two "ends" and
 * targetCoord in between count as aligned on a shared terrain — see
 * TransformEffect.requiredMirroredPartnerOfKind. A candidate doesn't count
 * if it already resolved an action this turn, same rule as
 * findAdjacentRhombusCluster above. Null if ownCoord/targetCoord aren't
 * adjacent, there's no tile on either end, the terrains don't match, or no
 * such unit exists.
 */
export function findMirroredPartnerUnit(
  state: GameState,
  playerId: string,
  ownCoord: Coordinate,
  targetCoord: Coordinate,
  kind: string,
): Unit | null {
  if (!isAdjacent(state, ownCoord, targetCoord)) return null
  const mirrorCoord: Coordinate = { q: 2 * targetCoord.q - ownCoord.q, r: 2 * targetCoord.r - ownCoord.r }
  if (!isAdjacent(state, targetCoord, mirrorCoord)) return null

  const ownTile = getTile(state.board, ownCoord)
  const mirrorTile = getTile(state.board, mirrorCoord)
  if (!ownTile || !mirrorTile || ownTile.terrain !== mirrorTile.terrain) return null

  return (
    unitsAt(state, mirrorCoord).find((u) => u.ownerId === playerId && u.kind === kind && !state.resolvedUnitIdsThisTurn.includes(u.id)) ?? null
  )
}

/**
 * The actual cost a `transform` action would charge right now — starts from
 * `effect.cost`, or `effect.costByOwnTerrain[terrain of ownCoord]` when set
 * and that terrain has an entry (see TransformEffect.costByOwnTerrain — e.g.
 * The Majestic Bridge Tale's Constructing the Bridge) — then adds, if
 * `extraCostPerBoardUnitCount` is set, that much extra per existing unit of
 * `countKind` anywhere on the board (any owner) — e.g. The Banks Tale's
 * Construct a Bank: 5 extra GP per Bank already in the World. `ownCoord`
 * (the acting unit's own hex) is omitted by callers with no
 * costByOwnTerrain to resolve. Shared by applyTransform below and
 * actionTargeting.ts's legalTransformTargets, same reasoning as
 * computeIncomeGold above.
 */
export function computeEffectiveTransformCost(state: GameState, effect: TransformEffect, ownCoord?: Coordinate): ActionCost {
  let baseCost = effect.cost
  if (effect.costByOwnTerrain && ownCoord) {
    const tile = getTile(state.board, ownCoord)
    const terrainCost = tile && effect.costByOwnTerrain[tile.terrain]
    if (terrainCost) baseCost = terrainCost
  }

  if (!effect.extraCostPerBoardUnitCount) return baseCost
  const { countKind, costPerUnit } = effect.extraCostPerBoardUnitCount
  const count = state.units.filter((u) => u.kind === countKind).length
  return {
    gold: (baseCost.gold ?? 0) + (costPerUnit.gold ?? 0) * count,
    wood: (baseCost.wood ?? 0) + (costPerUnit.wood ?? 0) * count,
    stone: (baseCost.stone ?? 0) + (costPerUnit.stone ?? 0) * count,
  }
}

// --- per-actionType handlers, one acting unit at a time ---------------------

/**
 * How much gold an `income` effect would actually pay out right now —
 * shared by applyIncome below and actionTargeting.ts's
 * isActionAvailableForUnit, so an Income action with nothing to pay (wrong
 * terrain, no qualifying neighbors) is computed identically wherever it's
 * asked about, rather than duplicating this arithmetic a second time just
 * to answer "would this do anything".
 */
export function computeIncomeGold(state: GameState, playerId: string, unit: Unit, effect: IncomeEffect): number {
  let gold = 0

  if (effect.goldByTerrain) {
    const tile = getTile(state.board, unit.coord)
    if (tile) gold += effect.goldByTerrain[tile.terrain] ?? 0
  }

  if (effect.goldPerAdjacentOwnUnit !== undefined) {
    const exclude = new Set(effect.excludeUnitTypes ?? [])
    const nearby = effect.maxDistance ? unitsWithinDistance(state, unit.coord, effect.maxDistance) : adjacentUnits(state, unit.coord)
    const count = nearby.filter((u) => u.ownerId === playerId && !exclude.has(u.kind)).length
    gold += count * effect.goldPerAdjacentOwnUnit
  }

  if (effect.goldPerAdjacentUnit) {
    // Merchant is the only unit kind that can ever end a move stacked onto
    // another unit (canEndMoveOnUnitTypes: ['city'] in units.json) — so a
    // Merchant sitting on a City's hex counts that City too, same as one on
    // a truly neighboring hex; only `adjacentUnits` would silently drop it.
    const nearby = [...adjacentUnits(state, unit.coord), ...unitsAt(state, unit.coord).filter((u) => u.id !== unit.id)]
    for (const neighbor of nearby) {
      const table = neighbor.ownerId === playerId ? effect.goldPerAdjacentUnit.own : effect.goldPerAdjacentUnit.enemy
      gold += table?.[neighbor.kind] ?? 0
    }
  }

  if (effect.goldByTerrainScaledByBoardUnitCount) {
    const { ratePerTerrain, countKind } = effect.goldByTerrainScaledByBoardUnitCount
    const ownsCountKind = state.units.some((u) => u.kind === countKind && u.ownerId === playerId)
    if (ownsCountKind) {
      const tile = getTile(state.board, unit.coord)
      const rate = tile ? ratePerTerrain[tile.terrain] ?? 0 : 0
      if (rate > 0) {
        const totalOnBoard = state.units.filter((u) => u.kind === countKind).length
        gold += rate * (1 + totalOnBoard)
      }
    }
  }

  return gold
}

function applyIncome(
  state: GameState,
  playerId: string,
  unit: Unit,
  effect: IncomeEffect,
  resourceCaps: Partial<Record<keyof Resources, number | null>>,
): GameState {
  return creditResource(state, playerId, 'gold', computeIncomeGold(state, playerId, unit, effect), resourceCaps)
}

/** What a `produce` effect would actually pay out on the unit's current tile, or undefined if its terrain isn't in `resourceByTerrain` at all — shared with isActionAvailableForUnit, same reasoning as computeIncomeGold above. */
export function computeProduceAmounts(state: GameState, unit: Unit, effect: ProduceEffect): Partial<Record<keyof Resources, number>> | undefined {
  const tile = getTile(state.board, unit.coord)
  if (!tile) return undefined
  return effect.resourceByTerrain[tile.terrain]
}

function applyProduce(
  state: GameState,
  playerId: string,
  unit: Unit,
  effect: ProduceEffect,
  resourceCaps: Partial<Record<keyof Resources, number | null>>,
): GameState {
  const amounts = computeProduceAmounts(state, unit, effect)
  if (!amounts) return state

  let nextState = state
  for (const key of ['gold', 'wood', 'stone'] as const) {
    const amount = amounts[key]
    if (amount) nextState = creditResource(nextState, playerId, key, amount, resourceCaps)
  }
  return nextState
}

/**
 * How much gold a Ship's `trade` effect would actually pay out — per
 * ruling, no own/enemy split, goldPerCity per City adjacent to any hex in
 * the Ship's whole contiguous sea area (every water hex reachable from the
 * Ship without leaving water), not just the hex the Ship itself sits on. A
 * City counts even if it sits across a cliff edge from the water — cliffs
 * block *movement/targeting* between hexes, not this area-wide adjacency
 * scan. Each City is counted once no matter how many sea hexes it borders.
 * Shared with isActionAvailableForUnit, same reasoning as
 * computeIncomeGold above.
 */
export function computeTradeGold(state: GameState, unit: Unit, effect: TradeEffect): number {
  const seaArea = connectedTerrainRegion(state.board, unit.coord)
  const cityIds = new Set<string>()
  for (const coord of seaArea) {
    for (const neighbor of adjacentUnits(state, coord)) {
      // Per ruling (The Capital Tale): "for Trade ... actions of Ships,
      // ... the Capital counts as a normal City" — 'capital' is a Tale
      // companion kind unknown to the base game, hardcoded here same as
      // CREATABLE_KINDS_BY_TERRAIN's 'port' above.
      if (neighbor.kind === 'city' || neighbor.kind === 'capital') cityIds.add(neighbor.id)
    }
  }
  return cityIds.size * effect.goldPerCity
}

function applyTrade(
  state: GameState,
  playerId: string,
  unit: Unit,
  effect: TradeEffect,
  resourceCaps: Partial<Record<keyof Resources, number | null>>,
): GameState {
  return creditResource(state, playerId, 'gold', computeTradeGold(state, unit, effect), resourceCaps)
}

/**
 * How much gold a `region-unit-count-income` effect would actually pay out
 * — goldPerUnit per unit of a countKinds kind located anywhere within the
 * acting unit's whole connected terrain region (any owner, including the
 * acting unit's own kind/self — e.g. a Port counts itself as one of the
 * Ports in its Sea Region). Shared with isActionAvailableForUnit, same
 * reasoning as computeIncomeGold/computeTradeGold above.
 */
export function computeRegionUnitCountGold(state: GameState, unit: Unit, effect: RegionUnitCountIncomeEffect): number {
  const region = connectedTerrainRegion(state.board, unit.coord)
  const regionKeys = new Set(region.map(coordKey))
  const count = state.units.filter((u) => effect.countKinds.includes(u.kind) && regionKeys.has(coordKey(u.coord))).length
  return count * effect.goldPerUnit
}

function applyRegionUnitCountIncome(
  state: GameState,
  playerId: string,
  unit: Unit,
  effect: RegionUnitCountIncomeEffect,
  resourceCaps: Partial<Record<keyof Resources, number | null>>,
): GameState {
  return creditResource(state, playerId, 'gold', computeRegionUnitCountGold(state, unit, effect), resourceCaps)
}

/**
 * Creates a unit on the ACTING unit's own hex — for a companion piece
 * whose hex the acting unit itself already occupies, so the normal
 * create/transform "target hex must be empty" rule can't apply (see
 * SiteCreateEffect's doc comment). Legality is "no current occupant OTHER
 * than the acting unit itself has a kind in blockedByKinds," not "hex must
 * be empty." Still respects the target kind's terrain eligibility
 * (isCreationAllowedOnTerrain) and supply cap, same as create/transform.
 */
function applySiteCreate(state: GameState, playerId: string, unit: Unit, effect: SiteCreateEffect, content: UnitContent): GameState {
  const otherOccupants = unitsAt(state, unit.coord).filter((u) => u.id !== unit.id)
  if (otherOccupants.some((u) => effect.blockedByKinds.includes(u.kind))) return state
  const tile = getTile(state.board, unit.coord)
  if (!tile || !isCreationAllowedOnTerrain(effect.targetUnit, tile.terrain)) return state
  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return state

  const afterCost = tryPayCost(state, playerId, effect.cost)
  if (!afterCost) return state

  const { id, idSequence } = nextSequenceId(afterCost, 'created_unit')
  const newUnit: Unit = {
    id,
    ownerId: playerId,
    kind: effect.targetUnit,
    coord: unit.coord,
    movement: content.movementByKind[effect.targetUnit] ?? { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
  }
  return { ...afterCost, idSequence, units: [...afterCost.units, newUnit] }
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

/** Per ruling: like create, an 'adj'-location transform can never cross a cliff, regardless of the acting unit's own movement capability — unless the effect explicitly opts out via TransformEffect.ignoresCliff (see ./unitContent.ts). */
function applyTransform(state: GameState, playerId: string, unit: Unit, effect: TransformEffect, targetCoord: Coordinate | undefined, content: UnitContent): GameState {
  const resolvedTargetCoord = effect.targetHex.location === 'self' ? unit.coord : targetCoord
  if (!resolvedTargetCoord) return state

  const targetTile = getTile(state.board, resolvedTargetCoord)
  if (!targetTile || !effect.targetHex.terrainType.includes(targetTile.terrain)) return state
  if (!isCreationAllowedOnTerrain(effect.targetUnit, targetTile.terrain)) return state
  if (effect.requiredAdjacentTerrain && !hasAdjacentTerrain(state, unit.coord, effect.requiredAdjacentTerrain)) return state
  if (effect.requiredAdjacentOwnUnitKind && !hasAdjacentOwnUnitKind(state, playerId, unit.coord, effect.requiredAdjacentOwnUnitKind)) return state
  if (effect.requiredOwnKindCount && !hasOwnKindCountAtLeast(state, playerId, effect.requiredOwnKindCount.kind, effect.requiredOwnKindCount.atLeast)) return state
  if (effect.forbiddenIfBoardHasKind && boardHasUnitOfKind(state, effect.forbiddenIfBoardHasKind)) return state

  if (effect.targetHex.location === 'adj') {
    if (!isAdjacent(state, unit.coord, resolvedTargetCoord)) return state
    if (!isTransformTargetAvailable(state, resolvedTargetCoord, effect.allowedOccupantKinds)) return state
    if (!effect.ignoresCliff && crossesCliff(state, unit.coord, resolvedTargetCoord, content.terrainLevels)) return state
  }

  let clusterMateCoords: Coordinate[] = []
  if (effect.requiredAdjacentRhombusOfKind) {
    const cluster = findAdjacentRhombusCluster(state, playerId, unit.coord, effect.requiredAdjacentRhombusOfKind)
    if (!cluster) return state
    clusterMateCoords = cluster
  }

  let partnerUnit: Unit | undefined
  if (effect.requiredMirroredPartnerOfKind) {
    const partner = findMirroredPartnerUnit(state, playerId, unit.coord, resolvedTargetCoord, effect.requiredMirroredPartnerOfKind)
    if (!partner) return state
    partnerUnit = partner
  }

  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return state

  const afterCost = tryPayCost(state, playerId, computeEffectiveTransformCost(state, effect, unit.coord))
  if (!afterCost) return state

  const { id, idSequence } = nextSequenceId(afterCost, 'created_unit')
  const newUnit: Unit = {
    id,
    ownerId: playerId,
    kind: effect.targetUnit,
    coord: resolvedTargetCoord,
    movement: content.movementByKind[effect.targetUnit] ?? { isMobile: false, terrains: [], canCrossCliffs: false },
    traits: [],
    ...(partnerUnit ? { connectedNeighborCoords: [unit.coord, partnerUnit.coord] as [Coordinate, Coordinate] } : {}),
  }

  const clusterMateKeys = new Set(clusterMateCoords.map(coordKey))
  const units = afterCost.units.filter((u) => {
    if (effect.destroySelf && u.id === unit.id) return false
    if (effect.requiredAdjacentRhombusOfKind && u.kind === effect.requiredAdjacentRhombusOfKind && u.ownerId === playerId && clusterMateKeys.has(coordKey(u.coord))) return false
    if (partnerUnit && u.id === partnerUnit.id) return false
    return true
  })
  return { ...afterCost, idSequence, units: [...units, newUnit] }
}

/**
 * Per ruling: convert can never cross a cliff either (same rule as
 * create/transform), unless the effect opts out via
 * ConvertEffect.ignoresCliff (e.g. Temple's Convert Enemy Unit converts by
 * faith rather than physical access) — but only meaningful at the default
 * adjacent range, since a cliff is a single hexside between two adjacent
 * hexes; a longer ConvertEffect.maxDistance (e.g. The Cathedral Tale, range
 * 2) has no single edge to check, so the cliff rule is skipped there
 * entirely. Covers two shapes: 'enemy' steals an enemy unit outright (kind
 * unchanged — e.g. Temple's Convert Enemy Unit); 'own' upgrades one of
 * the acting player's own units into a different kind in place (e.g. a
 * City converting an adjacent Nomad into a Merchant/Mountaineer) — see
 * ConvertEffect's doc comment.
 */
function applyConvert(state: GameState, playerId: string, unit: Unit, effect: ConvertEffect, targetCoord: Coordinate | undefined, content: UnitContent): GameState {
  if (!targetCoord) return state
  const maxDistance = effect.maxDistance ?? 1
  if (!isWithinDistance(state, unit.coord, targetCoord, maxDistance)) return state
  if (!effect.ignoresCliff && maxDistance <= 1 && crossesCliff(state, unit.coord, targetCoord, content.terrainLevels)) return state

  const targetUnit = unitsAt(state, targetCoord).find((u) =>
    effect.targetOwner === 'own'
      ? u.ownerId === playerId && (!effect.requiredTargetKind || u.kind === effect.requiredTargetKind)
      : u.ownerId !== playerId,
  )
  if (!targetUnit) return state

  if (effect.targetMobileOnly && !content.movementByKind[targetUnit.kind]?.isMobile) return state

  const resultKind = effect.resultUnit ?? targetUnit.kind
  // See legalConvertTargets' matching comment (./actionTargeting.ts): the
  // supply-cap check must fire whenever the target becomes a *new* unit of
  // resultKind under playerId's count, which includes an ownership change
  // (targetOwner: 'enemy') even when resultKind equals the target's own
  // kind — e.g. Temple's Convert Enemy Unit, which has no resultUnit
  // override and so was never actually checking the capturing player's
  // supply at all.
  const becomesNewUnitForPlayer = targetUnit.ownerId !== playerId || resultKind !== targetUnit.kind
  if (becomesNewUnitForPlayer && hasReachedSupplyCap(state, playerId, resultKind, content.unitSupplyCaps)) return state

  const cost = effect.costByTargetKind?.[targetUnit.kind] ?? effect.cost
  const afterCost = tryPayCost(state, playerId, cost)
  if (!afterCost) return state

  const units = afterCost.units.map((u) =>
    u.id === targetUnit.id ? { ...u, ownerId: playerId, kind: resultKind, movement: content.movementByKind[resultKind] ?? u.movement } : u,
  )
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

  // `state.units`' order doubles as render/paint order (HexBoard.tsx draws
  // later entries over earlier ones) — moving a unit in place would leave a
  // unit that just arrived on a shared hex (e.g. a Merchant landing on a
  // City) painted underneath a unit that's simply been on the board longer.
  // Move it to the end of the array so the unit that just entered a hex is
  // always the one on top, same as a freshly created unit already is.
  const units = [...state.units.filter((u) => u.id !== unit.id), { ...unit, coord: targetCoord }]
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
      case 'site-create':
        nextState = applySiteCreate(nextState, playerId, unit, effect, content)
        break
      case 'region-unit-count-income':
        nextState = applyRegionUnitCountIncome(nextState, playerId, unit, effect, content.resourceCaps)
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
  return nextState === state ? nextState : syncCardZonesWithBoard(nextState, content.companionKindsByCardKind)
}
