import type { Action, ChooseCardAction, LoggedAction, MoveToDeclineAction } from './actions.ts'
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
   * Same array, same length/order as Player.declineCardIds — entries added
   * during the current, still-unresolved decline phase by someone other
   * than the viewer are replaced with `null` (see redactStateForPlayer).
   */
  declineCardIds: (string | null)[]
}

/**
 * One GameState.actionHistory entry as seen by a particular viewer — the raw
 * log carries the same two secrets chosenCardIdByPlayerId/declineCardIds do
 * (a CHOOSE_CARD/MOVE_TO_DECLINE action's own `cardId` payload), so a reader
 * who only had those two fields nulled could still recover a still-secret
 * pick straight out of the log (see redactStateForPlayer's doc comment).
 * Every other action type passes through with its real payload unchanged —
 * this is not a general Action-redaction mechanism, just these two fields.
 */
export type RedactedLoggedAction = Omit<LoggedAction, 'action'> & {
  action:
    | Exclude<Action, ChooseCardAction | MoveToDeclineAction>
    | (Omit<ChooseCardAction, 'cardId'> & { cardId: string | null })
    | (Omit<MoveToDeclineAction, 'cardId'> & { cardId: string | null })
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
 * log alongside them would leak the very same value straight back out. This
 * still doesn't cover a raw-row Realtime broadcast bypassing this function
 * entirely (§5.2's original concern) — but `subscribeToGameState`
 * (`src/lib/gameApi.ts`) already subscribes to `game_state_meta`, not
 * `game_state` itself (issue #448, for bandwidth, before this document even
 * had a redaction concern), so nothing broadcasts the raw row over
 * Realtime today regardless.
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
 * instead of needing a full engine replay to compute the mark.
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

  const players: RedactedPlayer[] = state.players.map((player) => {
    const secretCardIds = player.id === viewerId ? undefined : declineAdditionsThisPhaseByPlayerId.get(player.id)
    return {
      ...player,
      declineCardIds: secretCardIds
        ? player.declineCardIds.map((cardId) => (secretCardIds.has(cardId) ? null : cardId))
        : player.declineCardIds,
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
    return entry
  })

  return { ...state, chosenCardIdByPlayerId, players, actionHistory }
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
 */
export function redactGameLog(events: GameEvent[], state: GameState, viewerId: string | null): GameEvent[] {
  const hideChosenCards = state.roundPhase === 'selectCards' && state.pendingPlayerIds.length > 0
  return events.map((event) => {
    if (!event.secret || event.playerId === viewerId) return event
    if (!hideChosenCards || event.secret.turn !== state.turn) return event
    return { ...event, message: event.secret.redactedMessage }
  })
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
 * `declineCardIds` itself.
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
