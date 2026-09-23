/**
 * A structural patch between two JSON-compatible values of the same shape —
 * issue #648: `get-game-state`/`apply-action`/`undo-action`/`redo-action`
 * used to send a caller's whole per-seat `stateWithoutHistory` view on every
 * request, even though most of it (the board, achievements, resources, ...)
 * barely changes move to move. This is the generic diff/patch pair those
 * callers use to send only what actually changed.
 *
 * Deliberately not RFC 6902 (JSON Patch): every diff here runs between two
 * views of the same `GameState`-shaped object for the same viewer, so a
 * format that mirrors the source shape needs no path strings and is simpler
 * to generate and apply correctly, at the same size. `node` is `null` when
 * nothing changed (the common case for most of a `GameState`'s top-level
 * keys on an ordinary move) — callers short-circuit on that rather than
 * emitting an empty object patch.
 */
export type StatePatchNode =
  | { t: 'value'; v: unknown }
  | { t: 'object'; set: Record<string, StatePatchNode>; unset: string[] }
  | { t: 'array'; length: number; set: Record<number, StatePatchNode> }

export type StatePatch = StatePatchNode | null

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural equality over JSON-compatible values — used only to decide whether a leaf actually changed, not as a general-purpose utility. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    return aKeys.length === bKeys.length && aKeys.every((key) => key in b && deepEqual(a[key], b[key]))
  }
  return false
}

/**
 * Diffs `previous` against `current`, returning `null` when they're
 * structurally identical. A type change (object -> array, array -> object,
 * either -> a primitive) or a value that's simply not present in `previous`
 * falls back to a full `{t: 'value'}` replacement rather than a partial
 * patch — there's nothing to diff against in that case.
 */
export function diffState(previous: unknown, current: unknown): StatePatch {
  if (deepEqual(previous, current)) return null

  if (Array.isArray(previous) && Array.isArray(current)) {
    const set: Record<number, StatePatchNode> = {}
    for (let i = 0; i < current.length; i++) {
      const sub = i < previous.length ? diffState(previous[i], current[i]) : { t: 'value' as const, v: current[i] }
      if (sub) set[i] = sub
    }
    return { t: 'array', length: current.length, set }
  }

  if (isPlainObject(previous) && isPlainObject(current)) {
    const set: Record<string, StatePatchNode> = {}
    const unset: string[] = []
    for (const key of Object.keys(current)) {
      const sub = key in previous ? diffState(previous[key], current[key]) : { t: 'value' as const, v: current[key] }
      if (sub) set[key] = sub
    }
    for (const key of Object.keys(previous)) {
      if (!(key in current)) unset.push(key)
    }
    return { t: 'object', set, unset }
  }

  return { t: 'value', v: current }
}

/**
 * The exact inverse of `diffState`: `applyStatePatch(previous, diffState(previous,
 * current))` always deep-equals `current`, for any JSON-compatible `previous`/
 * `current`. `null` (no change) returns `previous` unchanged, by reference —
 * callers relying on referential stability for an untouched subtree (there
 * are none in this codebase today, but it costs nothing to preserve).
 */
export function applyStatePatch<T>(previous: T, patch: StatePatch): T {
  if (!patch) return previous
  if (patch.t === 'value') return patch.v as T
  if (patch.t === 'array') {
    const prevArr = Array.isArray(previous) ? previous : []
    const result: unknown[] = new Array(patch.length)
    for (let i = 0; i < patch.length; i++) {
      const sub = patch.set[i]
      result[i] = sub ? applyStatePatch(prevArr[i], sub) : prevArr[i]
    }
    return result as T
  }
  // patch.t === 'object'
  const prevObj: Record<string, unknown> = isPlainObject(previous) ? previous : {}
  const result: Record<string, unknown> = { ...prevObj }
  for (const key of patch.unset) delete result[key]
  for (const [key, sub] of Object.entries(patch.set)) {
    result[key] = applyStatePatch(prevObj[key], sub)
  }
  return result as T
}
