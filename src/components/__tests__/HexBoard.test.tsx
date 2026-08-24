import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HexBoard } from '../HexBoard'
import type { ActionMenuOption, UnitMarker } from '../HexBoard'
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

describe('HexBoard — ghost cell placement preview', () => {
  it('does not resize or shift the viewBox as the ghost preview moves between hexes — bug report: "the whole map moves when moving the tile"', () => {
    const board = makeBoard()
    const extraCoords = [
      { q: -2, r: 0 },
      { q: 5, r: 0 },
    ]
    const { container, rerender } = render(
      <HexBoard board={board} extraCoords={extraCoords} ghostCells={[{ coord: { q: 1, r: 0 }, legal: true }]} />,
    )
    const svg = container.querySelector('svg')!
    const viewBoxBefore = svg.getAttribute('viewBox')

    rerender(<HexBoard board={board} extraCoords={extraCoords} ghostCells={[{ coord: { q: 5, r: 0 }, legal: false }]} />)
    expect(svg.getAttribute('viewBox')).toBe(viewBoxBefore)

    rerender(<HexBoard board={board} extraCoords={extraCoords} ghostCells={[{ coord: { q: -2, r: 0 }, legal: true }]} />)
    expect(svg.getAttribute('viewBox')).toBe(viewBoxBefore)
  })
})

describe('HexBoard — two units sharing one hex (e.g. Merchant landed on a City)', () => {
  it("offsets both plates to different centers instead of drawing one directly on top of the other — bug report: \"when merchant stops in city, the city icon is blocked\"", () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city' },
      { coord: { q: 0, r: 0 }, color: '#3b82f6', kind: 'merchant' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    const rect = container.querySelector(`rect[fill="${NEUTRAL_PLATE_COLOR}"]`)! // city's plate
    const circle = container.querySelector(`circle[fill="${NEUTRAL_PLATE_COLOR}"]`)! // merchant's plate
    expect(rect).toBeTruthy()
    expect(circle).toBeTruthy()

    const rectCx = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2
    const rectCy = Number(rect.getAttribute('y')) + Number(rect.getAttribute('height')) / 2
    const circleCx = Number(circle.getAttribute('cx'))
    const circleCy = Number(circle.getAttribute('cy'))

    expect(Math.hypot(rectCx - circleCx, rectCy - circleCy)).toBeGreaterThan(0)
  })

  it('still renders both glyphs (not just the later one) when two units share a hex', () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city' },
      { coord: { q: 0, r: 0 }, color: '#3b82f6', kind: 'merchant' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)
    expect(container.querySelectorAll('svg svg[viewBox]')).toHaveLength(2)
  })

  it('renders a lone unit at the exact hex center, full size — unaffected by the stacking offset', () => {
    const units: UnitMarker[] = [{ coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city' }]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    const rect = container.querySelector(`rect[fill="${NEUTRAL_PLATE_COLOR}"]`)!
    const cx = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2
    const cy = Number(rect.getAttribute('y')) + Number(rect.getAttribute('height')) / 2
    // Hex (0,0)'s pixel center in this rendering convention (axialToPixel) is (0, 0).
    expect(cx).toBeCloseTo(0, 5)
    expect(cy).toBeCloseTo(0, 5)
  })
})

describe('HexBoard — stacked units on one hex (e.g. a Ship docked at its own Port)', () => {
  it('offsets two units sharing a hex instead of drawing them exactly on top of each other', () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'ship' },
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'port' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    // The ownership bar is a <rect> unique to each unit (see the "single
    // bar beneath the marker" test above) — two units at the exact same
    // hex would otherwise sit at the exact same pixel position.
    const bars = [...container.querySelectorAll(`rect[fill="${units[0].color}"]`)]
    expect(bars).toHaveLength(2)
    const [first, second] = bars.map((b) => ({ x: b.getAttribute('x'), y: b.getAttribute('y') }))
    expect(first).not.toEqual(second)
  })

  it('does not offset a single unit alone on its hex — same position as before stacking existed', () => {
    const units: UnitMarker[] = [{ coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'ship' }]
    const soloRender = render(<HexBoard board={makeBoard()} units={units} />)
    const soloBar = soloRender.container.querySelector(`rect[fill="${units[0].color}"]`)!
    soloRender.unmount()

    // A second unit elsewhere on the board doesn't affect the first's
    // position either — only units sharing the SAME hex get offset.
    const withOther: UnitMarker[] = [...units, { coord: { q: 3, r: 0 }, color: '#3b82f6', kind: 'nomad' }]
    const { container } = render(<HexBoard board={makeBoard()} units={withOther} />)
    const barWithOtherPresent = container.querySelector(`rect[fill="${units[0].color}"]`)!

    expect(barWithOtherPresent.getAttribute('x')).toBe(soloBar.getAttribute('x'))
    expect(barWithOtherPresent.getAttribute('y')).toBe(soloBar.getAttribute('y'))
  })
})

