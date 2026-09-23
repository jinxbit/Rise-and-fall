import type { Action, ChooseCardAction, LoggedAction, MoveToDeclineAction, PurchaseCardAction, RetractDeclineAction } from './actions.ts'
import { resolveHistory } from './historyFold.ts'
import { applyStatePatch, diffState, type StatePatch } from './statePatch.ts'
import type { GameEvent, GameState, Player } from './types.ts'

/**
 * A player's simultaneous-phase card pick (GameState.chosenCardIdByPlayerId),
 * as seen by a particular viewer: reveals *that* a choice was made, but not
 * *which* card, while it's still secret from that viewer — see
 * redactStateForPlayer below.
 */
export type RedactedChoice = { chosen: false } | { chosen: true; cardId: string | null }

export type RedactedPlayer = Omit<Player, 'declineCardIds'> & {
  /**
   * Same array as Player.declineCardIds, with two kinds of edits, both from
   * redactStateForPlayer: entries added during the current, still-unresolved
   * decline phase by someone other than the viewer are replaced with `null`
   * (dropping the length/order guarantee this field used to have — a card
   * bought back from decline this same phase, see below, is appended rather
   * than replaced in place, since there's no original slot to put it back
   * in). A card someone other than the viewer has bought back from decline
   * during the current, still-unresolved purchase phase is added back here
   * (with its real id — decline piles are always public, per
   * HIDDEN_INFORMATION_PLAN.md §2, so which cards are in one isn't the
   * secret; only *that this one just left* is, the same "secret is the pick,
   * not the pile" shape CHOOSE_CARD already has against a fully-public
   * hand), and is filtered out of that player's `handCardIds` below so it
   * doesn't also, contradictorily, show up as newly arrived there.
   */
  declineCardIds: (string | null)[]
}

/**
 * One GameState.actionHistory entry as seen by a particular viewer — the raw
 * log carries the same secrets chosenCardIdByPlayerId/declineCardIds do (a
 * CHOOSE_CARD/MOVE_TO_DECLINE action's own `cardId` payload), so a reader
 * who only had those two fields nulled could still recover a still-secret
 * pick straight out of the log (see redactStateForPlayer's doc comment). A
 * single-card RETRACT_DECLINE carries that exact same secret right back out
 * again — retracting a card that's still masked in an earlier MOVE_TO_DECLINE
 * entry would otherwise let the *retraction's own* payload reveal what the
 * addition didn't (issue #505) — so it's masked under the identical
 * condition. A PURCHASE_CARD entry gets the same treatment while the
 * simultaneous purchase phase it belongs to is still unresolved (issue
 * #600) — the same "which card, not whether one moved" secret CHOOSE_CARD/
 * MOVE_TO_DECLINE already keep. Every other action type passes through with
 * its real payload unchanged — this is not a general Action-redaction
 * mechanism, just these four fields.
 */
export type RedactedLoggedAction = Omit<LoggedAction, 'action'> & {
  action:
    | Exclude<Action, ChooseCardAction | MoveToDeclineAction | RetractDeclineAction | PurchaseCardAction>
    | (Omit<ChooseCardAction, 'cardId'> & { cardId: string | null })
    | (Omit<MoveToDeclineAction, 'cardId'> & { cardId: string | null })
    | (Omit<RetractDeclineAction, 'cardId'> & { cardId?: string | null })
    | (Omit<PurchaseCardAction, 'cardId'> & { cardId: string | null })
}

export type RedactedGameState = Omit<GameState, 'chosenCardIdByPlayerId' | 'players' | 'actionHistory'> & {
  chosenCardIdByPlayerId: Record<string, RedactedChoice>
  players: RedactedPlayer[]
  /**
   * Not replayable through applyAction()/replayActions() — a masked
   * CHOOSE_CARD/MOVE_TO_DECLINE entry's `cardId: null` is not a legal action
   * payload. This is a display-only log for a viewer who isn't entitled to
   * the real one yet; genesis + replay always uses the real, unredacted
   * GameState.actionHistory. See get-game-state/index.ts, the only caller.
   */
  actionHistory: RedactedLoggedAction[]
}

