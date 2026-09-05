import type { Action, ChooseCardAction, LoggedAction, MoveToDeclineAction, PlaceTileAction, UnitActionAssignment } from './actions.ts'
import type { AchievementContent } from './achievementContent.ts'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent.ts'
import { updateAchievementClaims } from './achievements.ts'
import { moveCard, syncCardZonesWithBoard } from './cards.ts'
import { eliminatePlayer, eliminatePlayersWithNoCardToDecline } from './elimination.ts'
import { findForcedPlacement } from './boardGeneration.ts'
import { calculatePurchaseCost } from './purchaseCost.ts'
import { spendResource } from './resources.ts'
import { beginActionsPhase, beginPostActionsPhase, beginPurchasePhase, finishRound, skipEmptyDeclinePurchasers } from './round.ts'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent.ts'
import type { BoardGenerationContent } from './boardGenerationContent.ts'
import { currentTilePlacerId, placeTile, placeUnit } from './boardSetup.ts'
import { EMPTY_TALE_CONTENT } from './taleContent.ts'
import type { TaleContent } from './taleContent.ts'
import { companionKindsByCardKind } from './tales.ts'
import type { ActionResult, GameState } from './types.ts'
import { EMPTY_UNIT_CONTENT } from './unitContent.ts'
import type { UnitContent } from './unitContent.ts'
import { applyUnitActionEffect } from './unitActions.ts'

