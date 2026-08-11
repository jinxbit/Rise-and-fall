import type { Action, LoggedAction, PlaceTileAction, UnitActionAssignment } from './actions'
import type { AchievementContent } from './achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import { updateAchievementClaims } from './achievements'
import { moveCard, syncCardZonesWithBoard } from './cards'
import { eliminatePlayersWithNoCardToDecline } from './elimination'
import { findForcedPlacement } from './boardGeneration'
import { calculatePurchaseCost } from './purchaseCost'
import { spendResource } from './resources'
import { beginActionsPhase, beginPostActionsPhase, beginPurchasePhase, finishRound, skipEmptyDeclinePurchasers } from './round'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import { currentTilePlacerId, placeTile, placeUnit } from './boardSetup'
import type { ActionResult, GameState } from './types'
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
 *
 * Every accepted action is appended to the returned state's
 * `actionHistory` (event sourcing — see GameState.actionHistory's doc
 * comment) via a thin wrapper around the actual dispatch logic below, so
 * every caller gets this for free without each individual apply* handler
 * needing to remember to do it.
 *
 * Deliberately stays a pure one-action-in, one-log-entry-out reducer —
 * replayActions() (./replay.ts) calls this once per already-logged entry
 * to reconstruct state, so anything this function did *beyond* the given
 * action (like also deciding what to submit next) would run again on
 * every replay of an entry that was itself such a follow-up, colliding
 * with the next real logged entry. Live callers that want PLACE_TILE's
 * forced-follow-up fast-forwarding (see applyActionAndFastForwardTiles
 * below) call that wrapper instead — it's still just repeated calls to
 * this same function under the hood, so every fast-forwarded placement
 * gets its own perfectly ordinary actionHistory entry.
 */
export function applyAction(
  state: GameState,
  action: Action,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
): ActionResult {
  const result = dispatchAction(state, action, unitContent, achievementContent, boardGenerationContent)
  if (!result.ok) return result

  const loggedAction: LoggedAction = { action, turn: result.state.turn, timestamp: new Date().toISOString() }
  return { ok: true, state: { ...result.state, actionHistory: [...result.state.actionHistory, loggedAction] } }
}

/**
 * Live-submission wrapper around applyAction(): applies `action`, then —
 * if it was a PLACE_TILE — keeps fast-forwarding further tile placements
 * for as long as the tier's remaining tiles have only one possible way
 * left for all of them to go (see findForcedPlacement in
 * ./boardGeneration.ts, rolling naturally into a newly-forced next tier
 * too). A placement that isn't really a decision anymore doesn't need a
 * player to confirm it — but player order still matters for bookkeeping
 * (whose turn advances, when the tier/unit-placement phase transitions),
 * so each fast-forwarded tile is still attributed to whichever player's
 * turn it actually is (currentTilePlacerId) and submitted through
 * applyAction() itself, landing its own ordinary actionHistory entry, same
 * as if that player had placed it themselves.
 *
 * This is the function UI/API callers should use to submit a PLACE_TILE
 * (see GamePage.tsx's submitAction) — applyAction() itself intentionally
 * doesn't do this (see its own doc comment for why).
 */
export function applyActionAndFastForwardTiles(
  state: GameState,
  action: Action,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
): ActionResult {
  const result = applyAction(state, action, unitContent, achievementContent, boardGenerationContent)
  if (!result.ok || action.type !== 'PLACE_TILE') return result

  let nextState = result.state
  for (
    let forced = nextTileFastForward(nextState, boardGenerationContent);
    forced;
    forced = nextTileFastForward(nextState, boardGenerationContent)
  ) {
    const cascadeResult = applyAction(nextState, forced, unitContent, achievementContent, boardGenerationContent)
    if (!cascadeResult.ok) break // defensive only — findForcedPlacement's own combo is always legal by construction
    nextState = cascadeResult.state
  }
  return { ok: true, state: nextState }
}

/** The next forced PLACE_TILE action to submit, or null once no longer forced — see applyActionAndFastForwardTiles. */
function nextTileFastForward(state: GameState, boardGenerationContent: BoardGenerationContent): PlaceTileAction | null {
  const boardSetup = state.boardSetup
  if (state.status !== 'boardSetup' || !boardSetup || boardSetup.tileTierQueue.length === 0) return null
  if (boardSetup.tilesRemainingInTier <= 0) return null

  const tierContent = boardGenerationContent.tiers.find((t) => t.terrain === boardSetup.tileTierQueue[0])
  if (!tierContent) return null

  const forced = findForcedPlacement(state.board, tierContent.shapeCells, tierContent.placesOn, boardSetup.tilesRemainingInTier)
  if (!forced) return null

  const playerId = currentTilePlacerId(state)
  if (!playerId) return null

  return { type: 'PLACE_TILE', playerId, anchor: forced.anchor, rotationSteps: forced.rotationSteps }
}

