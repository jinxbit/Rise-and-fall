import type { GameState as EngineGameState } from '../engine/types'
import { gzip, gunzip, bytesToBase64, base64ToBytes } from './gzip'

/**
 * On-the-wire/on-disk shape of game_state.state (still a jsonb column, so
 * this must stay valid JSON): every write since this was introduced stores
 * `{ __gz }` — gzip+base64 of `JSON.stringify(GameState)` — instead of the
 * raw object, since a live game rebroadcasts the full column via Realtime on
 * every action and a game state is tens of KB pretty-printed (same technique
 * gameStateExport.ts already used for the "copy game export" file). Rows
 * written before this shipped are still a bare GameState object with no
 * `__gz` key, and are read back as-is — no backfill migration needed, they
 * simply get compressed the next time that game is written to.
 */
export interface CompressedGameStateEnvelope {
  __gz: string
}

export type StoredGameState = EngineGameState | CompressedGameStateEnvelope

export async function compressGameStateForStorage(state: EngineGameState): Promise<CompressedGameStateEnvelope> {
  const compressed = await gzip(new TextEncoder().encode(JSON.stringify(state)))
  return { __gz: bytesToBase64(compressed) }
}

export async function decompressGameStateFromStorage(stored: StoredGameState): Promise<EngineGameState> {
  if (!isCompressedEnvelope(stored)) return stored
  const decompressed = await gunzip(base64ToBytes(stored.__gz))
  return JSON.parse(new TextDecoder().decode(decompressed)) as EngineGameState
}

function isCompressedEnvelope(stored: StoredGameState): stored is CompressedGameStateEnvelope {
  return typeof (stored as CompressedGameStateEnvelope).__gz === 'string'
}
