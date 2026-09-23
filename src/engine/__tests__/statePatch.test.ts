import { describe, expect, it, test } from 'vitest'
import { applyStatePatch, diffState, type StatePatch } from '../statePatch'

/** `applyStatePatch(previous, diffState(previous, current))` should always reproduce `current` exactly — the property both diffState and applyStatePatch exist to uphold. */
function expectRoundTrip(previous: unknown, current: unknown) {
  const patch = diffState(previous, current)
  expect(applyStatePatch(previous, patch)).toEqual(current)
}

describe('diffState/applyStatePatch', () => {
  it('returns null for identical primitives, objects, and arrays', () => {
    expect(diffState(1, 1)).toBeNull()
    expect(diffState('a', 'a')).toBeNull()
    expect(diffState(null, null)).toBeNull()
    expect(diffState({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBeNull()
    expect(diffState([1, { a: 2 }], [1, { a: 2 }])).toBeNull()
  })

  it('round-trips a changed primitive leaf inside an object', () => {
    expectRoundTrip({ a: 1, b: 'x' }, { a: 2, b: 'x' })
  })

  it('round-trips an added and a removed key', () => {
    expectRoundTrip({ a: 1, b: 2 }, { a: 1, c: 3 })
  })

  it('omits unchanged sibling keys from the patch (the whole point of a structural diff)', () => {
    const previous = { board: { big: 'unchanged', tiles: [1, 2, 3] }, turn: 1 }
    const current = { board: { big: 'unchanged', tiles: [1, 2, 3] }, turn: 2 }
    const patch = diffState(previous, current) as Exclude<StatePatch, null>
    expect(patch.t).toBe('object')
    if (patch.t !== 'object') throw new Error('unreachable')
    expect(Object.keys(patch.set)).toEqual(['turn'])
    expect(applyStatePatch(previous, patch)).toEqual(current)
  })

  it('round-trips a nested object change several levels deep', () => {
    const previous = { players: { p1: { hand: ['a', 'b'], vp: 3 }, p2: { hand: ['c'], vp: 1 } } }
    const current = { players: { p1: { hand: ['a', 'b', 'd'], vp: 4 }, p2: { hand: ['c'], vp: 1 } } }
    expectRoundTrip(previous, current)
  })

  it('round-trips an array growing, shrinking, and changing in place', () => {
    expectRoundTrip([1, 2, 3], [1, 2, 3, 4])
    expectRoundTrip([1, 2, 3, 4], [1, 2])
    expectRoundTrip([1, 2, 3], [1, 9, 3])
    expectRoundTrip([], [1, 2])
    expectRoundTrip([1, 2], [])
  })

  it('round-trips an array of objects, patching only the element that changed', () => {
    const previous = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]
    const current = [{ id: 'a', v: 1 }, { id: 'b', v: 3 }]
    const patch = diffState(previous, current) as Exclude<StatePatch, null>
    expect(patch.t).toBe('array')
    if (patch.t !== 'array') throw new Error('unreachable')
    expect(Object.keys(patch.set)).toEqual(['1'])
    expect(applyStatePatch(previous, patch)).toEqual(current)
  })

  it('falls back to a full value replacement when a type changes', () => {
    expectRoundTrip({ a: 1 }, [1, 2])
    expectRoundTrip([1, 2], { a: 1 })
    expectRoundTrip({ a: 1 }, null)
    expectRoundTrip('x', { a: 1 })
  })

  it('null/undefined values are diffed like any other value', () => {
    expectRoundTrip({ a: null }, { a: 1 })
    expectRoundTrip({ a: 1 }, { a: null })
  })

  it('applying a null patch returns the previous value unchanged, by reference', () => {
    const previous = { a: 1 }
    expect(applyStatePatch(previous, null)).toBe(previous)
  })

  test.each([
    [{}, {}],
    [{ a: [1, 2, { b: 3 }] }, { a: [1, 2, { b: 4 }], c: 'new' }],
    [[1, 2, 3], [3, 2, 1]],
    [{ deep: { nested: { array: [1, 2, 3] } } }, { deep: { nested: { array: [1, 2] } } }],
  ])('round-trips arbitrary shapes: %#', (previous, current) => {
    expectRoundTrip(previous, current)
  })
})
