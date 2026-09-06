/**
 * Tracks the cumulative size of network requests/responses made through the
 * Supabase client for the current browser session (page load until reload).
 * Wraps the `fetch` passed to `createClient` so it sees every REST/Auth/RPC
 * call the client makes; realtime (websocket) traffic isn't covered since
 * supabase-js manages that socket separately.
 */

type Listener = (bytes: number) => void

let totalBytes = 0
const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) listener(totalBytes)
}

function bodyByteLength(body: BodyInit | null | undefined): number {
  if (body == null) return 0
  if (typeof body === 'string') return new TextEncoder().encode(body).length
  if (body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).length
  // FormData/ReadableStream bodies aren't sized cheaply — uncommon for the
  // Supabase client, so they're left uncounted rather than fully buffered.
  return 0
}

async function responseByteLength(response: Response): Promise<number> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsed = Number.parseInt(contentLength, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  try {
    const buffer = await response.clone().arrayBuffer()
    return buffer.byteLength
  } catch {
    return 0
  }
}

/** Wraps a fetch implementation so every call it makes adds to the session traffic total. */
export function trackFetch(baseFetch: typeof fetch): typeof fetch {
  return async function trackedFetch(input, init) {
    const requestBytes = bodyByteLength(init?.body)
    const response = await baseFetch(input, init)
    const responseBytes = await responseByteLength(response)
    totalBytes += requestBytes + responseBytes
    notify()
    return response
  }
}

export function getTrafficBytes(): number {
  return totalBytes
}

export function subscribeToTraffic(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unitIndex]}`
}
