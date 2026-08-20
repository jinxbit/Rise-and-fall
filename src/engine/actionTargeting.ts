import { coordsWithinDistance, getTile, neighborCoords } from './board'
import { legalMoveDestinations } from './movement'
import { wouldGainResource } from './resources'
import {
  boardHasUnitOfKind,
  canAffordCost,
  computeEffectiveTransformCost,
  computeIncomeGold,
  computeProduceAmounts,
  computeRegionUnitCountGold,
  computeTradeGold,
  crossesCliff,
  findAdjacentRhombusCluster,
  findMirroredPartnerUnit,
  hasAdjacentOwnUnitKind,
  hasAdjacentTerrain,
  hasOwnKindCountAtLeast,
  hasReachedSupplyCap,
  isCreationAllowedOnTerrain,
  isTransformTargetAvailable,
  unitsAt,
} from './unitActions'
import type { ActionCost, ConvertEffect, CreateEffect, SiteCreateEffect, TransformEffect, UnitAction, UnitContent } from './unitContent'
import type { Coordinate, GameState, Resources, Unit } from './types'

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
  if (!player || !canAffordCost(player.resources, computeEffectiveTransformCost(state, effect, unit.coord))) return []
  if (hasReachedSupplyCap(state, playerId, effect.targetUnit, content.unitSupplyCaps)) return []
  if (effect.requiredAdjacentTerrain && !hasAdjacentTerrain(state, unit.coord, effect.requiredAdjacentTerrain)) return []
  if (effect.requiredAdjacentOwnUnitKind && !hasAdjacentOwnUnitKind(state, playerId, unit.coord, effect.requiredAdjacentOwnUnitKind)) return []
  if (effect.requiredOwnKindCount && !hasOwnKindCountAtLeast(state, playerId, effect.requiredOwnKindCount.kind, effect.requiredOwnKindCount.atLeast)) return []
  if (effect.forbiddenIfBoardHasKind && boardHasUnitOfKind(state, effect.forbiddenIfBoardHasKind)) return []
  if (effect.requiredAdjacentRhombusOfKind && !findAdjacentRhombusCluster(state, playerId, unit.coord, effect.requiredAdjacentRhombusOfKind)) return []

  if (effect.targetHex.location === 'self') {
    const tile = getTile(state.board, unit.coord)
    if (!tile || !effect.targetHex.terrainType.includes(tile.terrain)) return []
    return isCreationAllowedOnTerrain(effect.targetUnit, tile.terrain) ? [unit.coord] : []
  }

  return neighborCoords(state.board, unit.coord).filter((coord) => {
    const tile = getTile(state.board, coord)
    if (!tile || !effect.targetHex.terrainType.includes(tile.terrain)) return false
    if (!isCreationAllowedOnTerrain(effect.targetUnit, tile.terrain)) return false
    if (!isTransformTargetAvailable(state, coord, effect.allowedOccupantKinds)) return false
    if (!effect.ignoresCliff && crossesCliff(state, unit.coord, coord, content.terrainLevels)) return false
    if (effect.requiredMirroredPartnerOfKind && !findMirroredPartnerUnit(state, playerId, unit.coord, coord, effect.requiredMirroredPartnerOfKind)) return false
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

  const maxDistance = effect.maxDistance ?? 1
  const candidates = maxDistance === 1 ? neighborCoords(state.board, unit.coord) : coordsWithinDistance(state.board, unit.coord, maxDistance)

  return candidates.filter((coord) => {
    // See applyConvert's matching comment (./unitActions.ts): a cliff edge
    // only exists between adjacent hexes, so this only ever applies at the
    // default range, and effect.ignoresCliff opts a convert action out of
    // the rule entirely (e.g. Temple's Convert Enemy Unit).
    if (!effect.ignoresCliff && maxDistance <= 1 && crossesCliff(state, unit.coord, coord, content.terrainLevels)) return false
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

/**
 * One idle unit that could still help pay for another unit's costed action
 * (create/transform/convert/site-create/a Merchant's buy trade-resource) —
 * see findSupportCandidates/isActionSupportable below (issue #147's
 * "supporting actions" QoL request). `unit`/`action` is the candidate's own
 * resource-gathering pick (produce/income/trade/region-unit-count-income —
 * whichever of its kind's actions gathers resources), `preview` its
 * computeActionOutcomePreview right now.
 */
export interface SupportCandidate {
  unit: Unit
  action: UnitAction
  preview: Partial<Resources>
}

/**
 * Idle units of `actingUnit`'s own kind — unresolved this turn, excluding
 * `actingUnit` itself — that could still perform one of that kind's
 * resource-gathering actions (produce/income/trade/region-unit-count-income)
 * right now. Deliberately same-kind only: per ruling (issue #147), this
 * doesn't touch the "only units of the played card's kind may act" rule —
 * it just lets OTHER idle units of that same kind cover a shortfall (e.g. an
 * idle Nomad producing Wood so another Nomad can afford Transform to City;
 * an idle City generating Income so another City can afford Create
 * Merchant), the same as a player could already do by manually resolving
 * those units' actions first in an earlier RESOLVE_UNIT_ACTION submission —
 * see UnitActionAssignment's doc comment (../engine/actions.ts) on ordered,
 * one-at-a-time resolution. This is purely a query for the UI to build that
 * multi-unit submission automatically; it changes no rule and needs no
 * changes to how RESOLVE_UNIT_ACTION itself resolves.
 */
export function findSupportCandidates(state: GameState, playerId: string, actingUnit: Unit, content: UnitContent): SupportCandidate[] {
  const gatheringActions = (content.actionsByKind[actingUnit.kind] ?? []).filter(
    (a) => a.effect.actionType === 'produce' || a.effect.actionType === 'income' || a.effect.actionType === 'trade' || a.effect.actionType === 'region-unit-count-income',
  )
  if (gatheringActions.length === 0) return []

  const idleUnits = state.units.filter(
    (u) => u.ownerId === playerId && u.kind === actingUnit.kind && u.id !== actingUnit.id && !state.resolvedUnitIdsThisTurn.includes(u.id),
  )

  const candidates: SupportCandidate[] = []
  for (const unit of idleUnits) {
    for (const action of gatheringActions) {
      if (!isActionAvailableForUnit(state, playerId, unit, action, content)) continue
      const preview = computeActionOutcomePreview(state, playerId, unit, action)
      if (preview) candidates.push({ unit, action, preview })
    }
  }
  return candidates
}

/**
 * A hypothetical state where `playerId`'s resources have already received
 * every one of `candidates`' previews — used only to ask "if these support
 * units produced first, would the primary action then be legal/affordable"
 * (isActionSupportable below, and RoundView's legal-target preview while
 * choosing where to place a supported action) by reusing the exact same
 * legality functions (legalCreateTargets/legalTransformTargets/
 * legalConvertTargets/isActionAvailableForUnit) real resolution already
 * trusts, rather than duplicating their cost/target rules a second time.
 * Optimistic on purpose (ignores resourceBank depletion/caps across
 * multiple candidates producing "simultaneously," and each candidate's own
 * cap is only checked against the current, not-yet-boosted state) — the
 * real RESOLVE_UNIT_ACTION submission this drives always resolves each
 * assignment in order against the true state and safely no-ops anything
 * that turns out short, same as any other action (see
 * applyResolveUnitAction, ../engine/applyAction.ts), so an occasional
 * over-optimistic preview here can never let a player actually spend
 * resources that don't exist — worst case the primary action silently
 * fails to resolve, exactly like any other unaffordable action today.
 */
export function boostedStateForSupport(state: GameState, playerId: string, candidates: SupportCandidate[]): GameState {
  const player = state.players.find((p) => p.id === playerId)
  if (!player) return state
  const resources = { ...player.resources }
  for (const candidate of candidates) {
    for (const key of ['gold', 'wood', 'stone'] as const) {
      const amount = candidate.preview[key]
      if (amount && amount > 0) resources[key] += amount
    }
  }
  const players = state.players.map((p) => (p.id === playerId ? { ...p, resources } : p))
  return { ...state, players }
}

/**
 * Whether `unit` can't afford/perform `action` right now, but COULD if some
 * of its idle same-kind teammates (findSupportCandidates above) produced
 * resources first — drives the radial menu's third "supportable" visual
 * state (colored distinctly from both a normal and a fully-disabled option
 * — see ActionMenuOption.supportable in ../components/HexBoard.tsx) and
 * gates whether RoundView offers the "choose units to cover the shortfall"
 * follow-up step. False whenever the action is already available (nothing
 * to support) or no idle same-kind unit could gather anything right now.
 */
export function isActionSupportable(state: GameState, playerId: string, unit: Unit, action: UnitAction, content: UnitContent): boolean {
  if (isActionAvailableForUnit(state, playerId, unit, action, content)) return false
  const candidates = findSupportCandidates(state, playerId, unit, content)
  if (candidates.length === 0) return false
  const boosted = boostedStateForSupport(state, playerId, candidates)
  return isActionAvailableForUnit(boosted, playerId, unit, action, content)
}

/**
 * `candidates` filtered down to only those that would still help close the
 * gap between `action`'s cost and what `playerId` actually has once every
 * unit in `selected` has already produced (see boostedStateForSupport) —
 * drives which units RoundView actually highlights as pickable on the map
 * for its 'supporting' UI mode (issue #147 follow-up), so a unit that could
 * only ever contribute a resource the player is already sitting on enough
 * of (e.g. transforming to a City that costs 1 wood + 1 stone while the
 * player already holds 1 wood) is never offered as if picking it would
 * still help. Always excludes anything already in `selected` — reselecting
 * an already-picked unit has nothing left to contribute either. Reuses
 * computeActionOutcomePreview for `action`'s own cost (its negative
 * entries), so this can't drift from what the preview already shows the
 * player for that action, and reuses boostedStateForSupport for the same
 * "picked so far" bookkeeping isActionSupportable already trusts.
 */
export function neededSupportCandidates(
  state: GameState,
  playerId: string,
  unit: Unit,
  action: UnitAction,
  candidates: SupportCandidate[],
  selected: SupportCandidate[],
): SupportCandidate[] {
  const cost = computeActionOutcomePreview(state, playerId, unit, action) ?? {}
  const boosted = boostedStateForSupport(state, playerId, selected)
  const boostedPlayer = boosted.players.find((p) => p.id === playerId)
  if (!boostedPlayer) return []
  const selectedIds = new Set(selected.map((c) => c.unit.id))
  return candidates.filter((candidate) => {
    if (selectedIds.has(candidate.unit.id)) return false
    return (['gold', 'wood', 'stone'] as const).some((key) => {
      const costAmount = -(cost[key] ?? 0)
      if (costAmount <= 0) return false
      return costAmount - boostedPlayer.resources[key] > 0 && (candidate.preview[key] ?? 0) > 0
    })
  })
}

/**
 * How much more of each resource `unit` would still need to afford `action`
 * right now — e.g. `{ stone: 2 }` for a Transform to City costing 3 Stone
 * while the player holds 1. Drives the radial menu's concise shortfall text
 * on a "supportable" option (ActionMenuOption.shortfall, ../components/
 * HexBoard.tsx — issue #224's request to explain the gap in words, not just
 * an amber border), so the player knows what's missing before picking
 * support units. Reuses computeActionOutcomePreview's cost the same way
 * neededSupportCandidates does, so the two can't drift apart. Undefined once
 * nothing is short, mirroring computeActionOutcomePreview's own convention.
 */
export function computeActionShortfall(state: GameState, playerId: string, unit: Unit, action: UnitAction): Partial<Resources> | undefined {
  const player = state.players.find((p) => p.id === playerId)
  if (!player) return undefined
  const cost = computeActionOutcomePreview(state, playerId, unit, action) ?? {}
  const entries = (['gold', 'wood', 'stone'] as const)
    .map((key): [keyof Resources, number] => [key, -(cost[key] ?? 0) - player.resources[key]])
    .filter(([, shortfall]) => shortfall > 0)
  return entries.length > 0 ? (Object.fromEntries(entries) as Partial<Resources>) : undefined
}

/** `cost`'s nonzero entries, negated — undefined if `cost` has nothing to spend, so a 0-cost action's preview omits an empty "-0" chip entirely. */
function negatedCost(cost: ActionCost): Partial<Resources> | undefined {
  const entries = (Object.entries(cost) as [keyof Resources, number | undefined][]).filter(([, amount]) => amount)
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries.map(([key, amount]) => [key, -(amount as number)])) as Partial<Resources>
}

/**
 * A best-effort preview of what resolving `action` right now would gain or
 * cost the acting player — drives the radial action menu's outcome icons
 * (see ActionMenuOption.outcome in ../components/HexBoard.tsx), reusing the
 * exact same compute functions the real resolution (./unitActions.ts) pays
 * out from, so the preview can't drift from what actually happens. Positive
 * amounts are a gain, negative a cost. Only ever covers what's knowable
 * without a target the player hasn't picked yet: income/produce/trade/
 * region-unit-count-income have no target at all, so their full gain shows;
 * trade-resource's buy/sell amounts are fixed regardless of target; create/
 * transform/site-create's `cost` is fixed before targeting (transform's can
 * still scale with board state — computeEffectiveTransformCost); convert's
 * `cost` can vary by the (not-yet-chosen) target's kind
 * (ConvertEffect.costByTargetKind), so only its listed base `cost` is shown
 * as an approximation. move has no resource outcome, so it returns
 * undefined, same as any effect with nothing to preview.
 */
export function computeActionOutcomePreview(state: GameState, playerId: string, unit: Unit, action: UnitAction): Partial<Resources> | undefined {
  const effect = action.effect
  switch (effect.actionType) {
    case 'income': {
      const gold = computeIncomeGold(state, playerId, unit, effect)
      return gold ? { gold } : undefined
    }
    case 'produce': {
      const amounts = computeProduceAmounts(state, unit, effect)
      if (!amounts) return undefined
      const entries = (Object.entries(amounts) as [keyof Resources, number | undefined][]).filter(([, amount]) => amount)
      return entries.length > 0 ? (Object.fromEntries(entries) as Partial<Resources>) : undefined
    }
    case 'trade': {
      const gold = computeTradeGold(state, unit, effect)
      return gold ? { gold } : undefined
    }
    case 'region-unit-count-income': {
      const gold = computeRegionUnitCountGold(state, unit, effect)
      return gold ? { gold } : undefined
    }
    case 'trade-resource': {
      const goldAmount = effect.goldPerResource * effect.resourceAmount
      return effect.mode === 'sell'
        ? { [effect.resource]: -effect.resourceAmount, gold: goldAmount }
        : { gold: -goldAmount, [effect.resource]: effect.resourceAmount }
    }
    case 'create':
    case 'site-create':
      return negatedCost(effect.cost)
    case 'transform':
      return negatedCost(computeEffectiveTransformCost(state, effect, unit.coord))
    case 'convert':
      return negatedCost(effect.cost)
    case 'move':
      return undefined
  }
}