describe('HexBoard — grouped action menu (more than one unit acting from the same hex)', () => {
  function optionsFor(unitId: string, unitKind: string, actionIds: string[]): ActionMenuOption[] {
    return actionIds.map((id) => ({ unitId, unitKind, id, label: `${unitKind} ${id}` }))
  }

  it("shows no per-option kind label when every option belongs to one unit (the ordinary, non-stacked case) — only each option's own bold title span", () => {
    const onSelect = vi.fn()
    const { container } = render(
      <HexBoard
        board={makeBoard()}
        actionMenu={{ coord: { q: 0, r: 0 }, options: optionsFor('ship1', 'Ship', ['move', 'trade']), onSelect }}
      />,
    )

    expect(container.querySelectorAll('foreignObject')).toHaveLength(2)
    const spans = [...container.querySelectorAll('foreignObject span')]
    expect(spans.map((s) => s.textContent)).toEqual(['Ship move', 'Ship trade'])
  })

  it('labels each option by its owning unit once more than one unit is offering options, and routes clicks back with the right unit id', () => {
    const onSelect = vi.fn()
    const options = [...optionsFor('ship1', 'Ship', ['ship-income']), ...optionsFor('port1', 'Port', ['port-income'])]
    const { container } = render(<HexBoard board={makeBoard()} actionMenu={{ coord: { q: 0, r: 0 }, options, onSelect }} />)

    const labels = [...container.querySelectorAll('foreignObject span')].map((s) => s.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Ship', 'Port']))

    const portBox = [...container.querySelectorAll('foreignObject div')].find((d) => d.textContent?.includes('port-income'))
    fireEvent.click(portBox!)
    expect(onSelect).toHaveBeenCalledWith('port1', 'port-income')
  })

  it("spaces every gap between options evenly around the full circle, including the seam where the ring wraps back to the first option — bug report: \"several elements are overlapping each other\" (a Ship docked at its own Port: 6 Ship options + 2 Port options, the closest real-content grouped menu gets)", () => {
    const onSelect = vi.fn()
    // 8 options across 2 groups, matching Ship (6 actions once The Ports
    // Tale's "Construct a Port" is added) + Port (2 actions) sharing a hex.
    const options = [
      ...optionsFor('ship1', 'Ship', ['a', 'b', 'c', 'd', 'e', 'f']),
      ...optionsFor('port1', 'Port', ['g', 'h']),
    ]
    const { container } = render(<HexBoard board={makeBoard()} actionMenu={{ coord: { q: 0, r: 0 }, options, onSelect }} />)

    const lines = [...container.querySelectorAll('g > line')]
    expect(lines).toHaveLength(8)
    const angles = lines
      .map((line) => {
        const x1 = Number(line.getAttribute('x1'))
        const y1 = Number(line.getAttribute('y1'))
        const x2 = Number(line.getAttribute('x2'))
        const y2 = Number(line.getAttribute('y2'))
        return ((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI + 360) % 360
      })
      .sort((a, b) => a - b)
    const gaps = angles.map((angle, i) => (i === 0 ? angle + 360 - angles[angles.length - 1] : angle - angles[i - 1]))

    // A within-group gap and a between-group gap are two different sizes by
    // design (the latter includes GROUP_GAP_DEGREES) — but every gap should
    // be one of those two sizes. The bug reserved no room for the group
    // gaps up front, overshooting a full circle by exactly
    // GROUP_GAP_DEGREES * groupCount — invisible everywhere except the seam
    // where the ring wraps back to the first option, which absorbed the
    // whole overshoot: for this 6+2 case, a third, distinctly smaller gap
    // (19°) where the wrap seam should instead have been the *widest* gap
    // (71°, same as the other group boundary).
    const uniqueGapSizes = new Set(gaps.map((g) => Math.round(g * 10) / 10))
    expect(uniqueGapSizes.size).toBeLessThanOrEqual(2)
    for (const gap of gaps) expect(gap).toBeGreaterThan(0)
  })

  it("keeps every option box within the svg's own viewBox for a unit at the board's edge — bug report: \"radial menu option is unreachable\" (the topmost option rendered above the visible board, past where the page could be scrolled to reach it)", () => {
    const onSelect = vi.fn()
    // Ship (6 actions) + Port (2 actions) sharing a hex at (0, 0), the same
    // board-edge tile the acting unit sits on in the bug report — the
    // action menu's own reach used to be excluded from the viewBox's
    // bounding-box calculation, so its topmost option (rendered straight
    // above the unit) could land above `minY`, outside the `<svg>`'s
    // rendered box and thus off the page.
    const options = [
      ...optionsFor('ship1', 'Ship', ['a', 'b', 'c', 'd', 'e', 'f']),
      ...optionsFor('port1', 'Port', ['g', 'h']),
    ]
    const { container } = render(<HexBoard board={makeBoard()} actionMenu={{ coord: { q: 0, r: 0 }, options, onSelect }} />)

    const svg = container.querySelector('svg')!
    const [minX, minY, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number)
    const maxX = minX + width
    const maxY = minY + height

    const boxes = [...container.querySelectorAll('foreignObject')]
    expect(boxes).toHaveLength(8)
    for (const box of boxes) {
      const x = Number(box.getAttribute('x'))
      const y = Number(box.getAttribute('y'))
      const boxWidth = Number(box.getAttribute('width'))
      const boxHeight = Number(box.getAttribute('height'))
      expect(x).toBeGreaterThanOrEqual(minX)
      expect(y).toBeGreaterThanOrEqual(minY)
      expect(x + boxWidth).toBeLessThanOrEqual(maxX)
      expect(y + boxHeight).toBeLessThanOrEqual(maxY)
    }
  })
})

describe('HexBoard — history-review labels', () => {
  it("staggers two nearby units' history labels instead of overlapping — the reported bug (adjacent units' production amounts overlapped)", () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'nomad', historyDelta: { wood: 1 } },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', kind: 'nomad', historyDelta: { stone: 1 } },
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
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'nomad', historyDelta: { wood: 1 } },
      { coord: { q: 20, r: 0 }, color: '#3b82f6', kind: 'nomad', historyDelta: { stone: 1 } },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    const labels = [...container.querySelectorAll('foreignObject')]
    expect(labels).toHaveLength(2)
    // Both at their normal, unstaggered slot (same y).
    expect(labels[0].getAttribute('y')).toBe(labels[1].getAttribute('y'))
  })

  it('renders one icon+amount badge per affected resource instead of text', () => {
    const units: UnitMarker[] = [{ coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'nomad', historyDelta: { wood: 1, gold: -5 } }]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    const label = container.querySelector('foreignObject')!
    const icons = label.querySelectorAll('svg')
    expect(icons).toHaveLength(2)
    expect(label.textContent).toContain('+1')
    expect(label.textContent).toContain('-5')
  })

  it('renders no label element for a unit with no historyDelta', () => {
    const units: UnitMarker[] = [{ coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'nomad' }]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)
    expect(container.querySelectorAll('foreignObject')).toHaveLength(0)
  })
})

