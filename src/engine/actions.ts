import type { Coordinate } from './types'

// The full action set (movement, card play, combat, etc.) will be fleshed
// out once the exact rules are specified. END_TURN is implemented now so
// the turn-order/active-player machinery is exercised end to end; the rest
// are typed placeholders that applyAction() rejects with NOT_IMPLEMENTED.

export interface EndTurnAction {
  type: 'END_TURN'
  playerId: string
}

export interface MoveUnitAction {
  type: 'MOVE_UNIT'
  playerId: string
  unitId: string
  to: Coordinate
}

export interface PlayCardAction {
  type: 'PLAY_CARD'
  playerId: string
  cardId: string
}

export type Action = EndTurnAction | MoveUnitAction | PlayCardAction
