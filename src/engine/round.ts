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
    resolvedUnitIdsThisTurn: [],
    activePlayerId: state.turnOrder[0] ?? null,
  }
}

/**
 * Round step 3: every player simultaneously moves one or more cards from
 * hand/discard to decline — like select-cards, not turn order, so
 * `activePlayerId` stays null throughout. Also applies the elimination
 * rule: any pending player with nothing to decline (hand and discard both
 * empty) is eliminated (see eliminatePlayersWithNoCardToDecline in
 * ./elimination.ts).
 *
 * Per ruling, a player must decline more than one card if more than one
 * achievement was claimed *during the round now ending* — every pending
 * player owes `max(1, achievementsClaimedThisRound)` cards this phase, not
 * just the player(s) who claimed them. Modeled by repeating their id in
 * `pendingPlayerIds` that many times (order doesn't matter, since the
 * phase is simultaneous); `applyMoveToDecline` (./applyAction.ts) removes
 * one occurrence per card declined, regardless of which player goes when,
 * until every player has supplied all their required cards.
 */
export function beginDeclinePhase(state: GameState, achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT): GameState {
  const cardsPerPlayer = Math.max(1, state.achievementsClaimedThisRound)
  const started: GameState = {
    ...state,
    roundPhase: 'decline',
    pendingPlayerIds: state.turnOrder.flatMap((id) => Array<string>(cardsPerPlayer).fill(id)),
    activePlayerId: null,
  }
  const afterEliminations = eliminatePlayersWithNoCardToDecline(started)
  return afterEliminations.pendingPlayerIds.length === 0
    ? beginPurchasePhase(afterEliminations, achievementContent)
    : afterEliminations
}

/**
 * Skips past any player(s) at the front of the purchase-phase queue who
 * have nothing in decline to buy back — there's nothing for them to
 * meaningfully decide, so no PASS_PURCHASE action should be required from
 * them. Keeps skipping across multiple consecutive empty-decline players
 * (e.g. nobody has declined anything yet this game) until it finds one
 * with cards to consider, or runs out. A no-op outside the purchase phase.
 */
export function skipEmptyDeclinePurchasers(state: GameState): GameState {
  let nextState = state
  while (nextState.roundPhase === 'purchase' && nextState.pendingPlayerIds.length > 0) {
    const playerId = nextState.pendingPlayerIds[0]
    const player = nextState.players.find((p) => p.id === playerId)
    if (!player || player.declineCardIds.length > 0) break
    nextState = { ...nextState, pendingPlayerIds: nextState.pendingPlayerIds.slice(1) }
    nextState = { ...nextState, log: appendLog(nextState, playerId, `Player ${playerId} had nothing to purchase back`) }
    nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }
  }
  return nextState
}

/**
 * Round step 4: every player may buy one card back from decline, or pass,
 * in turn order. Players with an empty decline are skipped automatically
 * (see skipEmptyDeclinePurchasers) — if that empties the whole queue (the
 * common case: nobody has declined anything yet), the round finishes
 * immediately without any player having to act.
 */
export function beginPurchasePhase(state: GameState, achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT): GameState {
  const started: GameState = {
    ...state,
    roundPhase: 'purchase',
    pendingPlayerIds: [...state.turnOrder],
    activePlayerId: state.turnOrder[0] ?? null,
  }
  const afterSkips = skipEmptyDeclinePurchasers(started)
  return afterSkips.pendingPlayerIds.length === 0 ? finishRound(afterSkips, achievementContent) : afterSkips
}

/** Once the actions phase finishes: rule 3 inserts the decline phase only if it was triggered this round. */
export function beginPostActionsPhase(state: GameState, achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT): GameState {
  return isDeclineTriggered(state) ? beginDeclinePhase(state, achievementContent) : beginPurchasePhase(state, achievementContent)
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
