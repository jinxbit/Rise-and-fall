// Shared gzip + base64 helpers used to shrink large JSON payloads before
// they go over the wire or into storage — see gameStateCompression.ts (the
// game_state column) and gameStateExport.ts (the "copy game export" file),
// which both compress the same kind of payload (a serialized GameState).

export async function gzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return readAllBytes(toReadableStream(data).pipeThrough(new CompressionStream('gzip')))
}

export async function gunzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
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

/** Chunked to avoid blowing the call stack on String.fromCharCode(...bytes) for large payloads. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
