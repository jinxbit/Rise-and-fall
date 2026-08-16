/** Ceiling multiples this rounds up to, within one order of magnitude — finer than a plain 1/2/5/10 progression so the axis top never overshoots by more than 25%, keeping "wasted space" above the tallest bar/point small. */
const NICE_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

/** Rounds `value` up to a "nice" axis ceiling (one of NICE_STEPS × a power of ten) — never a jagged max like 137, and never a max so loose (e.g. 100 for a value of 51) that most of the chart is empty space. */
export function niceMax(value: number): number {
  if (value <= 0) return 5
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = NICE_STEPS.find((s) => normalized <= s) ?? 10
  return step * magnitude
}
