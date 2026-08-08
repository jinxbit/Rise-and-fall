import { isDeclineTriggered } from './decline'
import { appendLog } from './log'
import type { GameState } from './types'

/** Round step 1: every player simultaneously picks a card; nobody is "active". */
export function beginSelectCardsPhase(state: GameState): GameState {
  return {
    ...state,
    roundPhase: 'selectCards',
    chosenCardIdByPlayerId: Object.fromEntries(state.players.map((p) => [p.id, null])),
    pendingPlayerIds: [...state.turnOrder],
    activePlayerId: null,
  }
}

/** Round step 2: resolve each player's chosen card, in turn order. */
export function beginActionsPhase(state: GameState): GameState {
  return {
    ...state,
    roundPhase: 'actions',
    pendingPlayerIds: [...state.turnOrder],
    activePlayerId: state.turnOrder[0] ?? null,
  }
}

/** Round step 3: every player moves one card from hand/discard to decline, in turn order. */
export function beginDeclinePhase(state: GameState): GameState {
  return {
    ...state,
    roundPhase: 'decline',
    pendingPlayerIds: [...state.turnOrder],
    activePlayerId: state.turnOrder[0] ?? null,
  }
}

/** Round step 4: every player may buy one card back from decline, or pass, in turn order. */
export function beginPurchasePhase(state: GameState): GameState {
  return {
    ...state,
    roundPhase: 'purchase',
    pendingPlayerIds: [...state.turnOrder],
    activePlayerId: state.turnOrder[0] ?? null,
  }
}

/** Once the actions phase finishes: rule 3 inserts the decline phase only if it was triggered this round. */
export function beginPostActionsPhase(state: GameState): GameState {
  return isDeclineTriggered(state) ? beginDeclinePhase(state) : beginPurchasePhase(state)
}

/**
 * Round steps 5 & 6, run automatically once the purchase phase finishes:
 * recycle any empty hand from discard, hand "first player" to the next
 * player if that happened, then start the next round. The game-end check
 * (step 6) isn't specified yet, so the round always continues past it —
 * flagged below for where it plugs in.
 */
export function finishRound(state: GameState): GameState {
  let anyRecycled = false
  const players = state.players.map((player) => {
    if (player.handCardIds.length === 0 && player.discardCardIds.length > 0) {
      anyRecycled = true
      return { ...player, handCardIds: player.discardCardIds, discardCardIds: [] }
    }
    return player
  })

  let nextState: GameState = { ...state, players }

  if (anyRecycled) {
    nextState = { ...nextState, log: appendLog(nextState, null, "A player's discard was recycled into their hand") }

    const turnOrder =
      nextState.turnOrder.length > 1 ? [...nextState.turnOrder.slice(1), nextState.turnOrder[0]] : nextState.turnOrder
    const nextFirstPlayerId = turnOrder[0] ?? null
    nextState = { ...nextState, turnOrder }
    if (nextFirstPlayerId) {
      nextState = {
        ...nextState,
        log: appendLog(nextState, nextFirstPlayerId, `Player ${nextFirstPlayerId} becomes the first player`),
      }
    }
  }

  // Round step 6, game-end half: no win condition is specified yet, so the
  // round always continues. Once one exists, check it here and — if met —
  // return { ...nextState, status: 'completed', winnerPlayerId: ... }
  // instead of starting the next round below.

  nextState = { ...nextState, turn: nextState.turn + 1 }
  nextState = { ...nextState, log: appendLog(nextState, null, `Round ${nextState.turn} begins`) }
  return beginSelectCardsPhase(nextState)
}
