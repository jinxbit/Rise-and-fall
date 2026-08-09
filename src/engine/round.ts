import type { AchievementContent } from './achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import { isDeclineTriggered } from './decline'
import { eliminatePlayersWithNoCardToDecline, eliminatePlayersWithNoCardToPlay } from './elimination'
import { appendLog } from './log'
import { calculateTerrainControlVP } from './scoring'
import type { GameState } from './types'
import { calculateAchievementVP, calculateBoardCountVP, determineWinners, sumVP } from './victoryPoints'

/**
 * Round step 1: every player simultaneously picks a card; nobody is
 * "active". Also applies the elimination rule: any player with an empty
 * hand has no card to choose, so they're eliminated on the spot rather
 * than left unable to submit a valid CHOOSE_CARD. Resets
 * achievementsClaimedThisRound for the new round (see beginDeclinePhase).
 */
export function beginSelectCardsPhase(state: GameState): GameState {
  const started: GameState = {
    ...state,
    roundPhase: 'selectCards',
    chosenCardIdByPlayerId: Object.fromEntries(state.players.map((p) => [p.id, null])),
    pendingPlayerIds: [...state.turnOrder],
    activePlayerId: null,
    achievementsClaimedThisRound: 0,
  }
  const afterEliminations = eliminatePlayersWithNoCardToPlay(started)
  return afterEliminations.pendingPlayerIds.length === 0 ? beginActionsPhase(afterEliminations) : afterEliminations
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

/**
 * Round step 3: every player moves one or more cards from hand/discard to
 * decline, in turn order. Also applies the elimination rule: the active
 * player is eliminated (and the next one checked in turn) for as long as
 * whoever's up has nothing to decline (hand and discard both empty).
 *
 * Per ruling, a player must decline more than one card if more than one
 * achievement was claimed *during the round now ending* — every pending
 * player owes `max(1, achievementsClaimedThisRound)` cards this phase, not
 * just the player(s) who claimed them. ASSUMPTION (the rules don't spell
 * out the exact mechanics): each player declines all of their required
 * cards consecutively before the turn passes to the next player — modeled
 * by repeating their id in `pendingPlayerIds` that many times, so the
 * existing one-card-per-MOVE_TO_DECLINE logic (applyMoveToDecline in
 * ./applyAction.ts) needs no changes; it just keeps popping the same id
 * off the front until they've supplied enough cards.
 */
export function beginDeclinePhase(state: GameState): GameState {
  const cardsPerPlayer = Math.max(1, state.achievementsClaimedThisRound)
  const started: GameState = {
    ...state,
    roundPhase: 'decline',
    pendingPlayerIds: state.turnOrder.flatMap((id) => Array<string>(cardsPerPlayer).fill(id)),
    activePlayerId: state.turnOrder[0] ?? null,
  }
  const afterEliminations = eliminatePlayersWithNoCardToDecline(started)
  return afterEliminations.pendingPlayerIds.length === 0 ? beginPurchasePhase(afterEliminations) : afterEliminations
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
 * player if that happened, then either end the game (step 6, once
 * `achievementContent.gameLength` total achievements have been claimed) or
 * start the next round. `achievementContent` defaults to
 * EMPTY_ACHIEVEMENT_CONTENT (gameLength: Infinity), so a caller that
 * doesn't supply it gets the old always-continue behavior.
 */
export function finishRound(state: GameState, achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT): GameState {
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

  // Round step 6, game-end: once achievementContent.gameLength total
  // achievements have been claimed (summed across all players), the round
  // in progress (which just finished, above) ends the game — whoever has
  // the most total VP wins (achievements + board-count + terrain-control),
  // with no tiebreaker (a tie is a shared win).
  const totalAchievementsClaimed = Object.keys(nextState.claimedByAchievementId).length
  if (totalAchievementsClaimed >= achievementContent.gameLength) {
    const totalVP = sumVP(
      calculateAchievementVP(nextState.claimedByAchievementId, achievementContent.achievementVictoryPoints),
      calculateBoardCountVP(nextState.units, achievementContent.unitBoardCountVP),
      calculateTerrainControlVP(nextState.board, nextState.units, achievementContent.terrainVictoryPoints, achievementContent.terrainScoresAs),
    )
    const activePlayerIds = nextState.players.filter((p) => !p.eliminated).map((p) => p.id)
    const winnerPlayerIds = determineWinners(activePlayerIds, totalVP)

    nextState = { ...nextState, status: 'completed', winnerPlayerIds }
    return {
      ...nextState,
      log: appendLog(
        nextState,
        null,
        `Game ends — ${totalAchievementsClaimed} achievements claimed. Winner(s): ${winnerPlayerIds.join(', ') || 'none'}`,
      ),
    }
  }

  nextState = { ...nextState, turn: nextState.turn + 1 }
  nextState = { ...nextState, log: appendLog(nextState, null, `Round ${nextState.turn} begins`) }
  return beginSelectCardsPhase(nextState)
}
