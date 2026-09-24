import { compressGameStateForStorage, decompressGameStateFromStorage, type CompressedGameState } from './gameStateCompression'
import type { GameState } from '../engine/types'

/**
 * IndexedDB-backed cache of the client-materialised `GameState` (issue
 * #688): the only client-side persistence in the app before this was a
 * sign-in redirect path in `sessionStorage` (`pendingRedirect.ts`), so a
 * cold open — closing the tab and reopening hours later, the app's normal
 * async usage pattern — always paid for a full `get-game-state` fetch, even
 * though #647 already taught that Edge Function to answer with just the
 * entries logged since a `sinceActionIndex` the caller already holds.
 * `GamePage.tsx` reads this on mount to seed that delta request, and writes
 * it after every applied snapshot, so the *next* cold open has a cursor to
 * send instead of nothing.
 *
 * This is a **seed for a delta request, never something rendered ahead of
 * the server confirming it** — `fetchGameState` (GamePage.tsx) only ever
 * uses a `loadCachedGameState` result as `getGameStateRedacted`'s `previous`
 * parameter, exactly the same role `latestGameStateRef` already plays for a
 * same-session refetch (issue #647). Nothing here renders before that
 * fetch resolves. Also: this only ever helps a `usesRedactedReads` game —
 * `getGameState` (the client-trusted/no-hidden-information path) has no
 * delta parameter to seed at all, so `fetchGameState` just ignores whatever
 * this returns for those games, same as it already ignores a same-session
 * `previous` for them.
 *
 * Every read and write degrades silently to "no cache": IndexedDB can be
 * unavailable (private browsing, disabled site data) or throw (quota,
 * corruption) for reasons that have nothing to do with whether the game
 * itself is playable, so nothing here is allowed to reject or throw past
 * its own boundary — a failure just means the next fetch is a full one,
 * indistinguishable from a first-ever visit.
 *
 * Invalidation is enforced entirely at read time (`loadCachedGameState`)
 * rather than by ever deleting a stale entry, since "stale" is relative to
 * information (the running build, the signed-in user) the write side has no
 * reason to recheck on every snapshot:
 * - **buildId**: compared against `__BUILD_ID__` (`vite.config.ts`) — a
 *   state materialised by an older engine build must never seed a delta
 *   request against a newer one's rules.
 * - **userId**: not really "checked" so much as structural — the store's
 *   key embeds it, so a lookup for the current session's `userId` can only
 *   ever return that user's own entry, the same property issue #688 asks
 *   for ("scoping the entry to userId also stops a shared browser handing
 *   one account's view to the next").
 * - **stateHash**: an FNV-1a hash of the raw (pre-compression) state,
 *   recomputed after decompression and compared to what was stored. This is
 *   deliberately a self-consistency check — it catches a corrupted or
 *   partially-written IndexedDB entry — not a check against anything the
 *   server reports; the server has no notion of a content hash for a given
 *   version (#647 only ever agreed on lengths — see
 *   `applyRedactedGameStateDelta` in `../engine/redaction.ts`), and this
 *   issue is explicit about building against #647's existing request shape
 *   rather than inventing a new one.
 * - **version too new / not recognised**: not checked here at all — it
 *   falls out of `get-game-state`'s existing contract for free. A
 *   `sinceActionIndex` outside `[0, safePrefixLength]` already makes that
 *   Edge Function answer with a full response, byte for byte, the same as
 *   omitting it (issue #647's doc comment on `getGameStateRedacted`).
 */

const DB_NAME = 'riseAndFall'
const DB_VERSION = 1
const STORE_NAME = 'gameStateCache'
const SAVED_AT_INDEX = 'savedAt'

/** How many entries survive an eviction pass — see `evictOldEntries` below. Comfortably covers every game a player plausibly has open at once, while keeping total storage a small multiple of one late-game state (issue #688's ~76 KB raw figure; gzip cuts that substantially, see gameStateCompression.test.ts). Exported for evictOldEntries's own test to assert against, not used by any other caller. */
export const MAX_ENTRIES = 20

interface CachedGameStateEntry {
  key: string
  gameId: string
  userId: string
  buildId: string
  version: number
  actionHistoryLength: number
  stateHash: string
  state: CompressedGameState
  savedAt: number
}

function cacheKey(gameId: string, userId: string): string {
  return `${gameId}:${userId}`
}

/** Non-cryptographic FNV-1a over the raw JSON — cheap, deterministic, and only ever used to catch this entry disagreeing with itself, not as a security boundary. */
function hashState(json: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' })
        store.createIndex(SAVED_AT_INDEX, 'savedAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

/**
 * Deletes the oldest entries (by `savedAt`) until at most `MAX_ENTRIES`
 * remain, so a player who accumulates games indefinitely (see issue #687,
 * the same unbounded-growth shape on the server side) doesn't grow this
 * store without bound. Runs in the same transaction as the write that
 * triggered it, so a crash mid-eviction never leaves the store double-
 * counted or half-cleaned relative to what was actually persisted.
 */
async function evictOldEntries(store: IDBObjectStore): Promise<void> {
  const count = await promisify(store.count())
  let toDelete = count - MAX_ENTRIES
  if (toDelete <= 0) return
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = store.index(SAVED_AT_INDEX).openCursor()
    cursorRequest.onerror = () => reject(cursorRequest.error)
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor || toDelete <= 0) {
        resolve()
        return
      }
      cursor.delete()
      toDelete--
      cursor.continue()
    }
  })
}

/**
 * Persists `state` as the cached copy for `gameId`/`userId`, for a later
 * `loadCachedGameState` to seed a delta request with. Never throws — any
 * IndexedDB failure is swallowed, since a missed cache write just means the
 * next read falls back to a full fetch, same as if this had never run.
 */
export async function saveCachedGameState(gameId: string, userId: string, version: number, state: GameState): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    const raw = JSON.stringify(state)
    const entry: CachedGameStateEntry = {
      key: cacheKey(gameId, userId),
      gameId,
      userId,
      buildId: __BUILD_ID__,
      version,
      actionHistoryLength: state.actionHistory.length,
      stateHash: hashState(raw),
      state: await compressGameStateForStorage(state),
      savedAt: Date.now(),
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
      const store = tx.objectStore(STORE_NAME)
      store.put(entry)
      void evictOldEntries(store)
    })
    db.close()
  } catch {
    // Degrade silently (issue #688) — quota exhaustion, a blocked/disabled
    // store, private browsing, etc. are all just "no cache from here on".
  }
}

/**
 * Reads back the cached state for `gameId`/`userId`, or `null` if there is
 * none, it doesn't pass the invalidation checks described in this module's
 * doc comment, or IndexedDB itself failed. Never throws.
 */
export async function loadCachedGameState(gameId: string, userId: string): Promise<GameState | null> {
  try {
    const db = await openDb()
    if (!db) return null
    const entry = await new Promise<CachedGameStateEntry | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(cacheKey(gameId, userId))
      request.onsuccess = () => resolve(request.result as CachedGameStateEntry | undefined)
      request.onerror = () => reject(request.error)
    })
    db.close()
    if (!entry) return null
    if (entry.buildId !== __BUILD_ID__ || entry.userId !== userId || entry.gameId !== gameId) return null
    const state = await decompressGameStateFromStorage(entry.state)
    if (hashState(JSON.stringify(state)) !== entry.stateHash) return null
    return state
  } catch {
    return null
  }
}
