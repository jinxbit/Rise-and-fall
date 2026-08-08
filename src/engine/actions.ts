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

export interface ResolveUnitActionAction {
  type: 'RESOLVE_UNIT_ACTION'
  playerId: string
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
