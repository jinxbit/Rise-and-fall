import type { Action } from './actions'
import type { AchievementContent } from './achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import { updateAchievementClaims } from './achievements'
import { moveCard, syncCardZonesWithBoard } from './cards'
import { eliminatePlayersWithNoCardToDecline } from './elimination'
import { appendLog } from './log'
import { calculatePurchaseCost } from './purchaseCost'
import { spendResource } from './resources'
import { beginActionsPhase, beginPostActionsPhase, beginPurchasePhase, finishRound } from './round'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import { placeTile, placeUnit } from './boardSetup'
import type { ActionResult, Coordinate, GameState } from './types'
import { EMPTY_UNIT_CONTENT } from './unitContent'
import type { UnitContent } from './unitContent'
import { applyUnitActionEffect } from './unitActions'

export type { ActionResult } from './types'

/**
 * Applies a single validated action to a game state, returning a new state.
 * Never mutates the input. This is the ONLY place game rules are allowed to
 * run — UI and network layers must treat GameState as opaque and always
 * route changes through here so every client (live/async/hotseat) enforces
 * identical rules.
 *
 * `unitContent` (content/units.json's actions/movement, content/terrain.
 * json's levels, content/resources.json's caps — resolved by the caller,
 * see UnitContent in ./unitContent.ts) is needed to resolve
 * RESOLVE_UNIT_ACTION and PLACE_UNIT (for the new unit's movement
 * profile). `achievementContent` (content/achievements.json + the units/
 * terrain VP curves — see AchievementContent in ./achievementContent.ts)
 * drives achievement-claim detection (after RESOLVE_UNIT_ACTION), purchase
 * cost (PURCHASE_CARD), and the game-end/win check (once the purchase
 * phase finishes). `boardGenerationContent` (content/terrain.json's tile
 * shapes/placesOn/pool sizes — see BoardGenerationContent in
 * ./boardGenerationContent.ts) drives PLACE_TILE. All three are optional
 * and default to empty so callers that don't touch that content aren't
 * forced to pass it.
 *
 * PLACE_TILE/PLACE_UNIT are handled before the status guard below, since
 * they're the only actions valid during `status: 'boardSetup'` — every
 * other action requires `status: 'active'`.
 */
export function applyAction(
  state: GameState,
  action: Action,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
): ActionResult {
  if (action.type === 'PLACE_TILE') {
    return placeTile(state, action.playerId, action.anchor, action.rotationSteps, boardGenerationContent)
  }
  if (action.type === 'PLACE_UNIT') {
    return placeUnit(state, action.playerId, action.unitKind, action.coord, unitContent)
  }

  if (state.status !== 'active') {
    return { ok: false, error: `Game is not active (status: ${state.status})` }
  }

  switch (action.type) {
    case 'CHOOSE_CARD':
      return applyChooseCard(state, action.playerId, action.cardId)
    case 'RESOLVE_UNIT_ACTION':
      return applyResolveUnitAction(state, action.playerId, action.actionId, action.targets ?? {}, unitContent, achievementContent)
    case 'MOVE_TO_DECLINE':
      return applyMoveToDecline(state, action.playerId, action.cardId)
    case 'PURCHASE_CARD':
      return applyPurchaseCard(state, action.playerId, action.cardId, achievementContent)
    case 'PASS_PURCHASE':
      return applyPassPurchase(state, action.playerId, achievementContent)
    default: {
      const exhaustive: never = action
      return { ok: false, error: `Unknown action: ${JSON.stringify(exhaustive)}` }
    }
  }
}

/** Round step 1 (rule 1): every player simultaneously picks the card they'll play from hand. */
function applyChooseCard(state: GameState, playerId: string, cardId: string): ActionResult {
  if (state.roundPhase !== 'selectCards') {
    return { ok: false, error: 'Cards can only be chosen during the select-cards phase' }
  }
  if (!state.pendingPlayerIds.includes(playerId)) {
    return { ok: false, error: 'This player has already chosen a card this round' }
  }

  const playerIndex = state.players.findIndex((p) => p.id === playerId)
  if (playerIndex === -1) {
    return { ok: false, error: `Unknown player: ${playerId}` }
  }
  const player = state.players[playerIndex]
  if (!player.handCardIds.includes(cardId)) {
    return { ok: false, error: 'Card can only be chosen from hand' }
  }
  const card = state.cards[cardId]
  if (!card) {
    return { ok: false, error: `Unknown card: ${cardId}` }
  }

  let nextState: GameState = {
    ...state,
    chosenCardIdByPlayerId: { ...state.chosenCardIdByPlayerId, [playerId]: cardId },
    pendingPlayerIds: state.pendingPlayerIds.filter((id) => id !== playerId),
  }
  nextState = { ...nextState, log: appendLog(nextState, playerId, `Player ${playerId} chose to play ${card.name}`) }

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = beginActionsPhase(nextState)
  }
  return { ok: true, state: nextState }
}