describe('HexBoard — territory control overlay', () => {
  it('renders no border lines when territoryControl is omitted', () => {
    const { container } = render(<HexBoard board={makeBoard()} />)
    expect(container.querySelectorAll('line[stroke="#22c55e"]')).toHaveLength(0)
  })

  it('draws a border on every side of a single controlled hex (all 6 sides are outward-facing)', () => {
    const { container } = render(
      <HexBoard board={makeBoard()} territoryControl={[{ coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 }]} />,
    )
    expect(container.querySelectorAll('line[stroke="#22c55e"]')).toHaveLength(6)
  })

  it("doesn't draw a border between two of the same player's own adjacent controlled hexes of the same terrain — territory-based, not hex-based", () => {
    const territoryControl = [
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 },
      { coord: { q: 1, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 },
    ]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    // Each hex has 6 sides; the one side where they touch each other is
    // interior to the shared territory and gets no border on either side —
    // 5 outward-facing sides per hex, 10 total, not the naive 12.
    expect(container.querySelectorAll('line[stroke="#22c55e"]')).toHaveLength(10)
  })

  it('draws a border on both sides of an edge shared by two different owners', () => {
    const territoryControl = [
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', terrain: 'plain', points: 1 },
    ]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    // Both owners get a full 6-sided outline — the shared edge is
    // outward-facing for each of them since the neighbor's a different owner.
    expect(container.querySelectorAll('line[stroke="#22c55e"]')).toHaveLength(6)
    expect(container.querySelectorAll('line[stroke="#3b82f6"]')).toHaveLength(6)
  })

  it('draws a border between two adjacent hexes of different terrain even when the same player controls both', () => {
    const territoryControl = [
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'forest', points: 3 },
      { coord: { q: 1, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 },
    ]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    // Unlike the same-terrain case above, the shared edge is still
    // outward-facing for both hexes since they belong to different
    // territories — a full 6 sides per hex, 12 total.
    expect(container.querySelectorAll('line[stroke="#22c55e"]')).toHaveLength(12)
  })

  it('renders a wider border for a higher-point territory', () => {
    const lowPoint = render(
      <HexBoard board={makeBoard()} territoryControl={[{ coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 }]} />,
    )
    const highPoint = render(
      <HexBoard board={makeBoard()} territoryControl={[{ coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'mountain', points: 4 }]} />,
    )

    const lowWidth = Number(lowPoint.container.querySelector('line[stroke="#22c55e"]')!.getAttribute('stroke-width'))
    const highWidth = Number(highPoint.container.querySelector('line[stroke="#22c55e"]')!.getAttribute('stroke-width'))
    expect(highWidth).toBeGreaterThan(lowWidth)
  })

  /** Every rendered `<line stroke={color}>`'s midpoint x — order-independent, unlike relying on which `<line>` a querySelector happens to match first. */
  function borderMidXs(container: HTMLElement, color: string): number[] {
    return [...container.querySelectorAll(`line[stroke="${color}"]`)].map(
      (line) => (Number(line.getAttribute('x1')) + Number(line.getAttribute('x2'))) / 2,
    )
  }

  it("draws a border facing an uncontrolled hex directly on the shared edge, not nudged into the controlled hex's own interior", () => {
    // A lone controlled hex with no competing territory on any side — every
    // border segment should sit on the actual hex-to-hex boundary (matching
    // where a cliff edge/structure connector would render) rather than
    // being pulled toward this hex's own center, so a contiguous territory's
    // outline stays continuous across hex-to-hex corners instead of
    // fragmenting (or, with thicker borders, overlapping) at each one.
    const { container } = render(
      <HexBoard board={makeBoard()} territoryControl={[{ coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 }]} />,
    )
    // The hex at (0,0) is centered at x=0 with radius 21 (size 22 - 1); its
    // rightmost side's true (un-nudged) boundary sits near x=19. Nudging it
    // toward the hex's own center would have pulled it noticeably short of
    // that.
    const rightmostX = Math.max(...borderMidXs(container, '#22c55e'))
    expect(rightmostX).toBeGreaterThan(17)
  })

  it('draws a border facing a competing territory nudged off the shared edge, into each side', () => {
    const territoryControl = [
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', terrain: 'plain', points: 1 },
    ]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    // Both hexes are centered on the x axis (q=0 and q=1); their shared
    // edge's true (un-nudged) boundary sits at x≈19.05. The segment each
    // side draws along that shared edge is the one whose midpoint x is
    // closest to that boundary — green's should land left of it (nudged
    // toward its own hex, at x=0) and blue's right of it (nudged toward its
    // own hex, at x≈38.1), keeping the two territories' outlines visibly
    // separate instead of overlapping on the same line.
    const sharedBoundaryX = 19.05
    const closestTo = (xs: number[]) => xs.reduce((best, x) => (Math.abs(x - sharedBoundaryX) < Math.abs(best - sharedBoundaryX) ? x : best))
    const greenSharedX = closestTo(borderMidXs(container, '#22c55e'))
    const blueSharedX = closestTo(borderMidXs(container, '#3b82f6'))
    expect(greenSharedX).toBeLessThan(sharedBoundaryX)
    expect(blueSharedX).toBeGreaterThan(sharedBoundaryX)
  })
})