/**
 * Read-side view of GameState for a specific viewer (`viewerId`, one of
 * GameState.players[].id, or `null` for a non-player observer — same
 * convention as redactGameLog below). Masks the two windows
 * of transient hidden information the game has per
 * HIDDEN_INFORMATION_PLAN.md §2/§5.1:
 *
 * - While `roundPhase === 'selectCards'` and any player is still pending,
 *   another player's already-made pick is visible as "they've chosen" but
 *   not *what* they chose.
 * - While `roundPhase === 'decline'`, cards another player has moved to
 *   decline *during this still-in-progress phase* are hidden; their
 *   already-public decline pile from earlier rounds is not.
 * - While `roundPhase === 'purchase'`, a card another player has bought back
 *   from decline *during this still-in-progress phase* still shows as if it
 *   were in decline (issue #600). The purchase phase became simultaneous in
 *   issue #553 ("the same shape as selectCards/decline") but was
 *   deliberately left unmasked at the time on the reasoning that a player's
 *   decline pile was already public either way (todo.md #97) — true of the
 *   pile's *contents*, but once the phase is simultaneous, *which* card a
 *   still-pending player just bought back is exactly the same secret
 *   CHOOSE_CARD already keeps against a fully-public hand, and the VP a
 *   bought-back card's units immediately start contributing again
 *   (calculateBoardCountVP/isCardDeclined, ./victoryPoints.ts) was visibly
 *   changing for opponents mid-phase as a result.
 *
 * Everything else (hands, discard, board, resolved decline piles,
 * resources, VP, etc.) is public per §2 and passes through unchanged.
 *
 * Pure and side-effect-free, like the rest of src/engine/ — the caller
 * (the `get-game-state` Edge Function, see §5.2) is responsible for
 * actually keeping this the only view an opponent's client ever receives.
 *
 * Also redacts `actionHistory` (added 2026-09-08, alongside `get-game-state`
 * becoming the redacted read path an app client actually calls —
 * RULE_ENFORCEMENT_PLAN.md §8 phase 8): the raw log's own CHOOSE_CARD/
 * MOVE_TO_DECLINE entries carry the exact same secret `cardId` payload
 * chosenCardIdByPlayerId/declineCardIds mask above, under the same two
 * conditions (still-pending selectCards, or this-phase-only decline
 * additions) — so scrubbing only the derived fields and shipping the raw
 * log alongside them would leak the very same value straight back out. A
 * single-card RETRACT_DECLINE is masked the same way (issue #505): once
 * `handleUndo` (GamePage.tsx) started actually dispatching this action, a
 * still-masked MOVE_TO_DECLINE could be immediately followed by an
 * unmasked RETRACT_DECLINE naming the very card the addition was hiding —
 * masking both closes it. (The no-`cardId` "retract everything this phase"
 * form this action gained for that same fix has no payload to leak in the
 * first place.) This still doesn't cover a raw-row Realtime broadcast
 * bypassing this function entirely (§5.2's original concern) — but
 * `subscribeToGameState` (`src/lib/gameApi.ts`) already subscribes to
 * `game_state_meta`, not `game_state` itself (issue #448, for bandwidth,
 * before this document even had a redaction concern), so nothing broadcasts
 * the raw row over Realtime today regardless.
 *
 * §5.3's "reveal high-water mark" (keeping an already-resolved phase from
 * flickering back to masked for a viewer who rewinds *review-only*, with no
 * branch, back into it) was scoped for this function but dropped per
 * jinxbit, 2026-09-06: this always derives strictly from `state`'s own
 * `roundPhase`/`pendingPlayerIds`, so a reviewed-but-not-branched rewind
 * re-masks an already-seen phase exactly as if it hadn't resolved yet. This
 * is a display flicker on review, not a leak (the viewer's own client
 * already rendered the real value before the rewind), and dropping it is
 * what let `get-game-state` ship as a straight read of the live state
 * instead of needing a full engine replay to compute the mark, and stays
 * dropped: issue #648's `stateWithoutHistory` patch (`buildRedactedGameStateDelta`
 * below) diffs two *materialised* `GameState`s (the current one, and a
 * buffered earlier one — see `game_state_snapshots`,
 * `supabase/functions/_shared/gameEnforcement.ts`), calling this exact
 * function against each — no replay, and no revival of the high-water mark
 * it would have needed.
 */
