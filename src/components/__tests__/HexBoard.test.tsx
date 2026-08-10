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

describe('HexBoard — unit markers', () => {
  it('renders a rectangle marker for static kinds (City, Temple) and a circle for mobile kinds', () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city' },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', kind: 'temple' },
      { coord: { q: 2, r: 0 }, color: '#22c55e', kind: 'nomad' },
      { coord: { q: 3, r: 0 }, color: '#eab308', kind: 'ship' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    const rects = container.querySelectorAll('rect[fill="#ef4444"], rect[fill="#3b82f6"]')
    const circles = container.querySelectorAll('circle[fill="#22c55e"], circle[fill="#eab308"]')
    expect(rects).toHaveLength(2)
    expect(circles).toHaveLength(2)
    // A static marker's rect has rounded corners, distinguishing it from a bare square.
    for (const rect of rects) expect(Number(rect.getAttribute('rx'))).toBeGreaterThan(0)
    // No stray rect/circle markers for the other kind's colour.
    expect(container.querySelectorAll('circle[fill="#ef4444"], circle[fill="#3b82f6"]')).toHaveLength(0)
    expect(container.querySelectorAll('rect[fill="#22c55e"], rect[fill="#eab308"]')).toHaveLength(0)
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
