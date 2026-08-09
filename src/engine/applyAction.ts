import type { Action } from './actions'
import { moveCard } from './cards'
import { eliminatePlayersWithNoCardToDecline } from './elimination'
import { appendLog } from './log'
import { beginActionsPhase, beginPostActionsPhase, beginPurchasePhase, finishRound } from './round'
import type { Coordinate, GameState } from './types'
import { EMPTY_UNIT_CONTENT } from './unitContent'
import type { UnitContent } from './unitContent'
import { applyUnitActionEffect } from './unitActions'

export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string }

/**
 * Applies a single validated action to a game state, returning a new state.
 * Never mutates the input. This is the ONLY place game rules are allowed to
 * run — UI and network layers must treat GameState as opaque and always
 * route changes through here so every client (live/async/hotseat) enforces
 * identical rules.
 *
 * `unitContent` (content/units.json's actions/movement, content/terrain.
 * json's levels, content/resources.json's caps — resolved by the caller,
 * see UnitContent in ./unitContent.ts) is only needed to resolve
 * RESOLVE_UNIT_ACTION; every other action ignores it. Optional and
 * defaults to empty so callers that don't touch unit actions aren't forced
 * to pass it.
 */
export function applyAction(state: GameState, action: Action, unitContent: UnitContent = EMPTY_UNIT_CONTENT): ActionResult {
  if (state.status !== 'active') {
    return { ok: false, error: `Game is not active (status: ${state.status})` }
  }

  switch (action.type) {
    case 'CHOOSE_CARD':
      return applyChooseCard(state, action.playerId, action.cardId)
    case 'RESOLVE_UNIT_ACTION':
      return applyResolveUnitAction(state, action.playerId, action.actionId, action.targets ?? {}, action.moveTargets ?? {}, unitContent)
    case 'MOVE_TO_DECLINE':
      return applyMoveToDecline(state, action.playerId, action.cardId)
    case 'PURCHASE_CARD':
      // Purchase cost is determined by player achievements, not yet specified.
      return { ok: false, error: 'NOT_IMPLEMENTED: PURCHASE_CARD' }
    case 'PASS_PURCHASE':
      return applyPassPurchase(state, action.playerId)
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
 * control (see applyUnitActionEffect in ./unitActions.ts), except any unit
 * named in `moveTargets`, which spends its action moving instead — then
 * move the card into discard.
 */
function applyResolveUnitAction(
  state: GameState,
  playerId: string,
  actionId: string,
  targets: Record<string, Coordinate>,
  moveTargets: Record<string, Coordinate>,
  unitContent: UnitContent,
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

  let nextState = applyUnitActionEffect(state, playerId, card.kind, unitAction, targets, unitContent, moveTargets)

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

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = beginPostActionsPhase(nextState)
  }
  return { ok: true, state: nextState }
}

/** Round step 3 (rule 3 of decline): in turn order, move one card from hand or discard to decline. */
function applyMoveToDecline(state: GameState, playerId: string, cardId: string): ActionResult {
  if (state.roundPhase !== 'decline') {
    return { ok: false, error: 'Not in the decline phase' }
  }
  if (state.pendingPlayerIds[0] !== playerId) {
    return { ok: false, error: "It is not this player's turn to move a card into decline" }
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

  let nextState: GameState = { ...state, players, pendingPlayerIds: state.pendingPlayerIds.slice(1) }
  nextState = { ...nextState, log: appendLog(nextState, playerId, `Player ${playerId} moved a card into decline`) }
  nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }
  // Whoever's up next might themselves have nothing to decline — cascades
  // via eliminatePlayersWithNoCardToDecline until someone valid is found.
  nextState = eliminatePlayersWithNoCardToDecline(nextState)

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = beginPurchasePhase(nextState)
  }
  return { ok: true, state: nextState }
}

/** Round step 4: a player declines their opportunity to buy a card back from decline. */
function applyPassPurchase(state: GameState, playerId: string): ActionResult {
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
    nextState = finishRound(nextState)
  }
  return { ok: true, state: nextState }
}
