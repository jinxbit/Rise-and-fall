import type { Coordinate } from './types'

// The action set matches the round sequence in ./round.ts: CHOOSE_CARD
// (phase 1, simultaneous), RESOLVE_UNIT_ACTION (phase 2, turn order),
// MOVE_TO_DECLINE (phase 3, turn order, only reachable when triggered),
// PURCHASE_CARD / PASS_PURCHASE (phase 4, turn order). Recycle-check and
// round-end are automatic engine bookkeeping, not player actions.

export interface MoveUnitAction {
  type: 'MOVE_UNIT'
  playerId: string
  unitId: string
  to: Coordinate
}

export interface ChooseCardAction {
  type: 'CHOOSE_CARD'
  playerId: string
  cardId: string
}

/**
 * What the player chose for one acting unit, for an action whose effect
 * needs input beyond "do it": a target hex (create, an 'adj'-location
 * transform, convert) or a resource + buy/sell choice (trade-resource).
 * Only the field(s) the action actually needs are read.
 */
export interface UnitActionTarget {
  coord?: Coordinate
  resource?: 'gold' | 'wood' | 'stone'
  mode?: 'buy' | 'sell'
}

export interface ResolveUnitActionAction {
  type: 'RESOLVE_UNIT_ACTION'
  playerId: string
  /** Which of the chosen card's unit-kind actions to perform — an id from content/units.json's actions[]. */
  actionId: string
  /**
   * Per-unit input, keyed by acting unit id, for actions that need one
   * (see UnitActionTarget). A unit missing an entry here (or missing the
   * field the action needs from its entry) simply does nothing this turn
   * — the action still applies to every other unit of the kind. Omitted
   * entirely for actions that need no input (income/produce/trade, and a
   * 'self'-location transform).
   */
  targets?: Record<string, UnitActionTarget>
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
  | MoveUnitAction
  | ChooseCardAction
  | ResolveUnitActionAction
  | MoveToDeclineAction
  | PurchaseCardAction
  | PassPurchaseAction
