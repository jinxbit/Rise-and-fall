import { appendLog } from './log'
import type { GameState, Resources } from './types'

/**
 * Rule: a player is eliminated if they have to play a card — choosing one
 * in the select-cards phase, or giving one up in the decline phase — and
 * have none available. They're removed from the board and turn order for
 * the rest of the game, and excluded from winning (callers of
 * determineWinners in ./victoryPoints.ts should pass only non-eliminated
 * player ids). Achievements they've already claimed are NOT revoked. All
 * of their gold/wood/stone is returned to the shared bank.
 */
export function eliminatePlayer(state: GameState, playerId: string): GameState {
  const playerIndex = state.players.findIndex((p) => p.id === playerId)
  if (playerIndex === -1 || state.players[playerIndex].eliminated) return state

  const eliminated = state.players[playerIndex]
  const players = [...state.players]
  players[playerIndex] = { ...eliminated, eliminated: true, resources: { gold: 0, wood: 0, stone: 0 } }

  const resourceBank: Resources = {
    gold: state.resourceBank.gold + eliminated.resources.gold,
    wood: state.resourceBank.wood + eliminated.resources.wood,
    stone: state.resourceBank.stone + eliminated.resources.stone,
  }

  const units = state.units.filter((u) => u.ownerId !== playerId)
  const turnOrder = state.turnOrder.filter((id) => id !== playerId)
  const pendingPlayerIds = state.pendingPlayerIds.filter((id) => id !== playerId)
  const activePlayerId = state.roundPhase === 'selectCards' ? null : (pendingPlayerIds[0] ?? null)

  let nextState: GameState = { ...state, players, units, turnOrder, pendingPlayerIds, activePlayerId, resourceBank }
  nextState = {
    ...nextState,
    log: appendLog(nextState, playerId, `Player ${playerId} was eliminated — no card available to play`),
  }
  return nextState
}

function hasNoCardToPlay(state: GameState, playerId: string): boolean {
  const player = state.players.find((p) => p.id === playerId)
  return !!player && player.handCardIds.length === 0
}

function hasNoCardToDecline(state: GameState, playerId: string): boolean {
  const player = state.players.find((p) => p.id === playerId)
  return !!player && player.handCardIds.length === 0 && player.discardCardIds.length === 0
}

/**
 * Select-cards phase (rule 1, simultaneous): eliminates every currently
 * pending player with an empty hand, since they have no card to choose. A
 * player's hand can't change from another player's choice during this
 * phase, so this only needs to run once, at phase start.
 */
export function eliminatePlayersWithNoCardToPlay(state: GameState): GameState {
  let nextState = state
  for (const playerId of state.pendingPlayerIds) {
    if (hasNoCardToPlay(nextState, playerId)) {
      nextState = eliminatePlayer(nextState, playerId)
    }
  }
  return nextState
}

/**
 * Decline phase (sequential, turn order): eliminates the active player and
 * advances to the next pending one, repeating as long as the (new) active
 * player also has nothing to decline (hand and discard both empty).
 */
export function eliminatePlayersWithNoCardToDecline(state: GameState): GameState {
  let nextState = state
  while (
    nextState.roundPhase === 'decline' &&
    nextState.activePlayerId &&
    hasNoCardToDecline(nextState, nextState.activePlayerId)
  ) {
    nextState = eliminatePlayer(nextState, nextState.activePlayerId)
  }
  return nextState
}
