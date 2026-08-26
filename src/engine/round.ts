import type { AchievementContent } from './achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import { moveUnbackedDiscardCardsToSupply, syncCardZonesWithBoard } from './cards'
import { isDeclineTriggered } from './decline'
import { eliminatePlayersWithNoCardToDecline, eliminatePlayersWithNoCardToPlay } from './elimination'
import { calculatePurchaseCost } from './purchaseCost'
import type { FantasticEvent, TaleContent } from './taleContent'
import { EMPTY_TALE_CONTENT } from './taleContent'
import { companionKindsByCardKind } from './tales'
import type { GameState } from './types'
import { calculateVPBreakdown, determineWinners } from './victoryPoints'

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
  // An elimination just above may have already ended the game outright
  // (eliminatePlayer's last-player-standing check, ./elimination.ts) — that
  // takes priority over chaining into the next phase, even though every
  // pending player has technically been resolved.
  return afterEliminations.status !== 'completed' && afterEliminations.pendingPlayerIds.length === 0
    ? beginActionsPhase(afterEliminations)
    : afterEliminations
}

/** Round step 2: resolve each player's chosen card, in turn order. */
export function beginActionsPhase(state: GameState): GameState {
  return {
    ...state,
    roundPhase: 'actions',
    pendingPlayerIds: [...state.turnOrder],
    resolvedUnitIdsThisTurn: [],
    unitsCreatedThisTurn: [],
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
export function beginDeclinePhase(
  state: GameState,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): GameState {
  const cardsPerPlayer = Math.max(1, state.achievementsClaimedThisRound)
  const started: GameState = {
    ...state,
    roundPhase: 'decline',
    pendingPlayerIds: state.turnOrder.flatMap((id) => Array<string>(cardsPerPlayer).fill(id)),
    activePlayerId: null,
  }
  const afterEliminations = eliminatePlayersWithNoCardToDecline(started)
  // See beginSelectCardsPhase's matching comment: a just-completed game
  // (last-player-standing) must not chain into the purchase phase.
  return afterEliminations.status !== 'completed' && afterEliminations.pendingPlayerIds.length === 0
    ? beginPurchasePhase(afterEliminations, achievementContent, taleContent)
    : afterEliminations
}

/**
 * Skips past any player(s) at the front of the purchase-phase queue who
 * have nothing meaningful to decide: either their decline is empty, or the
 * current buyback price (calculatePurchaseCost) costs more gold than they
 * have — either way no card purchase is actually possible for them, so no
 * PASS_PURCHASE action should be required. Keeps skipping across multiple
 * consecutive such players until it finds one who can actually afford
 * something, or runs out. A no-op outside the purchase phase.
 */
export function skipEmptyDeclinePurchasers(state: GameState, achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT): GameState {
  const achievementsClaimedSoFar = Object.keys(state.claimedByAchievementId).length
  const cost = calculatePurchaseCost(achievementsClaimedSoFar, achievementContent.purchaseCostTable)

  let nextState = state
  while (nextState.roundPhase === 'purchase' && nextState.pendingPlayerIds.length > 0) {
    const playerId = nextState.pendingPlayerIds[0]
    const player = nextState.players.find((p) => p.id === playerId)
    if (!player || (player.declineCardIds.length > 0 && player.resources.gold >= cost)) break
    nextState = { ...nextState, pendingPlayerIds: nextState.pendingPlayerIds.slice(1) }
    nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }
  }
  return nextState
}

/**
 * Round step 4: every player may buy one card back from decline, or pass,
 * in turn order. Players with an empty decline, or who can't afford the
 * current buyback price, are skipped automatically (see
 * skipEmptyDeclinePurchasers) — if that empties the whole queue (the
 * common case: nobody has declined anything yet), the round finishes
 * immediately without any player having to act.
 */
export function beginPurchasePhase(
  state: GameState,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): GameState {
  const started: GameState = {
    ...state,
    roundPhase: 'purchase',
    pendingPlayerIds: [...state.turnOrder],
    activePlayerId: state.turnOrder[0] ?? null,
  }
  const afterSkips = skipEmptyDeclinePurchasers(started, achievementContent)
  return afterSkips.pendingPlayerIds.length === 0 ? finishRound(afterSkips, achievementContent, taleContent) : afterSkips
}

/** Once the actions phase finishes: rule 3 inserts the decline phase only if it was triggered this round. */
export function beginPostActionsPhase(
  state: GameState,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): GameState {
  return isDeclineTriggered(state)
    ? beginDeclinePhase(state, achievementContent, taleContent)
    : beginPurchasePhase(state, achievementContent, taleContent)
}

/**
 * Fantastic Events (e.g. The Banks Tale's Economic Collapse) trigger during
 * the Recycling step, when two or more players must recycle their hand in
 * the same round — resolved by finishRound below in ascending Tale-number
 * order (taleContent.fantasticEvents is already in that order, see
 * resolveTaleContent in content/resolveContent.ts). Each event fires when
 * every non-eliminated player currently controls at least one unit of
 * requiredUnitKind, removing every unit of that kind from the board (back
 * to its owner's reserve) when it does.
 */
function applyFantasticEvents(state: GameState, events: FantasticEvent[]): GameState {
  let nextState = state
  for (const event of events) {
    const activePlayerIds = nextState.players.filter((p) => !p.eliminated).map((p) => p.id)
    const everyoneControlsIt = activePlayerIds.every((playerId) =>
      nextState.units.some((u) => u.kind === event.requiredUnitKind && u.ownerId === playerId),
    )
    if (!everyoneControlsIt) continue
    nextState = { ...nextState, units: nextState.units.filter((u) => u.kind !== event.requiredUnitKind) }
  }
  return nextState
}

/**
 * Round steps 5 & 6, run automatically once the purchase phase finishes:
 * recycle any empty hand from discard, hand "first player" to the next
 * player if that happened, resolve any Fantastic Events (if two or more
 * players just recycled), then either end the game (step 6, once
 * `achievementContent.gameLength` total achievements have been claimed) or
 * start the next round. `achievementContent`/`taleContent` default to
 * their empty forms (gameLength: Infinity, no Fantastic Events), so a
 * caller that doesn't supply them gets the old always-continue, no-Tales
 * behavior.
 */
export function finishRound(
  state: GameState,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): GameState {
  // A card played this round represents whatever kind its owner discarded
  // it as, regardless of whether they still have a unit of that kind by
  // round end — e.g. a Ship card played the same turn its only Ship
  // transformed away. Rule 5 says it belongs in supply once nothing backs
  // it; catch that here, every round end, rather than only when the whole
  // hand later happens to recycle (see moveUnbackedDiscardCardsToSupply's
  // doc comment in ./cards.ts).
  const withSupplyCorrections = moveUnbackedDiscardCardsToSupply(state, companionKindsByCardKind(taleContent))

  let recycledCount = 0
  const players = withSupplyCorrections.players.map((player) => {
    if (player.handCardIds.length === 0 && player.discardCardIds.length > 0) {
      recycledCount++
      return { ...player, handCardIds: player.discardCardIds, discardCardIds: [] }
    }
    return player
  })

  let nextState: GameState = { ...withSupplyCorrections, players }

  if (recycledCount > 0) {
    // Re-syncs the just-recycled hand against the board — catches any
    // recycled card for a now-absent kind that moveUnbackedDiscardCardsToSupply
    // above didn't (e.g. a companion unit lost after that check ran).
    nextState = syncCardZonesWithBoard(nextState, companionKindsByCardKind(taleContent))

    const turnOrder =
      nextState.turnOrder.length > 1 ? [...nextState.turnOrder.slice(1), nextState.turnOrder[0]] : nextState.turnOrder
    nextState = { ...nextState, turnOrder }
  }

  if (recycledCount >= 2 && taleContent.fantasticEvents.length > 0) {
    nextState = applyFantasticEvents(nextState, taleContent.fantasticEvents)
  }

  // Round step 6, game-end: once achievementContent.gameLength total
  // achievements have been claimed (summed across all players), the round
  // in progress (which just finished, above) ends the game — whoever has
  // the most total VP wins (achievements + board-count + terrain-control +
  // gold + Tale controllable structures), with no tiebreaker (a tie is a
  // shared win).
  const totalAchievementsClaimed = Object.keys(nextState.claimedByAchievementId).length
  if (totalAchievementsClaimed >= achievementContent.gameLength) {
    const breakdownByPlayerId = calculateVPBreakdown(nextState, achievementContent, taleContent)
    const totalVP = Object.fromEntries(Object.entries(breakdownByPlayerId).map(([playerId, b]) => [playerId, b.total]))
    const activePlayerIds = nextState.players.filter((p) => !p.eliminated).map((p) => p.id)
    const winnerPlayerIds = determineWinners(activePlayerIds, totalVP)

    return { ...nextState, status: 'completed', winnerPlayerIds }
  }

  nextState = { ...nextState, turn: nextState.turn + 1 }
  return beginSelectCardsPhase(nextState)
}