export function redactStateForPlayer(state: GameState, viewerId: string | null): RedactedGameState {
  const hideChosenCards = state.roundPhase === 'selectCards' && state.pendingPlayerIds.length > 0

  const chosenCardIdByPlayerId: Record<string, RedactedChoice> = {}
  for (const [playerId, cardId] of Object.entries(state.chosenCardIdByPlayerId)) {
    if (cardId === null) {
      chosenCardIdByPlayerId[playerId] = { chosen: false }
      continue
    }
    const visible = playerId === viewerId || !hideChosenCards
    chosenCardIdByPlayerId[playerId] = { chosen: true, cardId: visible ? cardId : null }
  }

  const declineAdditionsThisPhaseByPlayerId = declineAdditionsThisPhase(state)
  const purchasesThisPhaseByPlayerId = purchasesThisPhase(state)

  const players: RedactedPlayer[] = state.players.map((player) => {
    const secretCardIds = player.id === viewerId ? undefined : declineAdditionsThisPhaseByPlayerId.get(player.id)
    const secretPurchaseCardId = player.id === viewerId ? undefined : purchasesThisPhaseByPlayerId.get(player.id)
    const declineCardIds: (string | null)[] = secretCardIds
      ? player.declineCardIds.map((cardId) => (secretCardIds.has(cardId) ? null : cardId))
      : player.declineCardIds
    return {
      ...player,
      declineCardIds: secretPurchaseCardId ? [...declineCardIds, secretPurchaseCardId] : declineCardIds,
      handCardIds: secretPurchaseCardId ? player.handCardIds.filter((cardId) => cardId !== secretPurchaseCardId) : player.handCardIds,
    }
  })

  const actionHistory: RedactedLoggedAction[] = state.actionHistory.map((entry) => {
    const { action } = entry
    if (action.type === 'CHOOSE_CARD' && action.playerId !== viewerId && hideChosenCards && entry.turn === state.turn) {
      return { ...entry, action: { ...action, cardId: null } }
    }
    if (action.type === 'MOVE_TO_DECLINE' && action.playerId !== viewerId && declineAdditionsThisPhaseByPlayerId.get(action.playerId)?.has(action.cardId)) {
      return { ...entry, action: { ...action, cardId: null } }
    }
    if (
      action.type === 'RETRACT_DECLINE' &&
      action.cardId != null &&
      action.playerId !== viewerId &&
      declineAdditionsThisPhaseByPlayerId.get(action.playerId)?.has(action.cardId)
    ) {
      return { ...entry, action: { ...action, cardId: null } }
    }
    if (action.type === 'PURCHASE_CARD' && action.playerId !== viewerId && purchasesThisPhaseByPlayerId.get(action.playerId) === action.cardId) {
      return { ...entry, action: { ...action, cardId: null } }
    }
    return entry
  })

  return { ...state, chosenCardIdByPlayerId, players, actionHistory }
}

/**
 * The `RedactedGameState` shape with nothing actually masked — every
 * `chosenCardIdByPlayerId` entry reported as its real value regardless of
 * viewer. Used by get-game-state/index.ts for callers `redactStateForPlayer`
 * itself never masks anything from (the §4.5 site-admin carve-out, and
 * hotseat's one-shared-`auth.uid()` case — see that function's own doc
 * comment), so every caller of get-game-state gets the same response shape
 * back regardless of whether they're actually being redacted, and
 * gameApi.ts's toClientGameState below never needs to sniff which shape it
 * received.
 */
export function revealedGameStateView(state: GameState): RedactedGameState {
  const chosenCardIdByPlayerId: Record<string, RedactedChoice> = {}
  for (const [playerId, cardId] of Object.entries(state.chosenCardIdByPlayerId)) {
    chosenCardIdByPlayerId[playerId] = cardId === null ? { chosen: false } : { chosen: true, cardId }
  }
  return { ...state, chosenCardIdByPlayerId }
}

