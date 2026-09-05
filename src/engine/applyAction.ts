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
 * Per jinxbit's 2026-09-05 design update (RULE_ENFORCEMENT_PLAN.md
 * §4.2/§4.3): once `action` lands, any forced single-option follow-up it
 * leaves behind (a one-card hand's CHOOSE_CARD, a hand+discard that exactly
 * matches what's still owed, a tile placement with only one legal
 * arrangement left) isn't a real decision for anyone to make — nobody
 * "did" it, so it doesn't get its own `actionHistory` entry either. Instead
 * runActionAndForcedFollowUps below keeps dispatching whatever's forced,
 * converging to a fixed point, all folded into the SAME log entry as
 * `action` itself, the same way an ordinary phase transition
 * (beginActionsPhase/finishRound/eliminatePlayersWithNoCardToDecline/etc.)
 * already chains forward within one dispatch rather than becoming its own
 * entry. This is exactly why `applyAction` stays a pure one-action-in,
 * one-log-entry-out reducer even though it may internally dispatch more
 * than one Action: replayActions() (./replay.ts) calls this once per
 * already-logged entry to reconstruct state, and since the forced
 * follow-ups are a deterministic function of state, replaying just `action`
 * again reproduces the exact same cascade — nothing about it needs (or
 * gets) its own entry to replay from. gameLog.ts's narration wants the
 * step-by-step breakdown back for display purposes only; see
 * applyActionWithSteps below for that.
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
  const result = applyActionWithSteps(state, action, unitContent, achievementContent, boardGenerationContent, taleContent, trustedReplay)
  if (!result.ok) return result
  return { ok: true, state: result.state }
}

/** One dispatched step behind a single applyAction() call — either `action` itself or one of the forced follow-ups it converged to. See applyActionWithSteps. */
export interface ActionStep {
  action: Action
  before: GameState
  after: GameState
}

/**
 * Same as applyAction above, but also returns the full step-by-step
 * breakdown — `action` itself, plus every forced follow-up folded into its
 * same log entry, in the order they were actually dispatched, each with its
 * own before/after pair. Exists purely so gameLog.ts can narrate every step
 * exactly like an ordinary action (same describePrimaryAction it already
 * uses for a player-submitted one) without any of them needing to be a
 * separate actionHistory entry — "the log line should be derived from what
 * happened," not from a stored `automatic` flag. Every other caller wants
 * applyAction's plain ActionResult instead.
 */
export function applyActionWithSteps(
  state: GameState,
  action: Action,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
  trustedReplay = false,
): { ok: true; state: GameState; steps: ActionStep[] } | { ok: false; error: string } {
  const steps = runActionAndForcedFollowUps(state, action, unitContent, achievementContent, boardGenerationContent, taleContent, trustedReplay)
  if (!steps.ok) return steps
  // A stale forced follow-up (see isStaleForcedFollowUp below) has nothing
  // left to do — `state` already reflects it, folded into the PRECEDING
  // entry's own cascade, so there's no new step and no new actionHistory
  // entry to append.
  if (steps.steps.length === 0) return { ok: true, state, steps: [] }

  // `state.turn` (before dispatch), NOT the converged state's `turn` — a
  // decline/purchase action that happens to be the one that finishes the
  // round chains straight through finishRound (./round.ts) in this same
  // call, which increments the turn counter before this log entry is
  // created. Logging the post-chain value would tag that one action as
  // having happened on the round it just finished *into* rather than the
  // round it actually resolved, both misattributing it away from its own
  // round's recap (issue #328) and, worse, colliding with a genuine action
  // logged for the new round later on, since both would then share the
  // same `turn` number.
  const finalState = steps.steps[steps.steps.length - 1].after
  const loggedAction: LoggedAction = { action, turn: state.turn, timestamp: new Date().toISOString() }
  return { ok: true, state: { ...finalState, actionHistory: [...finalState.actionHistory, loggedAction] }, steps: steps.steps }
}

/**
 * The actual dispatch behind applyAction/applyActionWithSteps above:
 * dispatches `action`, then keeps dispatching whatever nextForcedFollowUp
 * derives from the resulting state — a still-pending player with only one
 * legal way left to fulfil what they owe (a one-card hand; a hand+discard
 * that exactly matches what's still owed) or a tile tier with only one
 * legal arrangement left for its remaining tiles — until nothing's forced
 * anymore. Every step (`action` itself and each forced follow-up) is just
 * an ordinary dispatchAction call; none of them touch `actionHistory`
 * directly, that's applyActionWithSteps' job once the whole cascade has
 * settled. `trustedReplay` only ever applies to `action` itself — every
 * forced follow-up's own legality was already proven by construction (the
 * combinatorial search behind findForcedPlacement, or the exact
 * card-count match behind nextChoiceFastForward), so those are always
 * dispatched with trustedReplay: true regardless of what the caller passed
 * for the triggering action.
 */
