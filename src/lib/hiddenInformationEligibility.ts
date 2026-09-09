// HIDDEN_INFORMATION_PLAN.md's redacted read path needs server authority to
// redact from, so it only makes sense alongside rule enforcement — and
// never for hotseat, where every local seat shares one auth.uid() and
// per-seat masking would just hide a player's own pick from the device
// they're using to make it (see get-game-state/index.ts). Split out of
// CreateGamePage.tsx (issue #481) so the hotseat/rule-enforcement-off cases
// can be unit tested without rendering the page, same reason as
// roomReadiness.ts.

import type { PlayMode } from '../engine/types'

export function hiddenInformationAvailable(playMode: PlayMode, ruleEnforcementEnabled: boolean): boolean {
  return ruleEnforcementEnabled && playMode !== 'hotseat'
}
