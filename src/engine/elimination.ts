import type { GameState, Resources } from './types.ts'

/**
 * Rule: a player is eliminated if they have to play a card — choosing one
 * in the select-cards phase, or giving one up in the decline phase — and
 * have none available. They're removed from the board and turn order for
 * the rest of the game, and excluded from winning (callers of
 * determineWinners in ./victoryPoints.ts should pass only non-eliminated
 * player ids). Achievements they've already claimed are NOT revoked. All
 * of their gold/wood/stone is returned to the shared bank.
 *
 * Also ends the game immediately once this elimination leaves at most one
 * player standing — bug report: "a game with only one player remaining
 * didn't finish." No VP comparison needed (unlike the normal gameLength
 * win check in round.ts's finishRound): the sole survivor trivially wins
 * outright, and if this elimination wipes out the very last player too
 * (an all-players-simultaneously-eliminated edge case), the game still
 * ends, just with nobody to declare (`winnerPlayerIds: []`). Callers that
 * chain straight into the next round phase once every pending player has
 * been resolved (beginSelectCardsPhase/beginDeclinePhase in ./round.ts,
 * applyMoveToDecline in ./applyAction.ts) must check `status` before doing
 * so — completed here means stop, not "safe to advance."
 *
 * `conceded` just stamps Player.conceded for presentation (see its doc
 * comment in ./types.ts) — applyConcede (./applyAction.ts) passes `true`;
 * every other caller here is an automatic no-card elimination and leaves it
 * `false`.
 */
export function eliminatePlayer(state: GameState, playerId: string, conceded = false): GameState {
  const playerIndex = state.players.findIndex((p) => p.id === playerId)
  if (playerIndex === -1 || state.players[playerIndex].eliminated) return state

  const eliminated = state.players[playerIndex]
  const players = [...state.players]
  players[playerIndex] = { ...eliminated, eliminated: true, conceded, resources: { gold: 0, wood: 0, stone: 0 } }

  const resourceBank: Resources = {
    gold: state.resourceBank.gold + eliminated.resources.gold,
    wood: state.resourceBank.wood + eliminated.resources.wood,
    stone: state.resourceBank.stone + eliminated.resources.stone,
  }

  // The Majestic Bridge Tale: the Bridge is a permanent, indestructible
  // World piece that "belongs to no player" per its own rules text — it's
  // still stamped with a real ownerId (the player who built it, see
  // content/tales.json's construct-the-bridge) purely so the existing
  // ownership-keyed Trophy-claim machinery can recognize it, but that
  // owner's own elimination must never take the Bridge off the board with
  // them.
  const units = state.units.filter((u) => u.ownerId !== playerId || u.kind === 'bridge')
  const turnOrder = state.turnOrder.filter((id) => id !== playerId)
  const pendingPlayerIds = state.pendingPlayerIds.filter((id) => id !== playerId)
  // selectCards and decline are both simultaneous phases with no single
  // active player; actions/purchase are turn order, so the next pending
  // player (if any) becomes active.
  const activePlayerId =
    state.roundPhase === 'selectCards' || state.roundPhase === 'decline' ? null : (pendingPlayerIds[0] ?? null)

  const remainingPlayerIds = players.filter((p) => !p.eliminated).map((p) => p.id)
  if (remainingPlayerIds.length <= 1) {
    return { ...state, players, units, turnOrder, pendingPlayerIds, activePlayerId, resourceBank, status: 'completed', winnerPlayerIds: remainingPlayerIds }
  }

  return { ...state, players, units, turnOrder, pendingPlayerIds, activePlayerId, resourceBank }
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
 * Decline phase (rule 3, simultaneous like select-cards — a player may owe
 * more than one card, see beginDeclinePhase in ./round.ts, but still isn't
 * on anyone else's turn): eliminates every currently pending player who has
 * nothing left to decline (hand and discard both empty). Must be re-run
 * after each MOVE_TO_DECLINE, not just once at phase start, since
 * multi-card decline can leave a player owing more cards than they have
 * left partway through their own declines.
 */
export function eliminatePlayersWithNoCardToDecline(state: GameState): GameState {
  if (state.roundPhase !== 'decline') return state

  let nextState = state
  for (const playerId of new Set(state.pendingPlayerIds)) {
    if (hasNoCardToDecline(nextState, playerId)) {
      nextState = eliminatePlayer(nextState, playerId)
    }
  }
  return nextState
}