/**
 * The client-side inverse of redactStateForPlayer/revealedGameStateView —
 * collapses a get-game-state response back into a plain GameState so the
 * rest of the app (gameLog.ts, turnReview.ts, scoreHistory.ts, unitValue.ts,
 * historyFold.ts, every RoundView.tsx render path) can keep consuming
 * `GameState` exactly as it always has, with no separate redacted-state
 * type threaded through the client. The only caller is gameApi.ts's
 * getGameStateRedacted.
 *
 * Two fields are genuinely lossy, both deliberately:
 * - `chosenCardIdByPlayerId`: `{chosen: true, cardId: null}` (masked, but
 *   chosen) collapses to `null`, same as `{chosen: false}` (not chosen) —
 *   indistinguishable once collapsed. Every current reader of another
 *   player's entry in this field (RoundView.tsx) only actually looks at it
 *   once `roundPhase === 'actions'`, by which point that phase has
 *   necessarily resolved and nothing is masked anymore (see
 *   redactStateForPlayer) — so this collapse never actually loses
 *   information a reader depends on today. A future reader that wants to
 *   show "chosen, not yet revealed" during selectCards itself would need to
 *   consume `RedactedChoice` directly instead of calling this function.
 * - `players[].declineCardIds`: a this-phase decline addition is kept as
 *   `null` in place (array length/order otherwise preserved) rather than
 *   filtered out — every reader (kindsInZone/sortCardIdsForDisplay in
 *   RoundView.tsx/EndGameView.tsx) already does a `cards[id]` lookup that
 *   quietly drops an unrecognized id, so a `null` here just under-counts a
 *   still-secret pile by omission rather than crashing or fabricating a
 *   value. A this-phase purchase (buy-back) is the mirror image — the real
 *   id is *appended* rather than replacing a slot in place, since there's no
 *   original position to restore it to — so length/order is preserved for
 *   an addition but not for a removal; either way this only ever touches an
 *   *other* player's pile, never the viewer's own.
 *
 * `actionHistory` is truncated via unredactedPrefix rather than collapsed —
 * see that function's own doc comment for why dropping the still-secret
 * tail, rather than inventing placeholder cardIds for it, is the safe
 * choice there.
 */
export function toClientGameState(redacted: RedactedGameState): GameState {
  return { ...collapseStateWithoutHistory(redacted), actionHistory: unredactedPrefix(redacted.actionHistory) }
}

/**
 * `toClientGameState`'s collapse, minus the `actionHistory` handling — split
 * out (issue #648) because it's a pure function of `redacted`'s own
 * `chosenCardIdByPlayerId`/`players` fields alone, independent of
 * `actionHistory`'s separate merge-then-`unredactedPrefix` handling
 * (`buildRedactedGameStateDelta`/`applyRedactedGameStateDelta` below). That
 * independence is what lets a `stateWithoutHistory` patch be computed and
 * applied entirely separately from the actionHistory-append delta issue #647
 * already established, each diffing/merging only the part it owns.
 */
function collapseStateWithoutHistory(redacted: Omit<RedactedGameState, 'actionHistory'>): Omit<GameState, 'actionHistory'> {
  const chosenCardIdByPlayerId: Record<string, string | null> = {}
  for (const [playerId, choice] of Object.entries(redacted.chosenCardIdByPlayerId)) {
    chosenCardIdByPlayerId[playerId] = choice.chosen ? choice.cardId : null
  }
  const players = redacted.players.map((player) => ({ ...player, declineCardIds: player.declineCardIds as string[] }))
  return { ...redacted, chosenCardIdByPlayerId, players }
}

/**
 * get-game-state/apply-action/undo-action/redo-action's incremental response
 * payload — two independent deltas bundled together, one per field group of
 * `RedactedGameState`, each carried the way that group is cheapest to
 * transmit:
 *
 * - `actionHistory` (issue #647): just the entries logged after
 *   `actionHistoryFrom`, since the safe-to-show prefix only ever grows (see
 *   `unredactedPrefix`'s own doc comment) — `actionHistoryAppend`/
 *   `actionHistoryLength` below.
 * - Everything else (issue #648): a structural patch (`../engine/statePatch.ts`)
 *   from the caller's own previously-applied `Omit<GameState,'actionHistory'>`
 *   to the current one, computed over the *collapsed* (client-shape) view —
 *   the same shape `toClientGameState`/`collapseStateWithoutHistory` produce
 *   — rather than the wire `RedactedGameState` shape, since that's what a
 *   caller actually has cached to diff against. `statePatch` is `null` when
 *   nothing in that half changed at all (a move that only appended to the
 *   log, e.g. an UNDO_ACTION that didn't change anything else visible to this
 *   viewer). `state` (the plain, un-patched value) is sent instead whenever
 *   there's no previous view to diff against — a read-path buffer miss (an
 *   older base version than `get-game-state`'s snapshot buffer covers, see
 *   its own doc comment) or the write-path's very first response for a game.
 *   Exactly one of `state`/`statePatch` is ever present.
 *
 * See `buildRedactedGameStateDelta` for the server-side builder and
 * `applyRedactedGameStateDelta` for the client-side inverse.
 */
