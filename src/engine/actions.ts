import type { Coordinate } from './types.ts'

// PLACE_TILE / PLACE_UNIT (see ./boardSetup.ts) are the only actions valid
// during `status: 'boardSetup'` — the one-time setup phase before round 1
// (seed the starting water tiles, players place the rest tier by tier,
// then place their three starting units) — every other action below
// requires `status: 'active'`, matching the round sequence in ./round.ts:
// CHOOSE_CARD (phase 1, simultaneous), RESOLVE_UNIT_ACTION / PASS_ACTIONS
// (phase 2, turn order — movement is just another unit-kind action
// resolved here, like create/transform/convert; see applyMove in
// ./unitActions.ts. RESOLVE_UNIT_ACTION resolves one unit immediately and
// can be submitted any number of times for the same player's turn;
// PASS_ACTIONS is the one action that actually ends that turn — see both
// in ./applyAction.ts), MOVE_TO_DECLINE (phase 3, simultaneous, only
// reachable when triggered), PURCHASE_CARD / PASS_PURCHASE (phase 4, turn
// order). Recycle-check and round-end are automatic engine bookkeeping,
// not player actions. CONCEDE is the one exception to all of the above: any
// player may submit it at any point once the game is active, regardless of
// round phase or whose turn it is.

/**
 * Places one tile of the current tier (src/engine/boardGenerationContent.ts's
 * BoardGenerationContent.tiers[0] of whatever's left in GameState.
 * boardSetup.tileTierQueue) — `anchor` is the shape's own {0,0} cell's
 * target board coordinate, `rotationSteps` (0-5) rotates the shape 60°
 * per step before placement. The click/rotate/confirm interaction that
 * arrives at these two values is a client-side concern (the client can
 * preview locally with placedShapeCells()/isLegalTilePlacement() from
 * ./boardGeneration.ts, both pure) — the engine only ever sees the final
 * choice, submitted once, on confirm.
 */
export interface PlaceTileAction {
  type: 'PLACE_TILE'
  playerId: string
  anchor: Coordinate
  rotationSteps: number
}

/** Places one of the player's three starting units (kind: 'city' | 'nomad' | 'ship') at `coord`, during boardSetup's unit-placement sub-phase. */
export interface PlaceUnitAction {
  type: 'PLACE_UNIT'
  playerId: string
  unitKind: string
  coord: Coordinate
}

export interface ChooseCardAction {
  type: 'CHOOSE_CARD'
  playerId: string
  cardId: string
}

/**
 * Retracts the caller's own already-made `selectCards` pick while at least
 * one other player is still pending (RULE_ENFORCEMENT_PLAN.md §4.4's
 * refinement) — the "undo" a player reaches for mid-phase instead of the
 * shared `historyPointer` rewind, since a plain pointer move would also
 * undo whichever other players' entries happen to sit after theirs in
 * `actionHistory`. Legal only while `roundPhase === 'selectCards'` and the
 * caller has a non-null `chosenCardIdByPlayerId` entry (once the phase
 * resolves, `roundPhase` moves on and this is no longer submittable). Puts
 * the caller back in `pendingPlayerIds`; redo is just choosing again, no
 * separate endpoint. No `cardId` payload — there's only ever one thing to
 * retract, the caller's own current pick.
 */
export interface RetractChoiceAction {
  type: 'RETRACT_CHOICE'
  playerId: string
}

/** One acting unit's chosen action (an id from content/units.json's actions[] for the played card's kind) and, if that action needs one, its target hex. */
export interface UnitActionAssignment {
  unitId: string
  actionId: string
  target?: Coordinate
}

export interface ResolveUnitActionAction {
  type: 'RESOLVE_UNIT_ACTION'
  playerId: string
  /**
   * Ordered per-unit action assignments — resolved one at a time, in this
   * exact order, each against the state as it stands after every earlier
   * one in the list (not batched by action id). This is what lets one
   * unit's effect be visible to a later unit's action in the same
   * submission — e.g. a Nomad producing a resource, then a second Nomad
   * spending it to convert. The UI only ever submits one assignment at a
   * time (resolved immediately as the player picks it — see RoundView.tsx
   * — rather than staged behind a batch submit), so in practice that
   * ordering guarantee mostly matters across *separate* RESOLVE_UNIT_ACTION
   * calls now, which is naturally preserved simply by dispatching them in
   * the order the player made each choice. A unit already in
   * `GameState.resolvedUnitIdsThisTurn`, or given an id that isn't one of
   * the kind's actions, is skipped — same "does nothing" outcome as a unit
   * never assigned at all. Doesn't end the player's turn — see
   * PassActionsAction below.
   */
  unitActions: UnitActionAssignment[]
}

