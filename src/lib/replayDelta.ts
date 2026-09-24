/**
 * Applying a protocol-2 delta (issue #648): the pure half of the delta read
 * and write paths — no Supabase client, no network, nothing that reads the
 * environment.
 *
 * It lives here rather than in `gameApi.ts` for the reason `DeltaReplayContext`
 * does (todo.md #147): that module imports `./supabase`, which throws at
 * import time when the app's env vars are absent, so nothing in the repo can
 * test — or reuse — anything that lives inside it. This is the routine the
 * whole protocol rests on, and it was reimplemented twice over in tests
 * (`writePathRedaction.test.ts`'s "the way gameApi.ts's applyReplayDelta
 * does") precisely because it could not be imported. `gameApi.ts` re-exports
 * everything here, so callers are unaffected by the move.
 */
import { extendReplay, replayToBase } from '../engine/replay'
import { applyInFlightOverlay, type InFlightOverlay } from '../engine/inFlightOverlay'
import { hashGameStateView } from './gameStateHash'
import type { DeltaReplayContext } from './deltaReplayContext'
import type { RedactedLoggedAction } from '../engine/redaction'
import type { GameState as EngineGameState } from '../engine/types'
import type { LoggedAction } from '../engine/actions'

/**
 * Why a rebuild gave up, reported back to the server on the retry so the
 * telemetry can separate a healthy cold start from a client whose engine
 * disagrees with the server's — see StateFallbackReason
 * (supabase/functions/_shared/gameEnforcement.ts) for why that distinction is
 * the one worth watching.
 */
export type ReplayDeltaFailure = 'cursor-mismatch' | 'replay-failed' | 'length-mismatch' | 'hash-mismatch'

/** A protocol-2 delta on the wire, from `get-game-state` or any of the three write endpoints. */
export interface ReplayDeltaResponse {
  version: number
  actionHistoryFrom: number
  actionHistoryAppend: RedactedLoggedAction[]
  actionHistoryLength: number
  overlay?: InFlightOverlay
  stateHash: string
}

/**
 * Turns a protocol-2 delta into a state to render and a base to cache, or
 * `null` when this client could not reproduce what the server said it would.
 *
 * Every `null` here means the same thing to callers — ask for a full response —
 * and there are four ways to get one, all of them expected rather than
 * exceptional:
 *
 *   - the append does not start where this client's log ends (a stale base);
 *   - the replay threw, which is what a client running an older engine does
 *     when handed an action type it does not know;
 *   - the spliced log came out the wrong length;
 *   - the hash disagrees.
 *
 * That last one is what the whole design rests on. A PWA holding a stale
 * bundle after a rules change is normal operation here, and without the check
 * such a client would render a board that quietly disagreed with everyone
 * else's. With it, engine skew costs one full fetch and nothing else.
 *
 * Shared by the read path and the write path deliberately: they receive the
 * same shape for the same reason, and a verification routine that exists twice
 * is one that will eventually only be fixed once.
 */
export function applyReplayDelta(
  previous: EngineGameState,
  replay: DeltaReplayContext,
  delta: ReplayDeltaResponse,
): { ok: true; state: EngineGameState; base: EngineGameState } | { ok: false; reason: ReplayDeltaFailure } {
  if (delta.actionHistoryFrom !== previous.actionHistory.length) return { ok: false, reason: 'cursor-mismatch' }
  let base: EngineGameState
  try {
    base = extendReplay(
      replay.genesis,
      previous,
      delta.actionHistoryAppend as unknown as LoggedAction[],
      replay.unitContent,
      replay.achievementContent,
      replay.boardGenerationContent,
      replay.taleContent,
    )
  } catch {
    return { ok: false, reason: 'replay-failed' }
  }
  if (base.actionHistory.length !== delta.actionHistoryLength) return { ok: false, reason: 'length-mismatch' }
  const state = applyInFlightOverlay(base, delta.overlay)
  if (hashGameStateView(state) !== delta.stateHash) return { ok: false, reason: 'hash-mismatch' }
  return { ok: true, state, base }
}


/**
 * `replayToBase` (../engine/replay) with a `DeltaReplayContext` unpacked and a
 * failure turned into `undefined`: a client running an older engine than the
 * server can fail to replay an action it does not understand, and the caller's
 * answer to that is simply not to cache, not to crash.
 *
 * Measured at 10-130ms for a completed game, which is why it belongs to a cold
 * open and every other path extends incrementally instead.
 */
export function deriveBaseFromView(view: EngineGameState, replay: DeltaReplayContext): EngineGameState | undefined {
  try {
    return replayToBase(replay.genesis, view, replay.unitContent, replay.achievementContent, replay.boardGenerationContent, replay.taleContent)
  } catch {
    return undefined
  }
}

