/**
 * Seeded PRNG (mulberry32). The generator's whole state is one 32-bit
 * integer kept on `KoggeState.rng`, so replaying the same setup and actions
 * always reproduces the same draws.
 */
export function nextRandom(state: { rng: number }): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function randomInt(state: { rng: number }, maxExclusive: number): number {
  return Math.floor(nextRandom(state) * maxExclusive)
}

export function shuffle<T>(state: { rng: number }, items: T[]): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(state, i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