/**
 * Round step 2's turn-ending action: whatever units the player already
 * resolved via RESOLVE_UNIT_ACTION stand as chosen; every other acting
 * unit of the played card's kind simply does nothing this round (already
 * the default outcome for any unit not resolved — Pass doesn't need to
 * enumerate them). Moves the chosen card hand -> currentlyPlayed ->
 * discard and advances `pendingPlayerIds` to the next player — the one
 * action in this phase that can end it and move on to decline/purchase.
 */
export interface PassActionsAction {
  type: 'PASS_ACTIONS'
  playerId: string
}

export interface MoveToDeclineAction {
  type: 'MOVE_TO_DECLINE'
  playerId: string
  cardId: string
}

/**
 * Retracts one of the caller's own cards moved to decline earlier in the
 * still-open decline phase — decline's counterpart to RetractChoiceAction
 * above (RULE_ENFORCEMENT_PLAN.md §10's "RETRACT_DECLINE"). Unlike a
 * `selectCards` pick, a player may owe (and so have already moved) more
 * than one card this phase (see beginDeclinePhase, ./round.ts), so this
 * needs `cardId` to say which one — any of the caller's own still-open
 * additions from this phase, not necessarily the most recent, and not
 * gated on having caught up on every card still owed (retracting one
 * doesn't require having nothing else left to decide). Puts `cardId` back
 * wherever it actually came from — hand or discard, per
 * GameState.declineSourceZoneByCardId, which MOVE_TO_DECLINE populates for
 * exactly this purpose — and adds the caller back to `pendingPlayerIds`
 * once. Legal only while `roundPhase === 'decline'` and `cardId` is one of
 * the caller's own additions still standing from *this* phase; an
 * already-public prior round's decline card (never bought back) has no
 * `declineSourceZoneByCardId` entry and so isn't retractable.
 */
export interface RetractDeclineAction {
  type: 'RETRACT_DECLINE'
  playerId: string
  cardId: string
}

export interface PurchaseCardAction {
  type: 'PURCHASE_CARD'
  playerId: string
  cardId: string
}

export interface PassPurchaseAction {
  type: 'PASS_PURCHASE'
  playerId: string
}

/**
 * A player voluntarily gives up, at any point once the game is active —
 * unlike every other action above, not tied to any particular round phase
 * or to it being this player's turn. Treated identically to an automatic
 * no-card elimination (see eliminatePlayer in ./elimination.ts): removed
 * from the board and turn order for the rest of the game, excluded from
 * winning, resources returned to the bank. See applyConcede in
 * ./applyAction.ts for how this chains into whatever phase transition the
 * conceding player's own pending turn would otherwise have blocked.
 */
export interface ConcedeAction {
  type: 'CONCEDE'
  playerId: string
}

/**
 * Rolls the game back by one already-logged action (design change, issue
 * #412: undo/redo used to work by truncating `actionHistory` client-side and
 * stashing what got popped in a client-local, unpersisted `redoStack` —
 * meaning a page reload, a different device, or another player's client
 * could never see or continue a pending redo, and the "undone" action was
 * gone from the log for good). Appended to `actionHistory` like any other
 * action instead — nothing is ever removed from the log, so every client
 * sees the same undo/redo state, and reloading mid-review changes nothing.
 * See ./undoRedo.ts for how the log's actually-in-effect prefix (and thus
 * `GameState` itself) is derived from a history that now may contain these.
 *
 * Like CONCEDE, submittable at any point once the game exists — not tied to
 * any particular round phase or turn order, and (per GamePage.tsx's
 * handleUndo doc comment) not even to a specific seated player: `playerId`
 * is null when nobody in particular is "acting" (e.g. clicked after the game
 * has ended, when no seat is the active one), and otherwise is purely for
 * narration ("Alice undid the last action") — never checked for legality.
 */
export interface UndoAction {
  type: 'UNDO_ACTION'
  playerId: string | null
}

/** Re-applies the most recently undone action — see UndoAction above. No payload: there's only ever one thing to redo, whatever undo/branch history currently points at. */
export interface RedoAction {
  type: 'REDO_ACTION'
  playerId: string | null
}

export type Action =
  | PlaceTileAction
  | PlaceUnitAction
  | ChooseCardAction
  | RetractChoiceAction
  | ResolveUnitActionAction
  | PassActionsAction
  | MoveToDeclineAction
  | RetractDeclineAction
  | PurchaseCardAction
  | PassPurchaseAction
  | ConcedeAction
  | UndoAction
  | RedoAction

/**
 * One entry in `GameState.actionHistory` — event sourcing: every action
 * that was actually accepted and applied, in order, so the game's current
 * state is always reconstructable by replaying this history from genesis
 * (see replayActions in ./replay.ts). `turn` and `timestamp` are metadata
 * only — replay never depends on either, only on `action` itself and the
 * order entries appear in.
 */
export interface LoggedAction {
  action: Action
  turn: number
  timestamp: string
}
