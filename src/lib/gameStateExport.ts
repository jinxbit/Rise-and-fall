import type { GameState as EngineGameState } from '../engine/types'

/**
 * Debug export format for pasting a game state into a bug report or chat
 * (see GamePage.tsx's "Copy JSON" / "Copy state export" buttons).
 * Gzip-compressed and base64-encoded so a full game state collapses to a
 * single line that's actually pasteable, instead of the multi-kilobyte
 * pretty-printed JSON.
 * The envelope (schema + version) lets a decoder recognize and validate the
 * blob before trusting its contents, and gives room to change the encoding
 * later without breaking old exports.
 */
export const GAME_STATE_EXPORT_SCHEMA = 'rise-and-fall/game-state-export'
export const GAME_STATE_EXPORT_VERSION = 1

/** Short non-JSON marker prefixed to every export so it's recognizable at a glance and a decoder can reject non-exports before attempting to decompress. */
const EXPORT_PREFIX = 'RAF-STATE-1:'

export interface GameStateExportEnvelope {
  schema: typeof GAME_STATE_EXPORT_SCHEMA
  version: typeof GAME_STATE_EXPORT_VERSION
  exportedAt: string
  gameState: EngineGameState
}

export async function encodeGameStateExport(gameState: EngineGameState): Promise<string> {
  const envelope: GameStateExportEnvelope = {
    schema: GAME_STATE_EXPORT_SCHEMA,
    version: GAME_STATE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    gameState,
  }
  const compressed = await gzip(new TextEncoder().encode(JSON.stringify(envelope)))
  return EXPORT_PREFIX + bytesToBase64(compressed)
}

export async function decodeGameStateExport(text: string): Promise<GameStateExportEnvelope> {
  const trimmed = text.trim()
  if (!trimmed.startsWith(EXPORT_PREFIX)) {
    throw new Error(`Not a recognized game state export (expected the "${EXPORT_PREFIX}" prefix).`)
  }
  const decompressed = await gunzip(base64ToBytes(trimmed.slice(EXPORT_PREFIX.length)))
  const envelope = JSON.parse(new TextDecoder().decode(decompressed)) as GameStateExportEnvelope
  if (envelope.schema !== GAME_STATE_EXPORT_SCHEMA) {
    throw new Error(`Unrecognized game state export schema: ${String(envelope.schema)}`)
  }
  return envelope
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
