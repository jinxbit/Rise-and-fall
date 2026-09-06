import { gunzipFromBase64, gzipToBase64 } from './gzip.ts'
import type { GameState } from '../engine/types.ts'

/**
 * Compressed encoding for `game_state.state`, applied only on the write path
 * that's exclusive to `ruleEnforcementEnabled` games — see
 * `supabase/functions/_shared/gameEnforcement.ts`'s `writeGameStateCAS`. A
 * client-trusted game's direct writes (`insertGameState`/`writeGameState` in
 * `gameApi.ts`) are untouched and keep storing a plain `GameState` object:
 * only the Edge Functions (`apply-action`/`undo-action`/`redo-action`), which
 * never run for a client-trusted game, produce this shape. The column stays
 * `jsonb` either way — `{"__gz": "<base64 gzip>", ...}` is just another JSON
 * value — so every read path (shared by both kinds of game) can tell the two
 * apart per-row via `__gz`'s presence, with no migration or coordinated
 * rollout: a legacy/client-trusted row with no `__gz` key round-trips through
 * `decompressGameStateFromStorage` unchanged.
 *
 * Duplicates `status`/`roundPhase`/`turn`/`pendingPlayerIds`/`turnOrder`/
 * `boardSetup` in plaintext alongside the gzip blob (issue #451): the
 * `game_state_sync_meta` DB trigger (0027_game_state_meta_pending_players.sql)
 * reads exactly these fields straight off `new.state` with `->>`/`->` — it
 * has no way to gunzip `__gz` first, so without this a rule-enforced game's
 * `game_state_meta` projection (which every listing screen's "finished"/
 * "your turn" classification reads — see gameCardView.ts) silently rotted to
 * `status: 'unknown'` the moment the game's first enforced write landed,
 * including the write that actually finishes the game. No new information
 * exposure: these fields already sit inside the same `state` column, visible
 * to the same RLS-gated audience, just gzipped — duplicating a few of them
 * in plaintext doesn't reveal anything a reader couldn't already decompress.
 */
export interface CompressedGameState {
  __gz: string
  status: GameState['status']
  roundPhase: GameState['roundPhase']
  turn: GameState['turn']
  pendingPlayerIds: GameState['pendingPlayerIds']
  turnOrder: GameState['turnOrder']
  boardSetup: GameState['boardSetup']
}

export type StoredGameState = GameState | CompressedGameState

function isCompressedGameState(value: StoredGameState): value is CompressedGameState {
  return typeof value === 'object' && value !== null && '__gz' in value
}

export async function compressGameStateForStorage(state: GameState): Promise<CompressedGameState> {
  return {
    __gz: await gzipToBase64(JSON.stringify(state)),
    status: state.status,
    roundPhase: state.roundPhase,
    turn: state.turn,
    pendingPlayerIds: state.pendingPlayerIds,
    turnOrder: state.turnOrder,
    boardSetup: state.boardSetup,
  }
}

export async function decompressGameStateFromStorage(stored: StoredGameState): Promise<GameState> {
  if (!isCompressedGameState(stored)) return stored
  return JSON.parse(await gunzipFromBase64(stored.__gz)) as GameState
}