export type RedactedGameStateDelta = {
  actionHistoryFrom: number
  actionHistoryAppend: RedactedLoggedAction[]
  actionHistoryLength: number
} & ({ state: Omit<GameState, 'actionHistory'>; statePatch?: undefined } | { state?: undefined; statePatch: StatePatch })

/**
 * Server-side builder for `RedactedGameStateDelta`, shared by
 * `get-game-state` (against a buffered previous `GameState`, or `null` on a
 * buffer miss) and `apply-action`/`undo-action`/`redo-action` (always
 * against the pre-write state they already hold in memory — see
 * `../../supabase/functions/_shared/gameEnforcement.ts`'s
 * `buildEnforcedActionResponseDelta`). `previousView`/`currentView` are both
 * already-redacted-for-this-viewer (`redactStateForPlayer`/
 * `revealedGameStateView`) — this only ever diffs two views for the *same*
 * viewer, never across viewers.
 */
export function buildRedactedGameStateDelta(previousView: RedactedGameState | null, currentView: RedactedGameState, sinceActionIndex: number): RedactedGameStateDelta {
  const safePrefixLength = unredactedPrefix(currentView.actionHistory).length
  const actionHistoryAppend = currentView.actionHistory.slice(sinceActionIndex, safePrefixLength)
  const currentWithoutHistory = collapseStateWithoutHistory(currentView)
  const shared = { actionHistoryFrom: sinceActionIndex, actionHistoryAppend, actionHistoryLength: safePrefixLength }
  if (!previousView) return { ...shared, state: currentWithoutHistory }
  const statePatch = diffState(collapseStateWithoutHistory(previousView), currentWithoutHistory)
  return { ...shared, statePatch }
}

/**
 * The client-side counterpart to `buildRedactedGameStateDelta`: reconstructs
 * the caller's next full `GameState` from `previous` (the `GameState` this
 * caller already applied — itself the result of a previous call to this same
 * function, `toClientGameState`, or a fresh genesis) plus `delta`.
 *
 * Splices `delta.actionHistoryAppend` onto `previous.actionHistory` the same
 * way issue #647's version did, then runs `unredactedPrefix` over the merged
 * array — this is a lossless reconstruction of what a full fetch would have
 * returned, not an approximation, for the same reason issue #647's version
 * was: `unredactedPrefix`'s cut point only ever moves later as new entries
 * arrive, never earlier or in place, so `previous.actionHistory` is
 * guaranteed unchanged in the merge.
 *
 * Separately, reconstructs the rest of the state: `delta.state` verbatim, or
 * `applyStatePatch(previous-without-history, delta.statePatch)` — these two
 * halves (history, everything else) are independent (see
 * `RedactedGameStateDelta`'s own doc comment), so there's no ordering
 * dependency between them.
 *
 * Returns `null` — rather than guessing — when `delta` doesn't verify against
 * `previous`: `actionHistoryFrom` not matching `previous.actionHistory.length`
 * (a response for a different request than the one that produced `previous`),
 * or the merged array's length disagreeing with `actionHistoryLength` (any
 * other inconsistency). Cheap insurance against a stale cache, a race, or a
 * caller bug — every caller (gameApi.ts's getGameStateRedacted/
 * invokeGameFunction) falls back to an ordinary full fetch when this happens
 * rather than trust a possibly-wrong splice/patch.
 */
export function applyRedactedGameStateDelta(previous: GameState, delta: RedactedGameStateDelta): GameState | null {
  if (delta.actionHistoryFrom !== previous.actionHistory.length) return null
  const mergedHistory: RedactedLoggedAction[] = [...previous.actionHistory, ...delta.actionHistoryAppend]
  if (mergedHistory.length !== delta.actionHistoryLength) return null
  const actionHistory = unredactedPrefix(mergedHistory)

  if (delta.state !== undefined) return { ...delta.state, actionHistory }
  const { actionHistory: _previousActionHistory, ...previousWithoutHistory } = previous
  return { ...applyStatePatch(previousWithoutHistory, delta.statePatch), actionHistory }
}

