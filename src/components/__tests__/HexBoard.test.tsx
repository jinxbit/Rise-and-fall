import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HexBoard } from '../HexBoard'
import type { UnitMarker } from '../HexBoard'
import { createEmptyBoard, setTile } from '../../engine/board'

function makeBoard() {
  let board = createEmptyBoard('hex')
  for (const [q, r] of [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ] as const) {
    board = setTile(board, { q, r }, 'plain')
  }
  return board
}

const NEUTRAL_PLATE_COLOR = '#f2f2ef'

describe('HexBoard — unit markers', () => {
  it('renders a rectangle marker for static kinds (City, Temple) and a circle for mobile kinds, both in the fixed neutral plate colour', () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city' },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', kind: 'temple' },
      { coord: { q: 2, r: 0 }, color: '#22c55e', kind: 'nomad' },
      { coord: { q: 3, r: 0 }, color: '#eab308', kind: 'ship' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    // The marker's own shape is always the fixed neutral colour, never the
    // player's — that keeps the glyph's contrast independent of which of
    // the four player colours (or which terrain) it's sitting on.
    const plateRects = container.querySelectorAll(`rect[fill="${NEUTRAL_PLATE_COLOR}"]`)
    const plateCircles = container.querySelectorAll(`circle[fill="${NEUTRAL_PLATE_COLOR}"]`)
    expect(plateRects).toHaveLength(2) // city, temple
    expect(plateCircles).toHaveLength(2) // nomad, ship
    // A static marker's rect has rounded corners, distinguishing it from a bare square.
    for (const rect of plateRects) expect(Number(rect.getAttribute('rx'))).toBeGreaterThan(0)
  })

  it("shows ownership as a single bar beneath the marker, in the player's colour — not on the marker shape itself", () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city' },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', kind: 'nomad' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    for (const unit of units) {
      // Exactly one element carries the player's colour: the ownership bar
      // (a <rect>, even for a mobile unit whose own marker plate is a <circle>).
      const colored = container.querySelectorAll(`[fill="${unit.color}"]`)
      expect(colored).toHaveLength(1)
      expect(colored[0].tagName).toBe('rect')
    }
  })

  it("draws each unit's glyph as a nested icon svg, one per unit", () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city' },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', kind: 'nomad' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    const glyphs = container.querySelectorAll('svg svg[viewBox]')
    expect(glyphs).toHaveLength(2)
    for (const glyph of glyphs) expect(glyph.getAttribute('viewBox')).toBe('0 0 24 24')
  })

  it('does not crash on an unrecognized unit kind — just renders an empty glyph', () => {
    const units: UnitMarker[] = [{ coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'not-a-real-kind' }]
    expect(() => render(<HexBoard board={makeBoard()} units={units} />)).not.toThrow()
  })
})

describe('HexBoard — history-review labels', () => {
  it("staggers two nearby units' history labels instead of overlapping — the reported bug (adjacent units' production amounts overlapped)", () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'nomad', historyLabel: '+1 Wood' },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', kind: 'nomad', historyLabel: '+1 Stone' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    const labels = container.querySelectorAll('foreignObject')
    expect(labels).toHaveLength(2)
    const [first, second] = [...labels]
    const firstY = Number(first.getAttribute('y'))
    const secondY = Number(second.getAttribute('y'))
    const height = Number(first.getAttribute('height'))

    // Two labels whose x ranges are within a label-width of each other (as
    // (0,0) and (1,0)'s are) must not vertically overlap — one gets bumped
    // to a lower stacked slot.
    expect(Math.abs(firstY - secondY)).toBeGreaterThanOrEqual(height)
  })

  it("doesn't stagger two units' labels when they're far enough apart to never overlap", () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'nomad', historyLabel: '+1 Wood' },
      { coord: { q: 20, r: 0 }, color: '#3b82f6', kind: 'nomad', historyLabel: '+1 Stone' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    const labels = [...container.querySelectorAll('foreignObject')]
    expect(labels).toHaveLength(2)
    // Both at their normal, unstaggered slot (same y).
    expect(labels[0].getAttribute('y')).toBe(labels[1].getAttribute('y'))
  })

  it('renders no label element for a unit with no historyLabel', () => {
    const units: UnitMarker[] = [{ coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'nomad' }]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)
    expect(container.querySelectorAll('foreignObject')).toHaveLength(0)
  })
})
