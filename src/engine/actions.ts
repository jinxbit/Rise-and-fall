import type { Coordinate } from './types'

// PLACE_TILE / PLACE_UNIT (see ./boardSetup.ts) are the only actions valid
// during `status: 'boardSetup'` — the one-time setup phase before round 1
// (seed the starting water tiles, players place the rest tier by tier,
// then place their three starting units) — every other action below
// requires `status: 'active'`, matching the round sequence in ./round.ts:
// CHOOSE_CARD (phase 1, simultaneous), RESOLVE_UNIT_ACTION (phase 2, turn
// order — movement is just another unit-kind action resolved here, like
// create/transform/convert; see applyMove in ./unitActions.ts),
// MOVE_TO_DECLINE (phase 3, simultaneous, only reachable when triggered),
// PURCHASE_CARD / PASS_PURCHASE (phase 4, turn order). Recycle-check and
// round-end are automatic engine bookkeeping, not player actions.

/**
 * Places one tile of the current tier (src/engine/boardGenerationContent.ts's
 * BoardGenerationContent.tiers[0] of whatever's left in GameState.
 * boardSetup.tileTierQueue) — `anchor` is the shape's own {0,0} cell's
 * target board coordinate, `rotationSteps` (0-5) rotates the shape 60°
 * per step before placement. The click/rotate/confirm interaction that
 * arrives at these two values is a client-side concern (the client can
 * preview locally with placedShapeCells()/isLegalTilePlacement() from
 * ./boardGeneration.ts, both pure) — the engine only ever sees the final
 * choice, submitted once, on confirm.
 */
export interface PlaceTileAction {
  type: 'PLACE_TILE'
  playerId: string
  anchor: Coordinate
  rotationSteps: number
}

/** Places one of the player's three starting units (kind: 'city' | 'nomad' | 'ship') at `coord`, during boardSetup's unit-placement sub-phase. */
export interface PlaceUnitAction {
  type: 'PLACE_UNIT'
  playerId: string
  unitKind: string
  coord: Coordinate
}

export interface ChooseCardAction {
  type: 'CHOOSE_CARD'
  playerId: string
  cardId: string
}

/** One acting unit's chosen action (an id from content/units.json's actions[] for the played card's kind) and, if that action needs one, its target hex. */
export interface UnitActionAssignment {
  unitId: string
  actionId: string
  target?: Coordinate
}

export interface ResolveUnitActionAction {
  type: 'RESOLVE_UNIT_ACTION'
  playerId: string
  /**
   * Ordered per-unit action assignments — resolved one at a time, in this
   * exact order, each against the state as it stands after every earlier
   * one in the list (not batched by action id). This is what lets one
   * unit's effect be visible to a later unit's action in the same
   * submission — e.g. a Nomad producing a resource, then a second Nomad
   * spending it to convert — matching whatever order the player actually
   * assigned them in. A unit not listed here (or given an id that isn't
   * one of the kind's actions) simply does nothing this round.
   */
  unitActions: UnitActionAssignment[]
}

export interface MoveToDeclineAction {
  type: 'MOVE_TO_DECLINE'
  playerId: string
  cardId: string
}

export interface PurchaseCardAction {
  type: 'PURCHASE_CARD'
  playerId: string
  cardId: string
}

export interface PassPurchaseAction {
  type: 'PASS_PURCHASE'
  playerId: string
}

export type Action =
  | PlaceTileAction
  | PlaceUnitAction
  | ChooseCardAction
  | ResolveUnitActionAction
  | MoveToDeclineAction
  | PurchaseCardAction
  | PassPurchaseAction
