import { useLayoutEffect, useRef, useState } from 'react'

/**
 * "Do this flex row's children all still fit on one line?" — measured from
 * the real DOM rather than guessed from a breakpoint.
 *
 * Built for GamePage's header (issue #640). That header has four logical
 * groups (menu/name/next-game, chat/player names, round/bank,
 * undo/redo/review) and wants two completely different layouts: one row with
 * undo/redo flush right when everything fits, and the older stacked,
 * left-aligned layout when it doesn't. Whether it fits is *content*
 * dependent — game name length, player count, display-name lengths, bank
 * digits — so every fixed breakpoint attempt at this (issue #640's first
 * three, via native `flex-wrap` line-packing, `flex-1`->`flex-auto`, then an
 * `@2xl` container query) was wrong for some real game and degraded badly
 * rather than gracefully: just past the threshold the row wrapped and
 * squeezed undo/redo into a ~130px column beside the player names instead of
 * giving it its own line. Measuring removes the guess.
 *
 * Three things this has to get right, each one a way a naive version breaks:
 *
 * 1. **The measured layout must be unshrinkable.** If the row may wrap or
 *    flex-shrink, the children report their *squeezed* width, the sum always
 *    fits the available width, and it reports "fits" forever. So the caller
 *    renders the wide mode as `flex-nowrap` with non-shrinking children (see
 *    GamePage's `headerGroupClass`); it overflows for a single layout pass
 *    instead of wrapping, and `useLayoutEffect` flips the state before the
 *    browser paints, so nothing overflowing is ever visible.
 * 2. **The threshold is latched.** Narrow mode changes the children's widths
 *    (they get the full row and stop wrapping internally), so re-deriving the
 *    answer from the narrow layout would say "fits", flip back to wide, wrap
 *    again, and oscillate. Instead we remember the width the row actually
 *    needed at the moment we left wide mode, and only return to wide once the
 *    container grows past it (plus `HYSTERESIS_PX`, so a sub-pixel rounding
 *    difference can't thrash).
 * 3. **`contentKey` resets the latch.** A latched threshold measured with two
 *    players is meaningless once a third joins, so the caller passes a
 *    signature of whatever it renders; on a change we optimistically go wide
 *    and re-measure.
 *
 * Returns a ref to attach to the row element and the current answer. A
 * container of zero width (jsdom, which has no layout at all; or a display:
 * none ancestor) is treated as "not measurable" and leaves the answer alone
 * — which is why the decision itself lives in `decideOneLineFit` below,
 * where it can be unit-tested without a layout engine.
 */

/** Slack, in px, the container must exceed the latched requirement by before narrow mode returns to wide — guards against flip-flopping on a sub-pixel difference. */
const HYSTERESIS_PX = 8

export interface OneLineFitInput {
  /** The row's own inner width, `clientWidth`. Zero means "not measurable" (jsdom, or a hidden ancestor). */
  available: number
  /** Sum of the children's widths plus the gaps between them, as measured in wide mode. Ignored while already narrow. */
  required: number
  /** The width wide mode needed at the moment it last stopped fitting — 0 before that has ever happened. */
  latched: number
  /** Whether wide mode is currently rendered, which is what makes `required` meaningful. */
  fits: boolean
}

/**
 * The pure half of `useOneLineFit` — see that hook's doc comment for why the
 * wide->narrow and narrow->wide directions are asymmetric. Returns the next
 * state, or null for "no change" (including the unmeasurable case).
 */
export function decideOneLineFit({ available, required, latched, fits }: OneLineFitInput): { fits: boolean; latched: number } | null {
  if (available <= 0) return null
  if (fits) {
    if (required <= available) return null
    return { fits: false, latched: required }
  }
  if (available >= latched + HYSTERESIS_PX) return { fits: true, latched }
  return null
}

/** Sum of a flex row's children plus the `column-gap` between them — what wide mode needs to render without wrapping or shrinking. */
function measureRequiredWidth(row: HTMLElement): number {
  const children = Array.from(row.children) as HTMLElement[]
  if (children.length === 0) return 0
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0
  return children.reduce((sum, child) => sum + child.offsetWidth, 0) + gap * (children.length - 1)
}

export function useOneLineFit<T extends HTMLElement>(contentKey: string): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const latched = useRef(0)
  const [fits, setFits] = useState(true)

  // New content invalidates the latched requirement (point 3 above): drop it
  // and go optimistically wide, so the effect below re-measures from scratch.
  useLayoutEffect(() => {
    latched.current = 0
    setFits(true)
  }, [contentKey])

  useLayoutEffect(() => {
    const row = ref.current
    if (!row) return

    function measure() {
      if (!row) return
      const next = decideOneLineFit({
        available: row.clientWidth,
        required: fits ? measureRequiredWidth(row) : 0,
        latched: latched.current,
        fits,
      })
      if (!next) return
      latched.current = next.latched
      setFits(next.fits)
    }

    measure()
    // jsdom has no ResizeObserver; the single measure() above is all a test
    // environment without layout can do anyway.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [fits, contentKey])

  return [ref, fits]
}