function dispatchAction(
  state: GameState,
  action: Action,
  unitContent: UnitContent,
  achievementContent: AchievementContent,
  boardGenerationContent: BoardGenerationContent,
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
      return applyResolveUnitAction(state, action.playerId, action.unitActions, unitContent, achievementContent)
    case 'PASS_ACTIONS':
      return applyPassActions(state, action.playerId, achievementContent)
    case 'MOVE_TO_DECLINE':
      return applyMoveToDecline(state, action.playerId, action.cardId, achievementContent)
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

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = beginActionsPhase(nextState)
  }
  return { ok: true, state: nextState }
}

/**
 * Round step 2's turn-ending bookkeeping, shared by an explicit
 * PASS_ACTIONS (applyPassActions below) and by applyResolveUnitAction
 * auto-finishing a turn the moment every acting unit has resolved — no
 * separate Pass click needed once there's nothing left to decide. Moves
 * the chosen card hand -> currently played -> discard (rules 3 & 4),
 * advances `pendingPlayerIds` to the next player, and resets
 * `resolvedUnitIdsThisTurn` for their fresh turn.
 */
function finishActionsTurn(state: GameState, playerId: string, achievementContent: AchievementContent): ActionResult {
  const cardId = state.chosenCardIdByPlayerId[playerId]
  if (!cardId) {
    return { ok: false, error: 'Player has no chosen card to resolve' }
  }
  const player = state.players.find((p) => p.id === playerId)
  if (!player) {
    return { ok: false, error: `Unknown player: ${playerId}` }
  }

  let nextPlayer = moveCard(player, cardId, 'currentlyPlayed')
  nextPlayer = moveCard(nextPlayer, cardId, 'discard')
  const players = state.players.map((p) => (p.id === playerId ? nextPlayer : p))

  let nextState: GameState = {
    ...state,
    players,
    pendingPlayerIds: state.pendingPlayerIds.slice(1),
    resolvedUnitIdsThisTurn: [],
    unitsCreatedThisTurn: [],
  }
  nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = beginPostActionsPhase(nextState, achievementContent)
  }
  return { ok: true, state: nextState }
}

/**
 * Round step 2, rules 3 & 4's action part: resolves one or more of the
 * active player's units immediately — applied right away, not staged
 * behind a later submit — which is what lets one unit's effect
 * (e.g. a Nomad producing a resource) be visible before the player even
 * chooses a later unit's action (e.g. a second Nomad spending it to
 * convert), and lets a global Undo roll back exactly one unit's action
 * instead of a whole turn. `unitActions` is usually a single assignment
 * (the UI submits one per pick — see RoundView.tsx) but stays a list for
 * flexibility/ordering when it isn't; each entry resolves fully (via
 * applyUnitActionEffect in ./unitActions.ts, restricted to just that one
 * unit id) before the next begins. A unit already in
 * `resolvedUnitIdsThisTurn`, or given an id that isn't one of the kind's
 * actions, is skipped. Rejects if nothing in the list actually resolved,
 * so a no-op can never produce a vacuous actionHistory entry. Also checks
 * for newly-claimed achievements (see updateAchievementClaims in
 * ./achievements.ts), since create/convert/a destroySelf transform can
 * change how many of a kind a player controls.
 *
 * If this resolve happens to be the acting player's LAST unresolved unit
 * of the played kind, the turn ends automatically right here (via
 * finishActionsTurn) — no separate PASS_ACTIONS needed once there's
 * genuinely nothing left to decide. Still exactly one actionHistory entry
 * either way, since that's just this same dispatch's result.
 *
 * Tale "companion piece" support: a unit whose kind isn't the played
 * card's own kind, but IS one of that kind's companions
 * (unitContent.companionKindsByCardKind — e.g. Port is a companion of
 * Ship), may also act here, using ITS OWN kind's actions (not the played
 * card's). A companion unit created earlier THIS turn may not act at all
 * (every companion Tale states "cannot be activated on the turn it is
 * constructed" — tracked via GameState.unitsCreatedThisTurn); the played
 * card's own kind has no such restriction, so e.g. a Ship freshly built by
 * a Port's Construct a Ship action can still act the same turn.
 */
