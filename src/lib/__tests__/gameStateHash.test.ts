import { beforeAll, describe, expect, it } from 'vitest'
import { canonicalJson, hashGameStateView } from '../gameStateHash'
import { loadProductionGameFixtures } from '../../test/fixtures/productionGames/loadFixtures'
import type { GameState } from '../../engine/types'

// A real recorded game's genesis, rather than a hand-built GameRow — those
// drift every time GameSettings grows a field, and this file cares about
// serialisation, not about room configuration.
let genesis: GameState
beforeAll(async () => {
  const [fixture] = await loadProductionGameFixtures()
  genesis = fixture.genesis
})

const entry = (timestamp: string) => ({
  action: { type: 'PASS_ACTIONS' as const, playerId: 'seat-alice' },
  turn: 0,
  timestamp,
})

describe('canonicalJson', () => {
  it('is insensitive to key order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  })

  it('keeps array order, which is meaningful in a GameState', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('drops undefined values the way JSON.stringify does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })
})

describe('hashGameStateView', () => {
  it('ignores the log’s contents, so wall-clock timestamps cannot cause a phantom mismatch', () => {
    // applyAction stamps new Date().toISOString() on every entry it logs, so a
    // client's own replay never reproduces the server's timestamps. Hashing
    // the log would make the check fail always — see gameStateHash.ts.
    const mine = { ...genesis, actionHistory: [entry('2026-01-01T00:00:00.000Z')] }
    const theirs = { ...genesis, actionHistory: [entry('2026-06-06T12:34:56.000Z')] }
    expect(hashGameStateView(mine)).toBe(hashGameStateView(theirs))
  })

  it('still notices a log spliced at the wrong offset, via its length', () => {
    const one = { ...genesis, actionHistory: [entry('2026-01-01T00:00:00.000Z')] }
    const two = { ...genesis, actionHistory: [entry('2026-01-01T00:00:00.000Z'), entry('2026-01-01T00:00:01.000Z')] }
    expect(hashGameStateView(one)).not.toBe(hashGameStateView(two))
  })

  it('notices a state that actually differs', () => {
    expect(hashGameStateView(genesis)).not.toBe(hashGameStateView({ ...genesis, turn: genesis.turn + 1 }))
  })

  it('agrees across a JSON round trip, the way a cached state reaches the client', () => {
    expect(hashGameStateView(JSON.parse(JSON.stringify(genesis)) as GameState)).toBe(hashGameStateView(genesis))
  })

  it('agrees when the same state is rebuilt with its keys in a different order', () => {
    const shuffled = Object.fromEntries(Object.entries(genesis).reverse()) as unknown as GameState
    expect(hashGameStateView(shuffled)).toBe(hashGameStateView(genesis))
  })
})
