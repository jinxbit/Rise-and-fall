import type { Coordinate } from './types'

// The action set matches the round sequence in ./round.ts: CHOOSE_CARD
// (phase 1, simultaneous), RESOLVE_UNIT_ACTION (phase 2, turn order —
// movement is one of the actions resolved here, via a unit kind's 'move'
// effect; see applyMove in ./unitActions.ts, not a standalone action type),
// MOVE_TO_DECLINE (phase 3, turn order, only reachable when triggered),
// PURCHASE_CARD / PASS_PURCHASE (phase 4, turn order). Recycle-check and
// round-end are automatic engine bookkeeping, not player actions.

export interface ChooseCardAction {
  type: 'CHOOSE_CARD'
  playerId: string
  cardId: string
}

export interface ResolveUnitActionAction {
  type: 'RESOLVE_UNIT_ACTION'
  playerId: string
  /** Which of the chosen card's unit-kind actions to perform — an id from content/units.json's actions[]. */
  actionId: string
  /**
   * Per-unit target hex, keyed by acting unit id, for an action that needs
   * one (create, an 'adj'-location transform, convert). A unit missing an
   * entry here simply does nothing this turn — the action still applies to
   * every other unit of the kind. Omitted entirely for actions that need no
   * target (income/produce/trade/trade-resource, and a 'self'-location
   * transform).
   */
  targets?: Record<string, Coordinate>
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
  | ChooseCardAction
  | ResolveUnitActionAction
  | MoveToDeclineAction
  | PurchaseCardAction
  | PassPurchaseAction