/**
 * Read-side view of a narration log (see GameEvent/gameLog.ts) for a
 * specific viewer (`viewerId`, null for a non-player observer) — masks the
 * same still-secret-pick window `redactStateForPlayer` masks in
 * `chosenCardIdByPlayerId` (issue #399): while `roundPhase === 'selectCards'`
 * and any player is still pending, another player's CHOOSE_CARD line says
 * only that a card was chosen, not which one.
 *
 * Deliberately re-evaluated against `state` — the *current* state, not
 * whatever it was right after the event's own action applied — on every
 * call rather than baked into the event once at narration time: an entry
 * that was secret when logged (some players still picking) needs to read as
 * revealed once the round's selectCards phase actually resolves, and that
 * can only be known once later actions (other players' own picks) have
 * happened. `event.secret.turn` guards against a *new* round's still-secret
 * picks being mistaken for this event's already-settled one once `turn`
 * has moved on.
 *
 * `events` themselves are never mutated — everything else (the fully-
 * revealing log ./gameLog.ts builds) stays the shared, cacheable source of
 * truth; this returns a per-viewer copy for display only.
 *
 * Also synthesizes a "chose a card" line for a still-pending player whose
 * real CHOOSE_CARD entry never reached `events` at all (issue #497): for a
 * `hiddenInformationEnabled` game, `get-game-state` never sends that entry
 * to another player's client in the first place (`unredactedPrefix` above
 * cuts the raw actionHistory *before* it, not just its `cardId`), so there is
 * nothing in `events` for the map above to redact — the map only handles the
 * client-trusted path, where the real (fully-revealing) event always exists
 * and just needs its message swapped. `pendingPlayerIds`/`turnOrder` are
 * never themselves secret (redactStateForPlayer never touches them), so
 * "who's no longer pending" is a reliable, redaction-independent source for
 * this even though the log entry itself may be missing. A no-op on the
 * client-trusted path, where `announced` already covers every such player.
 * The synthesized line's own `adminMode` tag (issue #536) can only read
 * `state.adminModeActive` — the *current* value — rather than the real
 * entry's `LoggedAction.viaAdminMode`, since that entry was never sent to
 * this client to read it from.
 */
export function redactGameLog(events: GameEvent[], state: GameState, viewerId: string | null): GameEvent[] {
  const hideChosenCards = state.roundPhase === 'selectCards' && state.pendingPlayerIds.length > 0
  const redacted = events.map((event) => {
    if (!event.secret || event.playerId === viewerId) return event
    if (!hideChosenCards || event.secret.turn !== state.turn) return event
    return { ...event, message: event.secret.redactedMessage }
  })
  if (!hideChosenCards) return redacted

  const announced = new Set(redacted.filter((event) => event.secret && event.secret.turn === state.turn).map((event) => event.playerId))
  const stillPending = new Set(state.pendingPlayerIds)
  const unannouncedPickers = state.turnOrder.filter((playerId) => playerId !== viewerId && !stillPending.has(playerId) && !announced.has(playerId))
  if (unannouncedPickers.length === 0) return redacted

  return [
    ...redacted,
    ...unannouncedPickers.map((playerId) => ({
      id: `hidden-pick-${state.turn}-${playerId}`,
      turn: state.turn,
      playerId,
      // Same literal PLAYER_PLACEHOLDER (./gameLog.ts) resolves to in every
      // other redactedMessage — not imported directly, since gameLog.ts (and
      // its own extension-less imports) isn't part of the Edge Function
      // graph redaction.ts otherwise stays safely inside (CLAUDE.md's "Edge
      // Function gotchas").
      message: '{player} chose a card',
      timestamp: new Date().toISOString(),
      // The real entry this stands in for was never sent to this client at
      // all (unredactedPrefix cut it, see this function's doc comment), so
      // there's no LoggedAction.viaAdminMode to read for it — `state`'s own
      // *current* adminModeActive is the best available signal for whether
      // it was made under admin mode. Same caveat as everywhere else this
      // synthesized line stands in for the real one: it's a display-only
      // approximation, not a replay of history.
      adminMode: state.adminModeActive || undefined,
    })),
  ]
}

