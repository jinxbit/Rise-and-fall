// Issue #503 / RULE_ENFORCEMENT_PLAN.md §4.4's refinement: GamePage.tsx's
// generic Undo button rewinds actionHistory's shared pointer, which reverts
// whichever entry happens to sit at the tip — another player's still-pending
// selectCards pick, if they chose more recently than the clicking player
// did. `RETRACT_CHOICE` (../engine/actions.ts) is the compensating action
// that retracts only the caller's own pick instead. This decision — "does
// Undo mean RETRACT_CHOICE right now?" — is split out of handleUndo so it
// can be unit tested without rendering GamePage, same reason as
// hiddenInformationEligibility.ts.

import type { GameState } from '../engine/types'

export function shouldRetractOwnChoice(state: Pick<GameState, 'roundPhase' | 'chosenCardIdByPlayerId'>, myPlayerId: string | null | undefined): boolean {
  return !!myPlayerId && state.roundPhase === 'selectCards' && state.chosenCardIdByPlayerId[myPlayerId] != null
}
