import type { MarkerCounts } from './types'

/**
 * Turn-order bid ranking — KOGGE_PLAN.md "Market and turn-order auction".
 * A set of identical markers beats any mixed bid; bigger sets beat smaller
 * ones, then higher values; mixed bids compare by sum. An empty bid (a pass)
 * ranks below everything.
 */
export function bidStrength(markers: number[]): [number, number, number] {
  if (markers.length === 0) return [-1, 0, 0]
  const allSame = markers.every((m) => m === markers[0])
  if (allSame) return [1, markers.length, markers[0]]
  return [0, markers.reduce((a, b) => a + b, 0), 0]
}

/** Positive when `a` beats `b`, negative when `b` beats `a`, 0 when equal. */
export function compareBids(a: number[], b: number[]): number {
  const sa = bidStrength(a)
  const sb = bidStrength(b)
  for (let i = 0; i < 3; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i]
  return 0
}

export function bidKey(markers: number[]): string {
  return markers.slice().sort((x, y) => x - y).join(',')
}

export function describeBid(markers: number[]): string {
  if (markers.length === 0) return 'pass'
  const [tier, a, b] = bidStrength(markers)
  const list = markers.slice().sort((x, y) => y - x).join(' + ')
  return tier === 1 ? `${list} (set of ${a}×${b})` : `${list} (sum ${a})`
}

/**
 * Whether a hand holding `hand` can make any bid not already in `previous`.
 * The hand has prod(count+1) − 1 distinct non-empty sub-multisets; a legal
 * bid exists iff not all of them were already bid.
 */
export function hasLegalBid(hand: MarkerCounts, previous: number[][]): boolean {
  let subsets = 1
  for (const c of hand) subsets *= c + 1
  subsets -= 1
  if (subsets === 0) return false
  const taken = new Set<string>()
  for (const bid of previous) {
    if (bid.length === 0) continue
    const counts = countMarkers(bid)
    if (counts.every((c, v) => c <= hand[v])) taken.add(bidKey(bid))
  }
  return subsets > taken.size
}

export function countMarkers(markers: number[]): MarkerCounts {
  const counts = new Array<number>(9).fill(0)
  for (const m of markers) counts[m] += 1
  return counts
}
