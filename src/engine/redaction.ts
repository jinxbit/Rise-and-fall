import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import type { AchievementContent } from './achievementContent'
import type { LoggedAction } from './actions'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import { computeRevealedPhaseMarks, revealMarkKey, stateAtPointer } from './historyPointer'
import { EMPTY_TALE_CONTENT } from './taleContent'
import type { TaleContent } from './taleContent'
import type { GameEvent, GameState, Player } from './types'
import { EMPTY_UNIT_CONTENT } from './unitContent'
import type { UnitContent } from './unitContent'

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

export type RedactedGameState = Omit<GameState, 'chosenCardIdByPlayerId' | 'players'> & {
  chosenCardIdByPlayerId: Record<string, RedactedChoice>
  players: RedactedPlayer[]
}

/**
 * Read-side view of GameState for a specific viewer (`viewerId`, one of
 * GameState.players[].id, or a non-player observer). Masks the two windows
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
 * (eventually the `get_game_state` RPC, see §5.2) is responsible for
 * actually keeping this the only view an opponent's client ever receives.
 * Note this does NOT redact `actionHistory` — see §5.2 for why that's a
 * separate, later concern (a raw-row Realtime broadcast bypasses this
 * function entirely, so scrubbing this return value alone can't be the
 * whole fix; the RPC that eventually wraps this needs its own handling).
 *
 * `revealed` (default false) is §5.3's reveal high-water mark, already
 * resolved by the caller for `state`'s own (turn, roundPhase) — pass true
 * to force this phase's masking off even though `state.pendingPlayerIds`
 * looks mid-phase, for a viewer who already legitimately saw it resolve on
 * the live tip before a review-only pointer rewind replayed back into it.
 * Most callers reading the live tip state (where "resolved" and
 * "`pendingPlayerIds` empty" always agree) can safely omit it; only a
 * pointer-aware caller like redactStateForPlayerAtPointer below needs to
 * pass it explicitly.
 */
export function redactStateForPlayer(state: GameState, viewerId: string, opts: { revealed?: boolean } = {}): RedactedGameState {
  const revealed = opts.revealed ?? false
  const hideChosenCards = !revealed && state.roundPhase === 'selectCards' && state.pendingPlayerIds.length > 0

  const chosenCardIdByPlayerId: Record<string, RedactedChoice> = {}
  for (const [playerId, cardId] of Object.entries(state.chosenCardIdByPlayerId)) {
    if (cardId === null) {
      chosenCardIdByPlayerId[playerId] = { chosen: false }
      continue
    }
    const visible = playerId === viewerId || !hideChosenCards
    chosenCardIdByPlayerId[playerId] = { chosen: true, cardId: visible ? cardId : null }
  }

  const declineAdditionsThisPhaseByPlayerId = revealed ? new Map<string, Set<string>>() : declineAdditionsThisPhase(state)

  const players: RedactedPlayer[] = state.players.map((player) => {
    const secretCardIds = player.id === viewerId ? undefined : declineAdditionsThisPhaseByPlayerId.get(player.id)
    return {
      ...player,
      declineCardIds: secretCardIds
        ? player.declineCardIds.map((cardId) => (secretCardIds.has(cardId) ? null : cardId))
        : player.declineCardIds,
    }
  })

  return { ...state, chosenCardIdByPlayerId, players }
}

/**
 * §5.3's pointer-aware entry point: redacts the state as of `pointer`, but
 * — unlike calling stateAtPointer + redactStateForPlayer directly — never
 * re-masks a `selectCards`/`decline` phase that already resolved somewhere
 * on the live tip (`tipHistory`), even when `pointer` rewinds back into it
 * with no branch involved. `tipHistory` must be the *actual, unpruned* tip
 * history (not `history.slice(0, pointer)`): computeRevealedPhaseMarks
 * needs the full log to know what's genuinely resolved, and a branch that
 * prunes a resolving entry naturally stops producing that mark the next
 * time this is called with the new tip — see computeRevealedPhaseMarks'
 * own doc comment for why that needs no separate delete step.
 */
export function redactStateForPlayerAtPointer(
  genesis: GameState,
  tipHistory: LoggedAction[],
  pointer: number,
  viewerId: string,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): RedactedGameState {
  const state = stateAtPointer(genesis, tipHistory, pointer, unitContent, achievementContent, boardGenerationContent, taleContent)
  const revealedMarks = computeRevealedPhaseMarks(genesis, tipHistory, unitContent, achievementContent, boardGenerationContent, taleContent)
  const revealed =
    (state.roundPhase === 'selectCards' || state.roundPhase === 'decline') && revealedMarks.has(revealMarkKey(state.turn, state.roundPhase))
  return redactStateForPlayer(state, viewerId, { revealed })
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