/**
 * The longest prefix of a (possibly redacted) actionHistory that's safe to
 * feed straight into applyAction()/replayActions() — i.e. everything before
 * the first still-masked CHOOSE_CARD/MOVE_TO_DECLINE/RETRACT_DECLINE/
 * PURCHASE_CARD entry that's actually still *in effect* (see RedactedGameState's own doc
 * comment: a masked entry's `cardId: null` isn't a legal action payload, and
 * replayActions throws outright on one it tries to replay). In practice a
 * masked RETRACT_DECLINE always has an earlier, also-masked MOVE_TO_DECLINE
 * for the same card (it can't retract a card that was never added), so that
 * earlier entry is what actually triggers the cut — this is here for the
 * type's own sake and as a defense in depth, not because it fires first.
 *
 * Deliberately keyed on `resolveHistory(...).effective`, not "the first
 * masked entry in raw order" (issue #498): a masked entry that's since been
 * undone (behind the fold's pointer — see historyFold.ts) is never replayed
 * by replayActions() either, which only ever walks `.effective` — so it's
 * safe to keep it, `cardId: null` and all, in the returned array rather than
 * truncating there. That matters because UNDO_ACTION/REDO_ACTION entries
 * carry no secret and are never masked themselves (see redactStateForPlayer),
 * so truncating at an already-undone masked entry used to throw away every
 * real entry that came after it too — including the very UNDO_ACTION that
 * undid it — which corrupted every other viewer's client-side
 * resolveHistory().canRedo (the Redo button) and made both the undoer and
 * the undone player's own client disagree with the server about whether
 * anything was redoable. A masked entry that's still effective (the
 * ordinary "still-pending selectCards" case) is unaffected by this change —
 * see this function's git history for the previous, simpler version and its
 * own reasoning about why truncating there is safe (nothing downstream of a
 * masked entry changes VP/resources/board, and `pendingPlayerIds`/
 * `roundPhase`, never masked, already tell a viewer "N players still
 * deciding" independent of this).
 *
 * The original caller is gameApi.ts's toClientGameState — the client-side
 * collapse of a RedactedGameState response back into a plain GameState the
 * rest of the app (gameLog.ts, turnReview.ts, scoreHistory.ts, unitValue.ts,
 * historyFold.ts — none of which know anything about redaction) can keep
 * consuming completely unmodified. get-game-state/index.ts also calls this
 * directly now (issue #647), server-side, to find where the current safe
 * prefix ends when answering a `sinceActionIndex` request — the exact same
 * cut point toClientGameState would land on, just computed once on the
 * server instead of implicitly assumed by the client's splice.
 *
 * One more exception on top of the UNDO/REDO one above (issue #527): a
 * masked CHOOSE_CARD closed by that same player's own later RETRACT_CHOICE
 * doesn't gate the cut either, even though RETRACT_CHOICE isn't UNDO/REDO
 * and so doesn't touch `.effective` at all. Unlike the entries this function
 * otherwise treats as unsafe, a *retracted* pick is never going to become
 * legal to replay later — gameLog.ts's extendGameLog already knows to treat
 * both halves of a masked-choose/retract pair as narration-only no-ops (see
 * isMaskedRedactionEntry/isRetractionOfMaskedChoice there) precisely so this
 * function can keep going past them instead of truncating the entire rest
 * of the game's log the moment any player so much as reconsiders a pick.
 * MOVE_TO_DECLINE/RETRACT_DECLINE/PURCHASE_CARD don't get the same
 * treatment: a masked RETRACT_DECLINE is itself always masked too (see this
 * comment's opening paragraph), and there's no way to retract a PURCHASE_CARD
 * at all, so neither can ever be closed the way an always-visible
 * RETRACT_CHOICE closes a masked CHOOSE_CARD.
 */
