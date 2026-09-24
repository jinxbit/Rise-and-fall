/**
 * A stable fingerprint of a client-shaped `GameState`, used by the delta read
 * path (`get-game-state`, `gameApi.ts`'s `getGameStateRedacted`) so a client
 * that rebuilds the state itself can prove it got the same answer the server
 * did — and fall back to a full fetch when it didn't.
 *
 * WHY THE HASH EXISTS: the delta protocol has the client replay the actions
 * the server sends rather than being handed a materialised state. That is
 * only safe if a client running a *different* engine than the server — a PWA
 * holding a stale bundle after a rules change, which is normal operation
 * here, not an edge case — can be detected. It converts engine skew from a
 * silently wrong board into a cache miss.
 *
 * TWO THINGS IT DELIBERATELY EXCLUDES, both learned the hard way:
 *
 * 1. **`actionHistory` itself.** `applyAction` stamps `new Date().toISOString()`
 *    on every entry it logs (applyAction.ts), so two independently-produced
 *    states never agree on timestamps even when every game-logic field does —
 *    the same fact `stripTimestamps` exists for in
 *    src/test/fixtures/productionGames/loadFixtures.ts. Hashing the log would
 *    make the check fail *always*, which would look like the design not
 *    working rather than like a serialisation bug. Only the log's **length**
 *    is folded in, which is enough to catch a client that spliced the append
 *    at the wrong offset — an error that would otherwise pass verification
 *    silently and leave the game log and the Undo button wrong while the
 *    board looked fine.
 *
 * 2. **Key order.** `JSON.stringify` preserves insertion order, and the two
 *    sides reach the same state by different paths (the server from a
 *    gunzipped row, the client from a replay onto a cached base), so
 *    structurally identical states can serialise differently. Keys are sorted
 *    recursively here so that cannot produce a phantom mismatch.
 *
 * The hash is FNV-1a, not a cryptographic digest: it guards against accident,
 * not against an adversary. The server is already trusted for the state
 * itself, so a stronger hash would defend nothing, and a synchronous one
 * keeps every caller free of async plumbing. (gameStateCache.ts uses the same
 * primitive for its own integrity check — `fnv1a` is shared from here rather
 * than written twice.)
 */
import type { GameState } from '../engine/types.ts'

/** FNV-1a, 32-bit, hex. Shared with gameStateCache.ts's entry integrity check. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * `JSON.stringify` with object keys sorted at every depth. Array order is
 * meaningful in a `GameState` (turn order, hands, the log) and is preserved;
 * only object key order, which is not meaningful, is normalised.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * The fingerprint the server sends and the client checks: everything about
 * the state except the log, plus the log's length. See this module's doc
 * comment for why the log's *contents* are excluded.
 */
export function hashGameStateView(state: GameState): string {
  const { actionHistory, ...rest } = state
  return fnv1a(canonicalJson({ state: rest, actionHistoryLength: actionHistory.length }))
}