/**
 * Round step 2 (rules 3 & 4): in turn order, resolve each player's chosen
 * card — apply the chosen unit action to every unit of that kind they
 * control (see applyUnitActionEffect in ./unitActions.ts) — then move the
 * card into discard. Also checks for newly-claimed achievements afterward
 * (see updateAchievementClaims in ./achievements.ts), since create/convert/
 * a destroySelf transform can change how many of a kind a player controls.
 */
function applyResolveUnitAction(
  state: GameState,
  playerId: string,
  actionId: string,
  targets: Record<string, Coordinate>,
  unitContent: UnitContent,
  achievementContent: AchievementContent,
): ActionResult {
  if (state.roundPhase !== 'actions') {
    return { ok: false, error: 'Not in the action-resolution phase' }
  }
  if (state.pendingPlayerIds[0] !== playerId) {
    return { ok: false, error: "It is not this player's turn to resolve their action" }
  }

  const playerIndex = state.players.findIndex((p) => p.id === playerId)
  if (playerIndex === -1) {
    return { ok: false, error: `Unknown player: ${playerId}` }
  }
  const cardId = state.chosenCardIdByPlayerId[playerId]
  if (!cardId) {
    return { ok: false, error: 'Player has no chosen card to resolve' }
  }
  const card = state.cards[cardId]
  if (!card) {
    return { ok: false, error: `Unknown card: ${cardId}` }
  }
  const unitAction = unitContent.actionsByKind[card.kind]?.find((a) => a.id === actionId)
  if (!unitAction) {
    return { ok: false, error: `Unknown action '${actionId}' for kind '${card.kind}'` }
  }

  let nextState = applyUnitActionEffect(state, playerId, card.kind, unitAction, targets, unitContent)

  // Rule 3 then 4: hand -> currently played -> discard. Re-look-up the
  // player, since applyUnitActionEffect may have changed their resources
  // (or, via card-zone sync, other zones) above.
  const player = nextState.players.find((p) => p.id === playerId)
  if (!player) {
    return { ok: false, error: `Unknown player: ${playerId}` }
  }
  let nextPlayer = moveCard(player, cardId, 'currentlyPlayed')
  nextPlayer = moveCard(nextPlayer, cardId, 'discard')
  const players = nextState.players.map((p) => (p.id === playerId ? nextPlayer : p))

  nextState = { ...nextState, players, pendingPlayerIds: nextState.pendingPlayerIds.slice(1) }
  nextState = { ...nextState, log: appendLog(nextState, playerId, `Player ${playerId} played ${card.name} (${unitAction.name})`) }
  nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }
  nextState = updateAchievementClaims(nextState, achievementContent, unitContent.unitSupplyCaps)

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = beginPostActionsPhase(nextState)
  }
  return { ok: true, state: nextState }
}

/** Removes a single occurrence of `id` from `ids` (not every occurrence — see removeOneOccurrence's caller). */
function removeOneOccurrence(ids: string[], id: string): string[] {
  const index = ids.indexOf(id)
  if (index === -1) return ids
  return [...ids.slice(0, index), ...ids.slice(index + 1)]
}

/**
 * Round step 3 (rule 3 of decline): every player simultaneously moves one
 * card from hand or discard to decline — not turn order, so any pending
 * player may act in any order relative to the others. A player who owes
 * more than one card this round (see beginDeclinePhase in ./round.ts)
 * appears more than once in `pendingPlayerIds`; each call here removes
 * just the one occurrence being fulfilled; that player remains pending
 * (and may act again, in any order relative to everyone else) until all of
 * their occurrences are gone.
 */
