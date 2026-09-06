import { gunzipFromBase64, gzipToBase64 } from './gzip'
import type { GameState as EngineGameState } from '../engine/types'

/**
 * Debug export format for pasting a game state into a bug report or chat, or
 * saving it as a `.json` file (see GamePage.tsx's "Copy JSON" / "Copy game
 * export" buttons, and gameStateExport.schema.json for the file's schema).
 * A plain JSON object so it opens in any editor/JSON viewer and round-trips
 * through `JSON.parse`; only the game state itself is gzip-compressed and
 * base64-encoded (as `gameStateZipped`), since that's what dominates the
 * size — a full game state is tens of KB pretty-printed.
 * `schema`/`version` let a decoder recognize and validate the file before
 * trusting its contents, and give room to change the encoding later without
 * breaking old exports.
 */
export const GAME_STATE_EXPORT_SCHEMA = 'rise-and-fall/game-state-export'
export const GAME_STATE_EXPORT_VERSION = 1

/** The on-disk/on-clipboard shape: a real JSON object, not a custom prefix + blob. */
export interface GameStateExportFile {
  schema: typeof GAME_STATE_EXPORT_SCHEMA
  version: typeof GAME_STATE_EXPORT_VERSION
  exportedAt: string
  /** Gzip-compressed, base64-encoded `JSON.stringify(gameState)`. */
  gameStateZipped: string
}

export interface GameStateExportEnvelope {
  schema: typeof GAME_STATE_EXPORT_SCHEMA
  version: typeof GAME_STATE_EXPORT_VERSION
  exportedAt: string
  gameState: EngineGameState
}

export async function encodeGameStateExport(gameState: EngineGameState): Promise<string> {
  const file: GameStateExportFile = {
    schema: GAME_STATE_EXPORT_SCHEMA,
    version: GAME_STATE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    gameStateZipped: await gzipToBase64(JSON.stringify(gameState)),
  }
  return JSON.stringify(file)
}

export async function decodeGameStateExport(text: string): Promise<GameStateExportEnvelope> {
  let file: GameStateExportFile
  try {
    file = JSON.parse(text.trim()) as GameStateExportFile
  } catch {
    throw new Error('Not a recognized game state export (expected a JSON object).')
  }
  if (file.schema !== GAME_STATE_EXPORT_SCHEMA) {
    throw new Error(`Unrecognized game state export schema: ${String(file.schema)}`)
  }
  const gameState = JSON.parse(await gunzipFromBase64(file.gameStateZipped)) as EngineGameState
  return { schema: file.schema, version: file.version, exportedAt: file.exportedAt, gameState }
}