export type { ActionResult } from './types.ts'

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
 * ./boardGenerationContent.ts) drives PLACE_TILE. `taleContent`
 * (content/tales.json's Fantastic Events for the game's active Tales —
 * see TaleContent in ./taleContent.ts) drives Fantastic Event resolution
 * once the purchase phase finishes (see finishRound in ./round.ts). All
 * four are optional and default to empty so callers that don't touch that
 * content aren't forced to pass it.
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
 *
 * `trustedReplay` skips PLACE_TILE's legality/room-search recheck (see
 * placeTile's `skipLegalityCheck` in ./boardSetup.ts) — safe only for an
 * action already known-legal, i.e. one being *replayed* from
 * actionHistory rather than freshly submitted by a player: pass `true`
 * from a reconstruction path (replayActions, gameLog's
 * extendGameLog, turnReview's buildTurnReview), never from a live
 * submission, which still needs the real check to reject an actually
 * illegal placement.
 */
export function applyAction(
  state: GameState,
  action: Action,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
  trustedReplay = false,
): ActionResult {
  const result = dispatchAction(resyncUnitMovementFromContent(state, unitContent), action, unitContent, achievementContent, boardGenerationContent, taleContent, trustedReplay)
  if (!result.ok) return result

  // `state.turn` (before dispatch), NOT `result.state.turn` — a decline/
  // purchase action that happens to be the one that finishes the round
  // chains straight through finishRound (./round.ts) in this same call,
  // which increments the turn counter before this log entry is created.
  // Logging the post-chain value would tag that one action as having
  // happened on the round it just finished *into* rather than the round it
  // actually resolved, both misattributing it away from its own round's
  // recap (issue #328) and, worse, colliding with a genuine action logged
  // for the new round later on, since both would then share the same
  // `turn` number.
  const loggedAction: LoggedAction = { action, turn: state.turn, timestamp: new Date().toISOString() }
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
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): ActionResult {
  const result = applyAction(state, action, unitContent, achievementContent, boardGenerationContent, taleContent)
  if (!result.ok || action.type !== 'PLACE_TILE') return result

  let nextState = result.state
  for (
    let forced = nextTileFastForward(nextState, boardGenerationContent);
    forced;
    forced = nextTileFastForward(nextState, boardGenerationContent)
  ) {
    // trustedReplay: `forced` was just derived by findForcedPlacement's own
    // combinatorial search, so it's already known-legal by construction —
    // re-running checkTilePlacementLegality's search on top of the search
    // that produced it would be pure waste.
    const cascadeResult = applyAction(nextState, forced, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!cascadeResult.ok) break // defensive only — findForcedPlacement's own combo is always legal by construction
    nextState = cascadeResult.state
  }
  return { ok: true, state: nextState }
}

/**
 * RULE_ENFORCEMENT_PLAN.md §4.3's generalization of the tile fast-forward
 * above to the round's own simultaneous-choice phases: a still-pending
 * player with only one legal way left to fulfil what they owe isn't making
 * a real decision either, so live submission shouldn't wait on them to
 * click it. For a client-trusted (`ruleEnforcementEnabled: false`) game,
 * `RoundView.tsx`'s SelectCardsPanel still auto-submits the single-hand-card
 * case client-side as a courtesy — but a `ruleEnforcementEnabled` game must
 * never have its UI submit an action the player didn't actually click, so
 * that component skips its own auto-submit entirely for those games and
 * relies solely on this function running server-side in `apply-action`
 * (`supabase/functions/_shared/gameEnforcement.ts`) instead.
 *
 * Unlike applyActionAndFastForwardTiles, this isn't gated on the
 * just-submitted action's type: a forced selectCards/decline condition can
 * just as easily appear at the start of a new round (e.g. a hand thinned by
 * an earlier decline) as right after the triggering action itself, so every
 * accepted action rechecks — cheaply, since nextChoiceFastForward returns
 * null immediately outside those two phases.
 */
export function applyActionAndFastForwardChoices(
  state: GameState,
  action: Action,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): ActionResult {
  const result = applyAction(state, action, unitContent, achievementContent, boardGenerationContent, taleContent)
  if (!result.ok) return result
  return { ok: true, state: fastForwardPendingChoices(result.state, unitContent, achievementContent, boardGenerationContent, taleContent) }
}

/**
 * The forcing loop behind applyActionAndFastForwardChoices, factored out so
 * a caller that already has a poststate in hand (e.g. `apply-action` after
 * running applyActionAndFastForwardTiles, whose own PLACE_TILE-gated loop
 * never checks for a newly-forced selectCards pick the moment boardSetup
 * finishes) can run it without resubmitting an action that already landed.
 */
export function fastForwardPendingChoices(
  state: GameState,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): GameState {
  let nextState = state
  for (
    let forced = nextChoiceFastForward(nextState);
    forced;
    forced = nextChoiceFastForward(nextState)
  ) {
    // trustedReplay: `forced` was derived directly from state neither
    // dispatch handler treats as ambiguous (a single remaining hand card; a
    // hand+discard that exactly matches what's still owed) — already
    // known-legal by construction, same reasoning as the tile cascade above.
    const cascadeResult = applyAction(nextState, forced, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!cascadeResult.ok) break // defensive only — nextChoiceFastForward's picks are always legal by construction
    nextState = cascadeResult.state
  }
  return nextState
}

/** The next forced CHOOSE_CARD/MOVE_TO_DECLINE to submit, or null once no longer forced — see applyActionAndFastForwardChoices. */
function nextChoiceFastForward(state: GameState): ChooseCardAction | MoveToDeclineAction | null {
  if (state.roundPhase === 'selectCards') return nextSelectCardsFastForward(state)
  if (state.roundPhase === 'decline') return nextDeclineFastForward(state)
  return null
}

/** A pending player with exactly one hand card has no real pick left to make. */
function nextSelectCardsFastForward(state: GameState): ChooseCardAction | null {
  for (const playerId of state.pendingPlayerIds) {
    const player = state.players.find((p) => p.id === playerId)
    if (player && player.handCardIds.length === 1) {
      return { type: 'CHOOSE_CARD', playerId, cardId: player.handCardIds[0] }
    }
  }
  return null
}

/**
 * A pending player whose hand+discard together contain exactly as many
 * cards as they still owe this phase (counting each of their own
 * occurrences in `pendingPlayerIds`) has no real choice left either — every
 * one of those cards is going to decline regardless of the order it's
 * submitted in. Scans in `pendingPlayerIds` order, considering each
 * distinct player once regardless of how many times they appear.
 */
function nextDeclineFastForward(state: GameState): MoveToDeclineAction | null {
  const seen = new Set<string>()
  for (const playerId of state.pendingPlayerIds) {
    if (seen.has(playerId)) continue
    seen.add(playerId)
    const owed = state.pendingPlayerIds.filter((id) => id === playerId).length
    const player = state.players.find((p) => p.id === playerId)
    if (!player) continue
    const available = [...player.handCardIds, ...player.discardCardIds]
    if (available.length === owed) {
      return { type: 'MOVE_TO_DECLINE', playerId, cardId: available[0] }
    }
  }
  return null
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

/**
 * Refreshes every on-board unit's `movement` profile from `unitContent`
 * (keyed by kind) before an action is dispatched. Unit.movement is a copy
 * stamped once, at the moment a unit is created (placeUnit/applyCreate/
 * applyTransform) — a later content-driven rules fix (e.g. a corrected
 * canCrossCliffs) would otherwise never reach a unit already on the
 * board, only ones created afterward. Every acting player's next action
 * self-heals the whole game's units against whatever content is current,
 * same convergence idea as syncCardZonesWithBoard (./cards.ts) for card
 * zones. Returns the same state reference when nothing actually changed
 * (a content-less caller, or a kind with no movement in unitContent), so
 * this never spuriously affects no-op detection deeper in the dispatch.
 */
function resyncUnitMovementFromContent(state: GameState, unitContent: UnitContent): GameState {
  let changed = false
  const units = state.units.map((unit) => {
    const movement = unitContent.movementByKind[unit.kind]
    if (!movement || JSON.stringify(movement) === JSON.stringify(unit.movement)) return unit
    changed = true
    return { ...unit, movement }
  })
  return changed ? { ...state, units } : state
}

function dispatchAction(
  state: GameState,
  action: Action,
  unitContent: UnitContent,
  achievementContent: AchievementContent,
  boardGenerationContent: BoardGenerationContent,
  taleContent: TaleContent,
  trustedReplay: boolean,
): ActionResult {
  if (action.type === 'PLACE_TILE') {
    return placeTile(state, action.playerId, action.anchor, action.rotationSteps, boardGenerationContent, trustedReplay)
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
    case 'RETRACT_CHOICE':
      return applyRetractChoice(state, action.playerId)
    case 'RESOLVE_UNIT_ACTION':
      return applyResolveUnitAction(state, action.playerId, action.unitActions, unitContent, achievementContent, taleContent)
    case 'PASS_ACTIONS':
      return applyPassActions(state, action.playerId, achievementContent, taleContent)
    case 'MOVE_TO_DECLINE':
      return applyMoveToDecline(state, action.playerId, action.cardId, achievementContent, taleContent)
    case 'RETRACT_DECLINE':
      return applyRetractDecline(state, action.playerId, action.cardId)
    case 'PURCHASE_CARD':
      return applyPurchaseCard(state, action.playerId, action.cardId, achievementContent, taleContent)
    case 'PASS_PURCHASE':
      return applyPassPurchase(state, action.playerId, achievementContent, taleContent)
    case 'CONCEDE':
      return applyConcede(state, action.playerId, achievementContent, taleContent)
    case 'UNDO_ACTION':
    case 'REDO_ACTION':
      // Unlike every other action, undo/redo aren't a forward step from
      // `state` — they're a shorter/longer replay from genesis (see
      // UndoAction's doc comment in ./actions.ts and resolveHistory in
      // ./historyFold.ts). applyAction() has no genesis to do that with;
      // live callers submit these via applyUndoAction/applyRedoAction
      // (./undoRedo.ts) instead, which append the entry and re-derive state
      // via replayActions() — the one place that knows how to fold these in.
      return { ok: false, error: `${action.type} must be submitted via applyUndoAction/applyRedoAction, not applyAction` }
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
 * See RetractChoiceAction (./actions.ts) for the "why" — this is the
 * compensating action §4.4 calls for instead of a shared pointer rewind.
 * Legal exactly while the caller has a pick standing from this same
 * `selectCards` phase: `roundPhase === 'selectCards'` already implies the
 * phase hasn't resolved (the moment the last pending player chooses,
 * applyChooseCard above flips it to `'actions'`), so the only other check
 * needed is that this player actually has something to retract.
 */
function applyRetractChoice(state: GameState, playerId: string): ActionResult {
  if (state.roundPhase !== 'selectCards') {
    return { ok: false, error: 'Cards can only be retracted during the select-cards phase' }
  }
  const player = state.players.find((p) => p.id === playerId)
  if (player?.eliminated) {
    return { ok: false, error: 'Eliminated players cannot retract a choice' }
  }
  if (state.chosenCardIdByPlayerId[playerId] == null) {
    return { ok: false, error: 'This player has not chosen a card yet this round' }
  }

  const nextState: GameState = {
    ...state,
    chosenCardIdByPlayerId: { ...state.chosenCardIdByPlayerId, [playerId]: null },
    pendingPlayerIds: [...state.pendingPlayerIds, playerId],
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
function finishActionsTurn(state: GameState, playerId: string, achievementContent: AchievementContent, taleContent: TaleContent): ActionResult {
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
    nextState = beginPostActionsPhase(nextState, achievementContent, taleContent)
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
  taleContent: TaleContent,
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
    const actingUnit = nextState.units.find((u) => u.id === assignment.unitId)
    if (!actingUnit || actingUnit.ownerId !== playerId) continue
    const isCompanion = actingUnit.kind !== card.kind && companionKinds.includes(actingUnit.kind)
    if (actingUnit.kind !== card.kind && !isCompanion) continue
    if (isCompanion && createdThisTurn.includes(actingUnit.id)) continue // companion piece can't activate the turn it's built

    // How many times this unit may act this turn — usually 1 (".includes"'s
    // old boolean shape), but a Tale companion can double-activate off its
    // parent card (e.g. The Capital Tale: activationsPerTurnByKind.capital
    // === 2) — see UnitContent.activationsPerTurnByKind's doc comment.
    // Counts both already-committed prior turns' worth of resolutions
    // (state.resolvedUnitIdsThisTurn) and any within this same call
    // (resolvedUnitIds so far), so a caller batching >1 assignment for the
    // same unit in one RESOLVE_UNIT_ACTION can't exceed the cap either.
    const activationsCap = unitContent.activationsPerTurnByKind[actingUnit.kind] ?? 1
    const timesAlreadyResolved =
      state.resolvedUnitIdsThisTurn.filter((id) => id === assignment.unitId).length +
      resolvedUnitIds.filter((id) => id === assignment.unitId).length
    if (timesAlreadyResolved >= activationsCap) continue

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

  const actingUnits = nextState.units
    .filter((u) => u.ownerId === playerId && (u.kind === card.kind || companionKinds.includes(u.kind)))
    .filter((u) => u.kind === card.kind || !createdThisTurn.includes(u.id))
  const everyUnitActed = actingUnits.every((u) => {
    const activationsCap = unitContent.activationsPerTurnByKind[u.kind] ?? 1
    return resolvedUnitIdsThisTurn.filter((id) => id === u.id).length >= activationsCap
  })
  if (everyUnitActed) {
    return finishActionsTurn(nextState, playerId, achievementContent, taleContent)
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
function applyPassActions(state: GameState, playerId: string, achievementContent: AchievementContent, taleContent: TaleContent): ActionResult {
  if (state.roundPhase !== 'actions') {
    return { ok: false, error: 'Not in the action-resolution phase' }
  }
  if (state.pendingPlayerIds[0] !== playerId) {
    return { ok: false, error: "It is not this player's turn to pass" }
  }

  return finishActionsTurn(state, playerId, achievementContent, taleContent)
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
function applyMoveToDecline(
  state: GameState,
  playerId: string,
  cardId: string,
  achievementContent: AchievementContent,
  taleContent: TaleContent,
): ActionResult {
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
  const fromZone: 'hand' | 'discard' = player.handCardIds.includes(cardId) ? 'hand' : 'discard'

  const nextPlayer = moveCard(player, cardId, 'decline')
  const players = [...state.players]
  players[playerIndex] = nextPlayer

  let nextState: GameState = {
    ...state,
    players,
    pendingPlayerIds: removeOneOccurrence(state.pendingPlayerIds, playerId),
    // See RetractDeclineAction (./actions.ts) for why this is tracked: it's
    // what lets a later RETRACT_DECLINE put the card back where it actually
    // came from.
    declineSourceZoneByCardId: { ...state.declineSourceZoneByCardId, [cardId]: fromZone },
  }
  // This player (or another still-pending one) might now have nothing left
  // to decline for a required card they haven't supplied yet.
  nextState = eliminatePlayersWithNoCardToDecline(nextState)

  // That elimination may have already ended the game outright
  // (eliminatePlayer's last-player-standing check, ./elimination.ts) — skip
  // chaining into the purchase phase in that case, same as round.ts's own
  // post-elimination chain points.
  if (nextState.status !== 'completed' && nextState.pendingPlayerIds.length === 0) {
    nextState = beginPurchasePhase(nextState, achievementContent, taleContent)
  }
  return { ok: true, state: nextState }
}

/**
 * See RetractDeclineAction (./actions.ts) for the "why" — decline's
 * counterpart to applyRetractChoice above, complicated by a player being
 * able to owe (and so have already moved) more than one card this phase.
 * Legal exactly while `cardId` is one of the caller's own additions still
 * standing from the *currently open* decline phase: `declineCardIds`
 * confirms it's genuinely still there (not already bought back in some
 * earlier round, nor already retracted), and
 * `declineSourceZoneByCardId[cardId]` — populated by applyMoveToDecline,
 * reset fresh every beginDeclinePhase (./round.ts) — confirms it was
 * *this* phase's addition rather than an already-public prior round's
 * (which has no entry and so isn't retractable).
 */
function applyRetractDecline(state: GameState, playerId: string, cardId: string): ActionResult {
  if (state.roundPhase !== 'decline') {
    return { ok: false, error: 'Decline can only be retracted during the decline phase' }
  }

  const playerIndex = state.players.findIndex((p) => p.id === playerId)
  if (playerIndex === -1) {
    return { ok: false, error: `Unknown player: ${playerId}` }
  }
  const player = state.players[playerIndex]
  if (player.eliminated) {
    return { ok: false, error: 'Eliminated players cannot retract decline' }
  }
  if (!player.declineCardIds.includes(cardId)) {
    return { ok: false, error: "This card is not currently in this player's decline" }
  }
  const fromZone = state.declineSourceZoneByCardId?.[cardId]
  if (!fromZone) {
    return { ok: false, error: 'This card was not added to decline during the current phase' }
  }

  const nextPlayer = moveCard(player, cardId, fromZone)
  const players = [...state.players]
  players[playerIndex] = nextPlayer

  const declineSourceZoneByCardId = { ...state.declineSourceZoneByCardId }
  delete declineSourceZoneByCardId[cardId]

  const nextState: GameState = {
    ...state,
    players,
    pendingPlayerIds: [...state.pendingPlayerIds, playerId],
    declineSourceZoneByCardId,
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
function applyPurchaseCard(
  state: GameState,
  playerId: string,
  cardId: string,
  achievementContent: AchievementContent,
  taleContent: TaleContent,
): ActionResult {
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
  nextState = syncCardZonesWithBoard(nextState, companionKindsByCardKind(taleContent))
  nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }
  nextState = skipEmptyDeclinePurchasers(nextState, achievementContent)

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = finishRound(nextState, achievementContent, taleContent)
  }
  return { ok: true, state: nextState }
}

/** Round step 4: a player declines their opportunity to buy a card back from decline. */
function applyPassPurchase(
  state: GameState,
  playerId: string,
  achievementContent: AchievementContent,
  taleContent: TaleContent,
): ActionResult {
  if (state.roundPhase !== 'purchase') {
    return { ok: false, error: 'Not in the purchase phase' }
  }
  if (state.pendingPlayerIds[0] !== playerId) {
    return { ok: false, error: "It is not this player's turn in the purchase phase" }
  }

  let nextState: GameState = { ...state, pendingPlayerIds: state.pendingPlayerIds.slice(1) }
  nextState = { ...nextState, activePlayerId: nextState.pendingPlayerIds[0] ?? null }
  nextState = skipEmptyDeclinePurchasers(nextState, achievementContent)

  if (nextState.pendingPlayerIds.length === 0) {
    nextState = finishRound(nextState, achievementContent, taleContent)
  }
  return { ok: true, state: nextState }
}

/**
 * A player concedes: treated exactly like eliminatePlayer's automatic
 * no-card eliminations (./elimination.ts) — removed from the board/turn
 * order for good, excluded from winning, resources returned to the bank —
 * except it can happen at ANY point while the game is active, not just when
 * a phase's own elimination check runs. That's the one thing this needs to
 * handle that eliminatePlayer's other two callers
 * (eliminatePlayersWithNoCardToPlay/eliminatePlayersWithNoCardToDecline)
 * don't: a conceding player may still be owed something in the current
 * phase (a card choice, an action-phase turn, a decline, a purchase
 * decision) that nobody else can supply for them, so removing them from
 * pendingPlayerIds can itself be what completes the phase — same as
 * applyChooseCard/finishActionsTurn/applyMoveToDecline/applyPassPurchase
 * each already chain forward when their own removal empties
 * pendingPlayerIds. Skipped if the elimination already ended the game
 * outright (eliminatePlayer's last-player-standing check), same as every
 * other post-elimination chain point.
 */
function applyConcede(state: GameState, playerId: string, achievementContent: AchievementContent, taleContent: TaleContent): ActionResult {
  const player = state.players.find((p) => p.id === playerId)
  if (!player) {
    return { ok: false, error: `Unknown player: ${playerId}` }
  }
  if (player.eliminated) {
    return { ok: false, error: 'Player is already eliminated' }
  }

  let nextState = eliminatePlayer(state, playerId, true)
  if (nextState.status === 'completed' || nextState.pendingPlayerIds.length > 0) {
    return { ok: true, state: nextState }
  }

  switch (nextState.roundPhase) {
    case 'selectCards':
      nextState = beginActionsPhase(nextState)
      break
    case 'actions':
      nextState = beginPostActionsPhase(nextState, achievementContent, taleContent)
      break
    case 'decline':
      nextState = beginPurchasePhase(nextState, achievementContent, taleContent)
      break
    case 'purchase':
      nextState = finishRound(nextState, achievementContent, taleContent)
      break
  }
  return { ok: true, state: nextState }
}
