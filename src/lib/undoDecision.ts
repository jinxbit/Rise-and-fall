// Issue #503 / RULE_ENFORCEMENT_PLAN.md §4.4's refinement: GamePage.tsx's
// generic Undo button rewinds actionHistory's shared pointer, which reverts
// whichever entry happens to sit at the tip — another player's still-pending
// selectCards pick, if they chose more recently than the clicking player
// did. `RETRACT_CHOICE` (../engine/actions.ts) is the compensating action
// that retracts only the caller's own pick instead. This decision — "does
// Undo mean RETRACT_CHOICE right now?" — is split out of handleUndo so it
// can be unit tested without rendering GamePage, same reason as
// hiddenInformationEligibility.ts.
//
// Issue #505 extends the same fix to the decline phase's own interleaving
// pair, MOVE_TO_DECLINE/RETRACT_DECLINE — todo.md's issue #503 entry had
// left this "not attempted" since, unlike a single selectCards pick, a
// player can owe (and so have already moved) more than one decline card at
// once, and "which of my own cards does a bare Undo click retract" wasn't
// yet answered. It's answered as: all of them, in one shot — see
// RetractDeclineAction's own doc comment for why a single compensating
// action, not one per card, is what keeps this consistent with the rest of
// the codebase's one-submitted-action-per-actionHistory-entry rule.
//
// Issue #547 extends shouldRetractOwnChoice past the phase resolving: if
// some *other* player's pick was the one that emptied pendingPlayerIds and
// moved roundPhase to 'actions', a bare Undo would revert that other
// player's entry (the tip of actionHistory), not the caller's own — exactly
// the "affects the card selection of player b" bug the issue reports.
// canRetractChoiceAfterReveal (../engine/applyAction.ts) is the engine's own
// authoritative legality check for RETRACT_CHOICE in that state; reused here
// rather than re-derived so this and applyRetractChoice can't drift apart.
//
// Issue #718: a single-card hand has no real pick standing to retract into
// — RULE_ENFORCEMENT_PLAN.md §4.4's refinement only means RETRACT_CHOICE for
// a pick the caller could actually change; a forced one (nextSelectCards-
// FastForward, ../engine/applyAction.ts) doesn't qualify, since the very
// same forced-follow-up convergence that made the pick in the first place
// immediately re-forces the identical card right back the instant
// RETRACT_CHOICE reopens it, folded into that same dispatch. Routing Undo
// there anyway still succeeds and still appends a real actionHistory entry
// — so it looks like Undo did something — but it's a pure no-op on game
// state, and worse, it buries whatever substantive action the player
// actually meant to undo one entry further out of reach with every click,
// since a bare Undo only ever reverts the tip one entry at a time. A player
// stuck this way could never reach a real UNDO_ACTION through the ordinary
// button at all: their pick keeps re-materializing, so
// `chosenCardIdByPlayerId[myPlayerId]` never goes back to null on its own.
// Gating on `handCardIds.length > 1` is exactly nextSelectCardsFastForward's
// own "is this forced" check, so the two can't drift apart either — a
// player who just made a genuine choice still has their chosen card sitting
// in `handCardIds` alongside at least one alternative until the turn
// actually finishes (applyChooseCard never touches handCardIds itself), so
// this doesn't affect the ordinary "let me change my mind" case at all.

import { canRetractChoiceAfterReveal } from '../engine/applyAction'
import type { GameState } from '../engine/types'

export function shouldRetractOwnChoice(
  state: Pick<
    GameState,
    'roundPhase' | 'chosenCardIdByPlayerId' | 'lockRevealedInformationEnabled' | 'pendingPlayerIds' | 'turnOrder' | 'resolvedUnitIdsThisTurn' | 'unitsCreatedThisTurn'
  > & {
    players: Pick<GameState['players'][number], 'id' | 'handCardIds'>[]
  },
  myPlayerId: string | null | undefined,
): boolean {
  if (!myPlayerId) return false
  const me = state.players.find((p) => p.id === myPlayerId)
  if (!me || me.handCardIds.length <= 1) return false
  if (state.roundPhase === 'selectCards') return state.chosenCardIdByPlayerId[myPlayerId] != null
  return canRetractChoiceAfterReveal(state, myPlayerId)
}

export function shouldRetractOwnDecline(
  state: Pick<GameState, 'roundPhase' | 'declineSourceZoneByCardId'> & {
    players: Pick<GameState['players'][number], 'id' | 'declineCardIds'>[]
  },
  myPlayerId: string | null | undefined,
): boolean {
  if (!myPlayerId || state.roundPhase !== 'decline') return false
  const me = state.players.find((p) => p.id === myPlayerId)
  if (!me) return false
  const sourceZoneByCardId = state.declineSourceZoneByCardId ?? {}
  return me.declineCardIds.some((cardId) => sourceZoneByCardId[cardId] != null)
}
