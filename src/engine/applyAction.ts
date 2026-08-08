import type { Action } from './actions'
import { moveCard } from './cards'
import { appendLog } from './log'
import type { GameState, Player } from './types'

export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string }

/**
 * Applies a single validated action to a game state, returning a new state.
 * Never mutates the input. This is the ONLY place game rules are allowed to
 * run — UI and network layers must treat GameState as opaque and always
 * route changes through here so every client (live/async/hotseat) enforces
 * identical rules.
 */
export function applyAction(state: GameState, action: Action): ActionResult {
  if (state.status !== 'active') {
    return { ok: false, error: `Game is not active (status: ${state.status})` }
  }

  switch (action.type) {
    case 'END_TURN':
      return applyEndTurn(state, action.playerId)
    case 'MOVE_UNIT':
      return { ok: false, error: 'NOT_IMPLEMENTED: MOVE_UNIT' }
    case 'PLAY_CARD':
      return applyPlayCard(state, action.playerId, action.cardId)
    default: {
      const exhaustive: never = action
      return { ok: false, error: `Unknown action: ${JSON.stringify(exhaustive)}` }
    }
  }
}

function applyEndTurn(state: GameState, playerId: string): ActionResult {
  if (state.activePlayerId !== playerId) {
    return { ok: false, error: 'It is not this player\'s turn' }
  }
  if (state.turnOrder.length === 0) {
    return { ok: false, error: 'Game has no turn order configured' }
  }

  const currentIndex = state.turnOrder.indexOf(playerId)
  const nextIndex = (currentIndex + 1) % state.turnOrder.length
  const nextPlayerId = state.turnOrder[nextIndex]
  const wrapped = nextIndex === 0

  const nextState: GameState = {
    ...state,
    turn: wrapped ? state.turn + 1 : state.turn,
    activePlayerId: nextPlayerId,
    cardPlayedThisTurn: false,
  }

  return {
    ok: true,
    state: { ...nextState, log: appendLog(nextState, playerId, `Player ${playerId} ended their turn`) },
  }
}

/**
 * Implements rules 3, 4, 9, 10, 11: play the one card allowed per turn from
 * hand, discard it, and — if that empties the hand — recycle the discard
 * back into the hand and hand "first player" to whoever is next.
 */
function applyPlayCard(state: GameState, playerId: string, cardId: string): ActionResult {
  if (state.activePlayerId !== playerId) {
    return { ok: false, error: 'It is not this player\'s turn' }
  }
  if (state.cardPlayedThisTurn) {
    return { ok: false, error: 'Only a single card can be played each turn' }
  }

  const playerIndex = state.players.findIndex((p) => p.id === playerId)
  if (playerIndex === -1) {
    return { ok: false, error: `Unknown player: ${playerId}` }
  }
  const player = state.players[playerIndex]

  if (!player.handCardIds.includes(cardId)) {
    return { ok: false, error: 'Card can only be played from hand' }
  }
  const card = state.cards[cardId]
  if (!card) {
    return { ok: false, error: `Unknown card: ${cardId}` }
  }

  // Rule 3 then 4: hand -> currently played -> discard.
  let nextPlayer = moveCard(player, cardId, 'currentlyPlayed')
  nextPlayer = moveCard(nextPlayer, cardId, 'discard')

  const players = [...state.players]
  players[playerIndex] = nextPlayer

  let nextState: GameState = { ...state, players, cardPlayedThisTurn: true }
  nextState = { ...nextState, log: appendLog(nextState, playerId, `Player ${playerId} played ${card.name}`) }

  return applyRecycleIfNeeded(nextState, playerIndex, playerId)
}

/** Rule 10 + 11: an empty hand pulls the whole discard back in, and the next player becomes first. */
function applyRecycleIfNeeded(state: GameState, playerIndex: number, playerId: string): ActionResult {
  const player = state.players[playerIndex]
  if (player.handCardIds.length > 0 || player.discardCardIds.length === 0) {
    return { ok: true, state }
  }

  const recycledPlayer: Player = {
    ...player,
    handCardIds: player.discardCardIds,
    discardCardIds: [],
  }
  const players = [...state.players]
  players[playerIndex] = recycledPlayer

  let nextState: GameState = { ...state, players }
  nextState = {
    ...nextState,
    log: appendLog(nextState, playerId, `Player ${playerId}'s discard was recycled into their hand`),
  }

  const currentIndex = nextState.turnOrder.indexOf(playerId)
  if (currentIndex !== -1 && nextState.turnOrder.length > 0) {
    const nextFirstIndex = (currentIndex + 1) % nextState.turnOrder.length
    const turnOrder = [...nextState.turnOrder.slice(nextFirstIndex), ...nextState.turnOrder.slice(0, nextFirstIndex)]
    const nextFirstPlayerId = turnOrder[0]
    nextState = {
      ...nextState,
      turnOrder,
      log: appendLog(nextState, nextFirstPlayerId, `Player ${nextFirstPlayerId} becomes the first player`),
    }
  }

  return { ok: true, state: nextState }
}
