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

import type { GameState } from '../engine/types'

export function shouldRetractOwnChoice(state: Pick<GameState, 'roundPhase' | 'chosenCardIdByPlayerId'>, myPlayerId: string | null | undefined): boolean {
  return !!myPlayerId && state.roundPhase === 'selectCards' && state.chosenCardIdByPlayerId[myPlayerId] != null
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
