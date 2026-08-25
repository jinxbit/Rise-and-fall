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

/** Plain(level 1) next to Mountain(level 3) — a >1 level gap, so `isCliffEdge` marks the shared side a cliff (see ../../engine/cliffs.ts). */
function makeCliffBoard() {
  let board = createEmptyBoard('hex')
  board = setTile(board, { q: 0, r: 0 }, 'plain')
  board = setTile(board, { q: 1, r: 0 }, 'mountain')
  return board
}

/** `<line>`s drawn with no `strokeOpacity` prop set — cliff-edge lines, unlike the halo lines under a territory border (which always set one), so this tells them apart even though both use the same black stroke colour. */
function cliffLines(container: HTMLElement) {
  return [...container.querySelectorAll('line[stroke="#000000"]')].filter((line) => line.getAttribute('stroke-opacity') === null)
}

const NEUTRAL_PLATE_COLOR = '#f2f2ef'
const HAND_PLATE_COLOR = '#ffffff'
const SELECTED_PLATE_COLOR = '#fde68a'
const DISCARD_PLATE_COLOR = '#e5e7eb'

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

  it('fills the plate white for a unit whose card is in hand, and the usual neutral colour otherwise (issue #305/#311)', () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city', cardState: 'hand' },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', kind: 'nomad' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    // The in-hand city's plate (a <rect>) is white; the plain nomad's
    // plate (a <circle>) stays the fixed neutral colour. Scoped to
    // stroke="#000" (every unit plate's outline) so the white hand colour
    // doesn't also match the unrelated white rect inside the SVG's neutral-
    // stripe <pattern> def, which has no stroke.
    expect(container.querySelectorAll(`rect[stroke="#000"][fill="${HAND_PLATE_COLOR}"]`)).toHaveLength(1)
    expect(container.querySelectorAll(`circle[fill="${NEUTRAL_PLATE_COLOR}"]`)).toHaveLength(1)
  })

  it('fills the plate light gold for the card chosen to play this round, distinct from the white in-hand plate (issue #311 follow-up)', () => {
    const units: UnitMarker[] = [{ coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city', cardState: 'selected' }]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    expect(container.querySelectorAll(`rect[fill="${SELECTED_PLATE_COLOR}"]`)).toHaveLength(1)
    expect(container.querySelectorAll(`rect[stroke="#000"][fill="${HAND_PLATE_COLOR}"]`)).toHaveLength(0)
  })

  it('fills the plate light grey for a unit whose card is in discard (issue #311 follow-up)', () => {
    const units: UnitMarker[] = [{ coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city', cardState: 'discard' }]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    expect(container.querySelectorAll(`rect[fill="${DISCARD_PLATE_COLOR}"]`)).toHaveLength(1)
  })

  it('uses the colours from `unitPlateColors` instead of the defaults when supplied (profile customization, issue #311 follow-up)', () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city', cardState: 'hand' },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', kind: 'nomad', cardState: 'selected' },
      { coord: { q: 2, r: 0 }, color: '#22c55e', kind: 'ship', cardState: 'discard' },
    ]
    const customColors = { hand: '#111111', selected: '#222222', discard: '#333333' }
    const { container } = render(<HexBoard board={makeBoard()} units={units} unitPlateColors={customColors} />)

    expect(container.querySelectorAll(`rect[fill="${customColors.hand}"]`)).toHaveLength(1)
    expect(container.querySelectorAll(`circle[fill="${customColors.selected}"]`)).toHaveLength(1)
    expect(container.querySelectorAll(`circle[fill="${customColors.discard}"]`)).toHaveLength(1)
    // None of the default colours leak through once every state is
    // overridden. Scoped to stroke="#000" (every unit plate's outline) so
    // the white hand default doesn't also match the SVG's unrelated white
    // neutral-stripe <pattern> def rect, which has no stroke.
    expect(container.querySelectorAll(`rect[stroke="#000"][fill="${HAND_PLATE_COLOR}"], circle[stroke="#000"][fill="${HAND_PLATE_COLOR}"]`)).toHaveLength(0)
    expect(container.querySelectorAll(`[fill="${SELECTED_PLATE_COLOR}"]`)).toHaveLength(0)
  })

  it("greys out a declined unit's glyph instead of the usual near-black fill (issue #305)", () => {
    const units: UnitMarker[] = [
      { coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city', declined: true },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', kind: 'nomad' },
    ]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    expect(container.querySelectorAll('[fill="#9ca3af"]').length).toBeGreaterThan(0)
    // The plain nomad's glyph shapes still use the fixed ink colour, unaffected.
    expect(container.querySelectorAll('[fill="#14161a"]').length).toBeGreaterThan(0)
  })

  it('shows no gold plate and no grey fill for a unit whose card is in discard (or otherwise neither in hand nor declined)', () => {
    const units: UnitMarker[] = [{ coord: { q: 0, r: 0 }, color: '#ef4444', kind: 'city' }]
    const { container } = render(<HexBoard board={makeBoard()} units={units} />)

    // Scoped to stroke="#000" (every unit plate's outline) so the white
    // hand default doesn't also match the SVG's unrelated white
    // neutral-stripe <pattern> def rect, which has no stroke.
    expect(container.querySelectorAll(`rect[stroke="#000"][fill="${HAND_PLATE_COLOR}"], circle[stroke="#000"][fill="${HAND_PLATE_COLOR}"]`)).toHaveLength(0)
    expect(container.querySelectorAll('[fill="#9ca3af"]')).toHaveLength(0)
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

  it("keeps the outline continuous where it crosses from one member hex to the next — bug report: \"line is broken when it crossed to a new hex\"", () => {
    const territoryControl = [
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 },
      { coord: { q: 1, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 },
    ]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    // A closed, connected outline is a set of segments where every endpoint
    // is shared by exactly two segments (the one ending there and the one
    // starting there) — a broken outline instead leaves some endpoints
    // touched by only one segment (a dangling end where the crossing failed
    // to line up).
    const lines = [...container.querySelectorAll('line[stroke="#22c55e"]')]
    const endpointCounts = new Map<string, number>()
    for (const line of lines) {
      for (const [xAttr, yAttr] of [
        ['x1', 'y1'],
        ['x2', 'y2'],
      ] as const) {
        const key = `${Number(line.getAttribute(xAttr)).toFixed(2)},${Number(line.getAttribute(yAttr)).toFixed(2)}`
        endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1)
      }
    }
    expect(endpointCounts.size).toBe(lines.length) // 10 segments, 10 distinct shared vertices
    for (const count of endpointCounts.values()) expect(count).toBe(2)
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

  it("renders a thicker border for the higher-point of two territories on the same board — 'points' is a whole territory's total value, scaled relative to every territory actually on this board, not an absolute point count", () => {
    const territoryControl = [
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 },
      { coord: { q: 3, r: 0 }, color: '#3b82f6', terrain: 'mountain', points: 12 },
    ]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    const lowWidth = Number(container.querySelector('line[stroke="#22c55e"]')!.getAttribute('stroke-width'))
    const highWidth = Number(container.querySelector('line[stroke="#3b82f6"]')!.getAttribute('stroke-width'))
    expect(highWidth).toBeGreaterThan(lowWidth)
  })

  it('renders the same width for two territories worth the same total despite different terrain — bug report: "two territories, one mountain and one water, worth the same but have different width"', () => {
    const territoryControl = [
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'mountain', points: 8 }, // e.g. 2 hexes at 4 VP each
      { coord: { q: 3, r: 0 }, color: '#3b82f6', terrain: 'water', points: 8 }, // e.g. 4 hexes at 2 VP each
    ]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    const mountainWidth = Number(container.querySelector('line[stroke="#22c55e"]')!.getAttribute('stroke-width'))
    const waterWidth = Number(container.querySelector('line[stroke="#3b82f6"]')!.getAttribute('stroke-width'))
    expect(mountainWidth).toBeCloseTo(waterWidth)
  })

  it('renders two same-terrain territories of different size at different widths — bug report: "two mountain territories with very different score value being the same width"', () => {
    const territoryControl = [
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'mountain', points: 4 }, // 1 hex
      { coord: { q: 3, r: 0 }, color: '#3b82f6', terrain: 'mountain', points: 16 }, // 4 hexes
    ]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    const smallWidth = Number(container.querySelector('line[stroke="#22c55e"]')!.getAttribute('stroke-width'))
    const bigWidth = Number(container.querySelector('line[stroke="#3b82f6"]')!.getAttribute('stroke-width'))
    expect(bigWidth).toBeGreaterThan(smallWidth)
  })

  it('falls back to a fixed mid-range width when every territory on the board is worth the same — no real range to position within', () => {
    const territoryControl = [{ coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 }]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    const width = Number(container.querySelector('line[stroke="#22c55e"]')!.getAttribute('stroke-width'))
    const size = 22 // HexBoard's default `size` prop
    expect(width).toBeCloseTo(size * ((0.05 + 0.2) / 2))
  })

  it('scales width against territoryValueRange instead of the passed territoryControl entries, when supplied', () => {
    // A single territory worth 4 points — on its own it'd fall back to the
    // fixed mid-range width (no real range within just this one entry), but
    // territoryValueRange says 4 is actually the low end of a 4..16 range
    // (e.g. the review screen's "changes" mode scaling against every
    // territory on the board, not just the one that happened to change).
    const territoryControl = [{ coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'mountain', points: 4 }]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} territoryValueRange={{ min: 4, max: 16 }} />)

    const width = Number(container.querySelector('line[stroke="#22c55e"]')!.getAttribute('stroke-width'))
    const size = 22 // HexBoard's default `size` prop
    expect(width).toBeCloseTo(size * 0.05) // at the low end of the supplied range, not the fixed mid-range fallback
  })

  it('renders a striped territory entry as black-and-white diagonal stripes instead of its own colour', () => {
    const territoryControl = [{ coord: { q: 0, r: 0 }, color: '#ffffff', terrain: 'plain', points: 1, striped: true }]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    // Never rendered with a flat colour — including its own `color` — once striped.
    expect(container.querySelectorAll('line[stroke="#ffffff"]')).toHaveLength(0)

    const line = container.querySelector('line[data-striped="true"]')
    expect(line).not.toBeNull()
    const strokeUrl = line!.getAttribute('stroke') ?? ''
    expect(strokeUrl).toMatch(/^url\(#.+\)$/)
    const patternId = strokeUrl.slice('url(#'.length, -1)
    const pattern = container.querySelector(`pattern#${CSS.escape(patternId)}`)
    const fills = [...(pattern?.querySelectorAll('rect') ?? [])].map((r) => r.getAttribute('fill'))
    expect(fills).toEqual(expect.arrayContaining(['#000000', '#ffffff']))
  })

  /** Every rendered `<line stroke={color}>`'s midpoint x — order-independent, unlike relying on which `<line>` a querySelector happens to match first. */
  function borderMidXs(container: HTMLElement, color: string): number[] {
    return [...container.querySelectorAll(`line[stroke="${color}"]`)].map(
      (line) => (Number(line.getAttribute('x1')) + Number(line.getAttribute('x2'))) / 2,
    )
  }

  it('draws a border facing an uncontrolled hex inset toward the controlled hex\'s own center, not sitting on the shared boundary', () => {
    // A lone controlled hex with no competing territory on any side — its
    // border should still be pulled in from the true hex-to-hex boundary
    // (matching where a cliff edge/structure connector would render) by
    // its own halo half-width, the same as every other side, so a whole
    // outline reads at one consistent inset regardless of what's on the
    // other side of each edge.
    const { container } = render(
      <HexBoard board={makeBoard()} territoryControl={[{ coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 }]} />,
    )
    // The hex at (0,0) is centered at x=0 with radius 21 (size 22 - 1); its
    // rightmost side's true (un-inset) boundary sits near x=19.
    const rightmostX = Math.max(...borderMidXs(container, '#22c55e'))
    expect(rightmostX).toBeLessThan(19)
    expect(rightmostX).toBeGreaterThan(10)
  })

  it('draws a competing edge as two fully separate, non-overlapping segments — one per owner, each inset into its own hex, never crossing the shared boundary', () => {
    const territoryControl = [
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', terrain: 'plain', points: 1 },
    ]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    // The two hexes are centered at x=0 (q=0) and x≈38.1 (q=1); their
    // shared true boundary sits at x≈19.05. Green's segment along that side
    // should be inset toward its own center (x=0), i.e. strictly left of
    // the boundary; blue's should be inset toward its own center (x≈38.1),
    // i.e. strictly right of it — so neither crosses into the other's hex.
    const sharedBoundaryX = 19.05
    const greenSharedX = Math.max(...borderMidXs(container, '#22c55e'))
    const blueSharedX = Math.min(...borderMidXs(container, '#3b82f6'))
    expect(greenSharedX).toBeLessThan(sharedBoundaryX)
    expect(blueSharedX).toBeGreaterThan(sharedBoundaryX)
  })

  it('renders each side of a competing edge symmetrically inset by its own width, even when the two territories\' widths differ a lot', () => {
    const territoryControl = [
      // A big point gap maximizes the width difference between the two
      // territories, so an inset that scaled the wrong way (or not at all)
      // would be large enough to fail this test outright rather than being
      // lost in rounding.
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 12 },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', terrain: 'plain', points: 1 },
    ]
    const { container } = render(<HexBoard board={makeBoard()} territoryControl={territoryControl} />)

    const greenLines = [...container.querySelectorAll('line[stroke="#22c55e"]')]
    const blueLines = [...container.querySelectorAll('line[stroke="#3b82f6"]')]
    expect(greenLines).toHaveLength(6)
    expect(blueLines).toHaveLength(6)

    const sharedBoundaryX = 19.05
    const greenSharedX = Math.max(...borderMidXs(container, '#22c55e'))
    const blueSharedX = Math.min(...borderMidXs(container, '#3b82f6'))
    // The wider (higher-point) green territory is inset further from the
    // boundary than the narrower blue one, but both stay strictly on their
    // own side of it — no overlap regardless of the width gap.
    expect(sharedBoundaryX - greenSharedX).toBeGreaterThan(blueSharedX - sharedBoundaryX)
    expect(greenSharedX).toBeLessThan(sharedBoundaryX)
    expect(blueSharedX).toBeGreaterThan(sharedBoundaryX)
  })

  it('draws cliff-edge lines when territoryControl is omitted', () => {
    const { container } = render(<HexBoard board={makeCliffBoard()} />)
    expect(cliffLines(container).length).toBeGreaterThan(0)
  })

  it("suppresses cliff-edge lines once territoryControl is supplied — cliffs aren't meaningful on the victory screen, and a border nudged off the true hex edge (facing a competing territory) could otherwise leave a cliff's own un-nudged line sitting visibly next to it", () => {
    const territoryControl = [
      { coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 },
      { coord: { q: 1, r: 0 }, color: '#3b82f6', terrain: 'mountain', points: 4 },
    ]
    const { container } = render(<HexBoard board={makeCliffBoard()} territoryControl={territoryControl} />)
    expect(cliffLines(container)).toHaveLength(0)
  })

  it('suppresses cliff-edge lines for an empty territoryControl array too — the prop being supplied at all signals victory-screen mode', () => {
    const { container } = render(<HexBoard board={makeCliffBoard()} territoryControl={[]} />)
    expect(cliffLines(container)).toHaveLength(0)
  })

  /** A rendered `<line>`'s two endpoints collapse to the same point — with `strokeLinecap="round"`, that paints as a dot instead of a segment. */
  function degenerateLineCount(lines: Element[]): number {
    return lines.filter((line) => {
      const x1 = Number(line.getAttribute('x1'))
      const y1 = Number(line.getAttribute('y1'))
      const x2 = Number(line.getAttribute('x2'))
      const y2 = Number(line.getAttribute('y2'))
      return Math.hypot(x2 - x1, y2 - y1) < 0.01
    }).length
  }

  it(
    'draws a full 6-sided outline (no degenerate zero-length segments) for a lone controlled hex centered on the board\'s x=0 symmetry axis — ' +
      'bug report: "only circles are drawn on most of the hexes." The hex-vertex angles this hex\'s own opposite sides compute round to +0/-0 ' +
      'in floating point, which used to produce two different map keys for what should be the same shared vertex (see vertexKey), silently ' +
      'breaking the outline into disconnected fragments that included zero-length segments (round line caps render those as dots, not lines).',
    () => {
      let board = createEmptyBoard('hex')
      board = setTile(board, { q: 0, r: 0 }, 'plain')
      const { container } = render(
        <HexBoard board={board} territoryControl={[{ coord: { q: 0, r: 0 }, color: '#22c55e', terrain: 'plain', points: 1 }]} />,
      )
      const lines = [...container.querySelectorAll('line[stroke="#22c55e"]')]
      expect(lines).toHaveLength(6)
      expect(degenerateLineCount(lines)).toBe(0)
    },
  )

  it(
    'draws a continuous, degenerate-segment-free outline across a realistic multi-hex, multi-owner, multi-terrain board — ' +
      'a broader regression net for the same "only circles" class of bug, including the case where a territory\'s "true" boundary vertex ' +
      '(before insetting) was computed at the drawn hex polygon\'s own shrunk radius (size - 1) rather than the true circumradius implied by ' +
      "the grid's center-to-center spacing (size), which left two adjacent hexes' independently-computed versions of their shared corner a " +
      'pixel or more apart instead of exactly coincident.',
    () => {
      let board = createEmptyBoard('hex')
      const radius = 3
      const coords: { q: number; r: number }[] = []
      for (let q = -radius; q <= radius; q++) {
        for (let r = -radius; r <= radius; r++) {
          if (Math.abs(q + r) <= radius) coords.push({ q, r })
        }
      }
      const terrainFor = (c: { q: number; r: number }) => (['plain', 'forest', 'mountain'] as const)[((c.q + c.r * 2) % 3 + 3) % 3]
      for (const c of coords) board = setTile(board, c, terrainFor(c))

      const territoryControl = coords.map((c) => {
        const terrain = terrainFor(c)
        const color = (c.q + c.r) % 2 === 0 ? '#22c55e' : '#3b82f6'
        return { coord: c, color, terrain, points: terrain === 'mountain' ? 12 : terrain === 'forest' ? 8 : 3 }
      })

      const { container } = render(<HexBoard board={board} territoryControl={territoryControl} />)
      const territoryLines = [...container.querySelectorAll('line[stroke="#22c55e"], line[stroke="#3b82f6"]')]
      expect(territoryLines.length).toBeGreaterThan(0)
      expect(degenerateLineCount(territoryLines)).toBe(0)
    },
  )
})