function runActionAndForcedFollowUps(
  state: GameState,
  action: Action,
  unitContent: UnitContent,
  achievementContent: AchievementContent,
  boardGenerationContent: BoardGenerationContent,
  taleContent: TaleContent,
  trustedReplay: boolean,
): { ok: true; steps: ActionStep[] } | { ok: false; error: string } {
  const primary = dispatchAction(resyncUnitMovementFromContent(state, unitContent), action, unitContent, achievementContent, boardGenerationContent, taleContent, trustedReplay)
  if (!primary.ok) {
    // trustedReplay-only: a game whose actionHistory predates this fold-in
    // design (see isStaleForcedFollowUp's own doc comment below) can have a
    // standalone entry for what's now folded into its triggering action's
    // own cascade — replay already took it a step earlier, so there's
    // nothing left for this entry to do. Never taken for a live submission
    // (trustedReplay is always false there), so a player genuinely
    // resubmitting a stale action still gets a real rejection.
    if (trustedReplay && isStaleForcedFollowUp(state, action)) return { ok: true, steps: [] }
    return primary
  }
  const steps: ActionStep[] = [{ action, before: state, after: primary.state }]

  for (
    let forced = nextForcedFollowUp(steps[steps.length - 1].after, boardGenerationContent);
    forced;
    forced = nextForcedFollowUp(steps[steps.length - 1].after, boardGenerationContent)
  ) {
    const before = steps[steps.length - 1].after
    const result = dispatchAction(before, forced, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!result.ok) break // defensive only — nextForcedFollowUp's picks are always legal by construction
    steps.push({ action: forced, before, after: result.state })
  }

  return { ok: true, steps }
}

/**
 * The next forced follow-up the state machine would take on its own out of
 * `state`, or null once nothing's currently forced — see applyAction's own
 * doc comment for why this now runs INSIDE every applyAction() call instead
 * of a live-submission-only wrapper. boardSetup's tile placement and the
 * round's card-choice/decline phases are mutually exclusive by
 * GameState.status, so checking both unconditionally on every step of the
 * convergence loop (runActionAndForcedFollowUps above) is cheap and
 * correct rather than gating on whatever action triggered it — each check
 * itself returns null immediately outside the one phase it cares about.
 */
function nextForcedFollowUp(state: GameState, boardGenerationContent: BoardGenerationContent): ChooseCardAction | MoveToDeclineAction | PlaceTileAction | null {
  return nextTileFastForward(state, boardGenerationContent) ?? nextChoiceFastForward(state)
}

/** The round-phase half of nextForcedFollowUp — a forced selectCards/decline pick can appear at the start of a new round (e.g. a hand thinned by an earlier decline) just as easily as right after the triggering action itself. */
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

/**
 * Whether `action` is a forced single-option follow-up (CHOOSE_CARD/
 * MOVE_TO_DECLINE/PLACE_TILE) that's already been taken by the time replay
 * reaches it — i.e. `state` has no room left for it to apply. Only ever
 * consulted for `trustedReplay` (see runActionAndForcedFollowUps above): a
 * game whose actionHistory has entries logged before jinxbit's 2026-09-05
 * "second follow-up" design (RULE_ENFORCEMENT_PLAN.md §4.2) — when a forced
 * pick still landed its own standalone actionHistory entry (or, earlier
 * still, RoundView.tsx's client-side auto-submit logged one as an
 * indistinguishable ordinary action) — has such entries baked in
 * permanently, since actionHistory is append-only and never rewritten.
 * Today's applyAction already takes the identical, deterministic forced
 * pick one step earlier, folded into the PRECEDING entry's own cascade, so
 * replaying this entry on its own has nothing left to do.
 *
 * Recognized by the exact same "no longer pending"/"not their turn"
 * condition each handler itself already rejects on (applyChooseCard/
 * applyMoveToDecline/placeTile above), rather than by matching error text,
 * so a genuinely-corrupt or out-of-order entry — rejected for any other
 * reason — still surfaces as a real replay failure instead of being
 * silently swallowed.
 */
function isStaleForcedFollowUp(state: GameState, action: Action): boolean {
  switch (action.type) {
    case 'CHOOSE_CARD':
      return state.roundPhase !== 'selectCards' || !state.pendingPlayerIds.includes(action.playerId)
    case 'MOVE_TO_DECLINE':
      return state.roundPhase !== 'decline' || !state.pendingPlayerIds.includes(action.playerId)
    case 'PLACE_TILE':
      return state.status !== 'boardSetup' || currentTilePlacerId(state) !== action.playerId
    default:
      return false
  }
}

/** The tile half of nextForcedFollowUp — a tier whose remaining tiles have only one possible arrangement left, per findForcedPlacement (./boardGeneration.ts), rolling naturally into a newly-forced next tier too. */
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
