/**
 * Byte-level gzip/base64 helpers, shared by `gameStateExport.ts` (the "copy
 * game export" debug feature) and `gameStateCompression.ts` (compressing
 * `game_state.state` at rest for `ruleEnforcementEnabled` games). Built on
 * `CompressionStream`/`DecompressionStream`, which both browsers and the
 * Supabase Edge Runtime (Deno) implement, so this same file is imported
 * unmodified from `supabase/functions/_shared/gameEnforcement.ts` — no
 * separate server-side implementation needed.
 */

export async function gzipToBase64(text: string): Promise<string> {
  const compressed = await gzip(new TextEncoder().encode(text))
  return bytesToBase64(compressed)
}

export async function gunzipFromBase64(base64: string): Promise<string> {
  const decompressed = await gunzip(base64ToBytes(base64))
  return new TextDecoder().decode(decompressed)
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