function applyMoveToDecline(state: GameState, playerId: string, cardId: string): ActionResult {
  if (state.roundPhase !== 'decline') {
    return { ok: false, error: 'Not in the decline phase' }
  }
  if (!state.pendingPlayerIds.includes(playerId)) {
    return { ok: false, error: 'This player has no more cards owed to decline this round' }
  }

  const playerIndex = state.players.findIndex((p) => p.id === playerId)
  if (playerIndex === -1) {
    return { ok: false, error: `Unknown player: ${playerId}` }
  }
  const player = state.players[playerIndex]
  if (!player.handCardIds.includes(cardId) && !player.discardCardIds.includes(cardId)) {
    return { ok: false, error: 'Card moved to decline must come from hand or discard' }
  }

  const nextPlayer = moveCard(player, cardId, 'decline')
  const players = [...state.players]
  players[playerIndex] = nextPlayer

  let nextState: GameState = { ...state, players, pendingPlayerIds: removeOneOccurrence(state.pendingPlayerIds, playerId) }
  nextState = { ...nextState, log: appendLog(nextState, playerId, `Player ${playerId} moved a card into decline`) }
  // This player (or another still-pending one) might now have nothing left
  // to decline for a required card they haven't supplied yet.
  nextState = eliminatePlayersWithNoCardToDecline(nextState)

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = beginPurchasePhase(nextState)
  }
  return { ok: true, state: nextState }
}

/**
 * Round step 4: a player buys one card back from their own decline, paying
 * gold per calculatePurchaseCost() (./purchaseCost.ts) — the cost rises
 * with the total achievements claimed so far, across all players. The
 * bought-back card lands in `hand` and is immediately re-synced (see
 * syncCardZonesWithBoard in ./cards.ts) in case the player currently has no
 * unit of that kind on the board, in which case it belongs in `supply`
 * instead — same rule 5/6 logic every other card move already respects.
 */
function applyPurchaseCard(state: GameState, playerId: string, cardId: string, achievementContent: AchievementContent): ActionResult {
  if (state.roundPhase !== 'purchase') {
    return { ok: false, error: 'Not in the purchase phase' }
  }
  if (state.pendingPlayerIds[0] !== playerId) {
    return { ok: false, error: "It is not this player's turn in the purchase phase" }
  }

  const playerIndex = state.players.findIndex((p) => p.id === playerId)
  if (playerIndex === -1) {
    return { ok: false, error: `Unknown player: ${playerId}` }
  }
  const player = state.players[playerIndex]
  if (!player.declineCardIds.includes(cardId)) {
    return { ok: false, error: "Card must be in this player's decline to purchase it back" }
  }

  const achievementsClaimedSoFar = Object.keys(state.claimedByAchievementId).length
  const cost = calculatePurchaseCost(achievementsClaimedSoFar, achievementContent.purchaseCostTable)

  const spent = spendResource(player.resources, state.resourceBank, 'gold', cost)
  if (!spent) {
    return { ok: false, error: `Not enough gold to purchase this card (costs ${cost})` }
  }

  let nextPlayer = { ...player, resources: spent.resources }
  nextPlayer = moveCard(nextPlayer, cardId, 'hand')
  const players = state.players.map((p) => (p.id === playerId ? nextPlayer : p))

  let nextState: GameState = { ...state, players, resourceBank: spent.bank, pendingPlayerIds: state.pendingPlayerIds.slice(1) }
  nextState = syncCardZonesWithBoard(nextState)
  nextState = { ...nextState, log: appendLog(nextState, playerId, `Player ${playerId} purchased a card back from decline for ${cost} gold`) }
  nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = finishRound(nextState, achievementContent)
  }
  return { ok: true, state: nextState }
}

/** Round step 4: a player declines their opportunity to buy a card back from decline. */
function applyPassPurchase(state: GameState, playerId: string, achievementContent: AchievementContent): ActionResult {
  if (state.roundPhase !== 'purchase') {
    return { ok: false, error: 'Not in the purchase phase' }
  }
  if (state.pendingPlayerIds[0] !== playerId) {
    return { ok: false, error: "It is not this player's turn in the purchase phase" }
  }

  let nextState: GameState = { ...state, pendingPlayerIds: state.pendingPlayerIds.slice(1) }
  nextState = { ...nextState, log: appendLog(nextState, playerId, `Player ${playerId} passed on purchasing`) }
  nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = finishRound(nextState, achievementContent)
  }
  return { ok: true, state: nextState }
}