function applyResolveUnitAction(
  state: GameState,
  playerId: string,
  unitActions: UnitActionAssignment[],
  unitContent: UnitContent,
  achievementContent: AchievementContent,
): ActionResult {
  if (state.roundPhase !== 'actions') {
    return { ok: false, error: 'Not in the action-resolution phase' }
  }
  if (state.pendingPlayerIds[0] !== playerId) {
    return { ok: false, error: "It is not this player's turn to resolve their action" }
  }

  const cardId = state.chosenCardIdByPlayerId[playerId]
  if (!cardId) {
    return { ok: false, error: 'Player has no chosen card to resolve' }
  }
  const card = state.cards[cardId]
  if (!card) {
    return { ok: false, error: `Unknown card: ${cardId}` }
  }
  const companionKinds = unitContent.companionKindsByCardKind[card.kind] ?? []

  let nextState: GameState = state
  const resolvedUnitIds: string[] = []
  let createdThisTurn = [...state.unitsCreatedThisTurn]
  for (const assignment of unitActions) {
    if (state.resolvedUnitIdsThisTurn.includes(assignment.unitId)) continue
    const actingUnit = nextState.units.find((u) => u.id === assignment.unitId)
    if (!actingUnit || actingUnit.ownerId !== playerId) continue
    const isCompanion = actingUnit.kind !== card.kind && companionKinds.includes(actingUnit.kind)
    if (actingUnit.kind !== card.kind && !isCompanion) continue
    if (isCompanion && createdThisTurn.includes(actingUnit.id)) continue // companion piece can't activate the turn it's built

    const unitAction = (unitContent.actionsByKind[actingUnit.kind] ?? []).find((a) => a.id === assignment.actionId)
    if (!unitAction) continue
    const targets = assignment.target ? { [assignment.unitId]: assignment.target } : {}
    const beforeState = nextState
    nextState = applyUnitActionEffect(nextState, playerId, actingUnit.kind, unitAction, targets, unitContent, [assignment.unitId])
    // An action that didn't actually change anything means its
    // preconditions weren't met (e.g. an unaffordable cost, an illegal or
    // missing target, a full supply cap, or — for income/produce/trade — a
    // terrain/adjacency that pays out nothing) — that's a failed action,
    // not this unit's turn, so it's left out of resolvedUnitIds entirely
    // rather than being marked resolved.
    if (nextState === beforeState) continue
    resolvedUnitIds.push(assignment.unitId)
    for (const unit of nextState.units) {
      if (!beforeState.units.some((u) => u.id === unit.id)) createdThisTurn.push(unit.id)
    }
  }

  if (resolvedUnitIds.length === 0) {
    return {
      ok: false,
      error: "No unit action was resolved (already acted this turn, not a legal action for this card/companion, or its cost/target requirements weren't met)",
    }
  }

  const resolvedUnitIdsThisTurn = [...nextState.resolvedUnitIdsThisTurn, ...resolvedUnitIds]
  nextState = { ...nextState, resolvedUnitIdsThisTurn, unitsCreatedThisTurn: createdThisTurn }
  nextState = updateAchievementClaims(nextState, achievementContent, unitContent.unitSupplyCaps)

  const actingUnitIds = nextState.units
    .filter((u) => u.ownerId === playerId && (u.kind === card.kind || companionKinds.includes(u.kind)))
    .filter((u) => u.kind === card.kind || !createdThisTurn.includes(u.id))
    .map((u) => u.id)
  const everyUnitActed = actingUnitIds.every((id) => resolvedUnitIdsThisTurn.includes(id))
  if (everyUnitActed) {
    return finishActionsTurn(nextState, playerId, achievementContent)
  }

  return { ok: true, state: nextState }
}

/**
 * Round step 2's turn-ending action (see PassActionsAction in ./actions.ts):
 * whatever the player already resolved via RESOLVE_UNIT_ACTION stands;
 * every other acting unit of the played card's kind simply does nothing
 * this round — already the default outcome for a unit never resolved, so
 * there's nothing to enumerate here.
 */
function applyPassActions(state: GameState, playerId: string, achievementContent: AchievementContent): ActionResult {
  if (state.roundPhase !== 'actions') {
    return { ok: false, error: 'Not in the action-resolution phase' }
  }
  if (state.pendingPlayerIds[0] !== playerId) {
    return { ok: false, error: "It is not this player's turn to pass" }
  }

  return finishActionsTurn(state, playerId, achievementContent)
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
function applyMoveToDecline(state: GameState, playerId: string, cardId: string, achievementContent: AchievementContent): ActionResult {
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
  // This player (or another still-pending one) might now have nothing left
  // to decline for a required card they haven't supplied yet.
  nextState = eliminatePlayersWithNoCardToDecline(nextState)

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = beginPurchasePhase(nextState, achievementContent)
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
  nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }
  nextState = skipEmptyDeclinePurchasers(nextState)

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
  nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }
  nextState = skipEmptyDeclinePurchasers(nextState)

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = finishRound(nextState, achievementContent)
  }
  return { ok: true, state: nextState }
}
