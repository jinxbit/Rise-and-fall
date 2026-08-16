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
  const compressed = await gzip(new TextEncoder().encode(JSON.stringify(gameState)))
  const file: GameStateExportFile = {
    schema: GAME_STATE_EXPORT_SCHEMA,
    version: GAME_STATE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    gameStateZipped: bytesToBase64(compressed),
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
  const decompressed = await gunzip(base64ToBytes(file.gameStateZipped))
  const gameState = JSON.parse(new TextDecoder().decode(decompressed)) as EngineGameState
  return { schema: file.schema, version: file.version, exportedAt: file.exportedAt, gameState }
}

async function gzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return readAllBytes(toReadableStream(data).pipeThrough(new CompressionStream('gzip')))
}

async function gunzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return readAllBytes(toReadableStream(data).pipeThrough(new DecompressionStream('gzip')))
}

function toReadableStream(data: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

/** Chunked to avoid blowing the call stack on String.fromCharCode(...bytes) for large states. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
