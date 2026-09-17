import { describe, expect, it } from 'vitest'
import { decideOneLineFit } from '../useOneLineFit'

/**
 * `useOneLineFit` itself can't be tested here — jsdom has no layout engine,
 * so every `offsetWidth`/`clientWidth` reads 0 and the hook correctly
 * declines to decide anything. What it *can* be tested on is the decision
 * rule those measurements feed, which is why that rule is a pure exported
 * function. The rendering it drives (GamePage's two header layouts, issue
 * #640) needs a real browser at real widths.
 */
describe('decideOneLineFit', () => {
  it('stays wide while the row still fits', () => {
    expect(decideOneLineFit({ available: 1000, required: 800, latched: 0, fits: true })).toBeNull()
  })

  it('goes narrow and latches what wide mode needed once it no longer fits', () => {
    expect(decideOneLineFit({ available: 700, required: 820, latched: 0, fits: true })).toEqual({ fits: false, latched: 820 })
  })

  it('treats exactly-fitting as fitting', () => {
    expect(decideOneLineFit({ available: 820, required: 820, latched: 0, fits: true })).toBeNull()
  })

  it('stays narrow until the container clears the latched requirement', () => {
    // Narrow mode re-flows the groups, so the only thing that may bring wide
    // mode back is the container growing past what wide mode actually needed.
    expect(decideOneLineFit({ available: 800, required: 0, latched: 820, fits: false })).toBeNull()
    expect(decideOneLineFit({ available: 820, required: 0, latched: 820, fits: false })).toBeNull()
  })

  it('does not flip back on a sub-pixel gain — that is what would oscillate', () => {
    expect(decideOneLineFit({ available: 820.5, required: 0, latched: 820, fits: false })).toBeNull()
    expect(decideOneLineFit({ available: 828, required: 0, latched: 820, fits: false })).toEqual({ fits: true, latched: 820 })
  })

  it('decides nothing when the row is unmeasurable (jsdom, or a hidden ancestor)', () => {
    expect(decideOneLineFit({ available: 0, required: 5000, latched: 0, fits: true })).toBeNull()
    expect(decideOneLineFit({ available: 0, required: 0, latched: 820, fits: false })).toBeNull()
  })
})