export function unredactedPrefix(actionHistory: RedactedLoggedAction[]): LoggedAction[] {
  // resolveHistory/walkHistory (historyFold.ts) only ever inspect
  // `entry.action.type`, never the payload — so it's safe to run on a
  // still-masked array before we know yet whether any of it needs
  // truncating. Cast, not a copy: `effective`'s entries are the exact same
  // object references as `actionHistory`'s, which the Set below relies on.
  const effective = resolveHistory(actionHistory as unknown as LoggedAction[]).effective
  const effectiveEntries = new Set<RedactedLoggedAction>(effective as unknown as RedactedLoggedAction[])

  // Tracks, per player, the index of their most recent still-open masked
  // CHOOSE_CARD (cleared by a later RETRACT_CHOICE from the same player) —
  // see this function's doc comment. Whatever's left open once the scan
  // ends is unsafe exactly like a masked MOVE_TO_DECLINE/RETRACT_DECLINE/
  // PURCHASE_CARD.
  const openMaskedChoiceIndexByPlayerId = new Map<string, number>()
  let firstUnsafeIndex = -1
  const markUnsafe = (index: number) => {
    if (firstUnsafeIndex === -1 || index < firstUnsafeIndex) firstUnsafeIndex = index
  }
  actionHistory.forEach((entry, index) => {
    if (!effectiveEntries.has(entry)) return
    const { action } = entry
    if (action.type === 'CHOOSE_CARD' && action.cardId === null) {
      openMaskedChoiceIndexByPlayerId.set(action.playerId, index)
    } else if (action.type === 'RETRACT_CHOICE') {
      openMaskedChoiceIndexByPlayerId.delete(action.playerId)
    } else if (
      (action.type === 'MOVE_TO_DECLINE' || action.type === 'RETRACT_DECLINE' || action.type === 'PURCHASE_CARD') &&
      action.cardId === null
    ) {
      markUnsafe(index)
    }
  })
  for (const index of openMaskedChoiceIndexByPlayerId.values()) markUnsafe(index)

  const prefix = firstUnsafeIndex === -1 ? actionHistory : actionHistory.slice(0, firstUnsafeIndex)
  // Safe: nothing in `prefix` has a null cardId that's still in effect and unclosed, by construction above.
  return prefix as LoggedAction[]
}

/**
 * Cards moved to decline by each player during the current, still-in-
 * progress decline phase — the "phase-start snapshot" §5.1 calls for to
 * distinguish this from an already-public earlier-round decline pile,
 * derived here from `actionHistory` rather than stored as separate state.
 * `MOVE_TO_DECLINE` is only ever logged while `roundPhase === 'decline'`
 * (applyMoveToDecline, ./applyAction.ts) and a round has at most one
 * decline phase, so filtering `actionHistory` down to this round's
 * (`turn === state.turn`) `MOVE_TO_DECLINE` entries exactly recovers this
 * phase's still-secret additions — robust to ordering, and to CONCEDE/
 * eliminations interleaved mid-phase, since neither ever touches
 * `declineCardIds` itself. Also used to mask a RETRACT_DECLINE entry naming
 * one of these same cards (see redactStateForPlayer) — deliberately never
 * recomputed to drop a card once it's retracted, since a retraction naming
 * it is exactly the payload that would otherwise leak it.
 */
function declineAdditionsThisPhase(state: GameState): Map<string, Set<string>> {
  const byPlayerId = new Map<string, Set<string>>()
  if (state.roundPhase !== 'decline') return byPlayerId

  for (const { action, turn } of state.actionHistory) {
    if (turn !== state.turn || action.type !== 'MOVE_TO_DECLINE') continue
    const cardIds = byPlayerId.get(action.playerId) ?? new Set<string>()
    cardIds.add(action.cardId)
    byPlayerId.set(action.playerId, cardIds)
  }
  return byPlayerId
}

/**
 * Decline's own counterpart above, for the purchase (buy-back) phase
 * (issue #600): each player buys back at most one card per phase
 * (`applyPurchaseCard`, ./applyAction.ts drops them from `pendingPlayerIds`
 * entirely on their first purchase, unlike decline's repeat-per-achievement
 * owing), so this is a plain `Map<playerId, cardId>` rather than
 * declineAdditionsThisPhase's `Map<playerId, Set<cardId>>`. Same
 * `turn === state.turn` scoping and the same reasoning for why that alone
 * is enough (a round has at most one purchase phase, and it resolves in the
 * same dispatch that empties `pendingPlayerIds` — see beginPurchasePhase/
 * applyPurchaseCard/applyPassPurchase, ./round.ts and ./applyAction.ts —
 * so `roundPhase === 'purchase'` never lingers after that already happened).
 */
function purchasesThisPhase(state: GameState): Map<string, string> {
  const byPlayerId = new Map<string, string>()
  if (state.roundPhase !== 'purchase') return byPlayerId

  for (const { action, turn } of state.actionHistory) {
    if (turn !== state.turn || action.type !== 'PURCHASE_CARD') continue
    byPlayerId.set(action.playerId, action.cardId)
  }
  return byPlayerId
}
