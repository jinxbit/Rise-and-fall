import { useId } from 'react'
import { neighborCoords } from '../engine/board'
import { isCliffEdge } from '../engine/cliffs'
import type { Board, Coordinate, Resources, Terrain } from '../engine/types'
import { coordKey } from '../engine/types'
import { DEFAULT_UNIT_PLATE_COLORS } from '../lib/unitColors'
import type { UnitPlateColors } from '../lib/unitColors'
import { ResourceIcon } from './ResourceIcon'
import { RESOURCE_COLOR_CLASS } from './resourceIcons'
import type { IconShape } from './unitIcons'
import { STATIC_UNIT_KINDS, UNIT_ICONS } from './unitIcons'

const RESOURCE_ORDER: (keyof Resources)[] = ['gold', 'wood', 'stone']
const RESOURCE_LABEL: Record<keyof Resources, string> = { gold: 'Gold', wood: 'Wood', stone: 'Stone' }

/** "Short 2 Stone, 1 Gold" — the supportable option's bottom-of-box explainer text (see ActionMenuOption.shortfall). */
function formatShortfall(shortfall: Partial<Resources>): string {
  const parts = RESOURCE_ORDER.filter((key) => shortfall[key]).map((key) => `${shortfall[key]} ${RESOURCE_LABEL[key]}`)
  return `Short ${parts.join(', ')}`
}

// Pointy-top axial hex rendering. Matches the axial convention used
// throughout src/engine (HEX_DIRECTIONS in ../engine/board.ts, the shape
// math in ../engine/boardGeneration.ts): x grows with q and half of r, y
// grows with r.

const TERRAIN_COLOR: Record<Terrain, string> = {
  water: '#075985',
  plain: '#65a30d',
  forest: '#065f46',
  mountain: '#71717a',
  glacier: '#a5f3fc',
}

/**
 * Mirrors content/terrain.json's `level` field (elevation) — duplicated
 * here rather than threaded in as a prop since it's only ever used for
 * this one rendering decision (which hexsides to draw as cliffs), the
 * same "just enough for drawing" role TERRAIN_COLOR above already plays.
 */
const TERRAIN_LEVEL: Record<Terrain, number> = {
  water: 0,
  plain: 1,
  forest: 2,
  mountain: 3,
  glacier: 4,
}

/**
 * Half of the 6 axial neighbor directions (see HEX_DIRECTIONS in
 * ../engine/board.ts) — enough to visit every undirected hex-to-hex edge
 * exactly once while iterating every tile, since each of the other 3
 * directions is some neighboring tile's mirror of one of these.
 */
const CLIFF_CHECK_DIRECTIONS: Coordinate[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
]

/** The thinnest a territory border ever gets — the lowest-scoring territory actually on the board, not an absolute point count (see territoryBorderWidth below). */
const TERRITORY_BORDER_MIN_WIDTH_FACTOR = 0.05
/** The thickest a territory border ever gets — the highest-scoring territory actually on the board. */
const TERRITORY_BORDER_MAX_WIDTH_FACTOR = 0.2
/** The dark halo drawn under the border's own colour (see territoryBorderSegments below) is always this many times wider, same ratio as before this became variable. */
const TERRITORY_BORDER_HALO_WIDTH_MULTIPLIER = 2

/**
 * A territory's outline stroke width, in pixels — scaled by where this
 * territory's total point value (`points` on the `territoryControl` prop,
 * i.e. hex count × terrain VP rate, not just the flat per-hex rate) falls
 * between the lowest- and highest-scoring territory actually present on this
 * board, so e.g. two same-terrain territories of different size render at
 * different widths, and two different-terrain territories worth the same
 * total render at the same width. `minPoints`/`maxPoints` normally come from
 * scanning every entry in `territoryControl` once (see HexBoard below), or
 * from the `territoryValueRange` prop when the caller supplies one (see its
 * own doc comment) — an absolute per-point scale doesn't work since one
 * board's highest-value territory might be another board's lowest. A board
 * (or, with `territoryValueRange`, a caller-supplied range) where every
 * territory happens to
 * score the same (including just one territory total) has no real range to
 * position within, so it falls back to the middle of the width range rather
 * than arbitrarily picking the thinnest or thickest end.
 */
function territoryBorderWidth(size: number, points: number, minPoints: number, maxPoints: number): number {
  const t = maxPoints > minPoints ? (points - minPoints) / (maxPoints - minPoints) : 0.5
  const factor = TERRITORY_BORDER_MIN_WIDTH_FACTOR + t * (TERRITORY_BORDER_MAX_WIDTH_FACTOR - TERRITORY_BORDER_MIN_WIDTH_FACTOR)
  return size * factor
}

const SQRT3 = Math.sqrt(3)

function axialToPixel(coord: Coordinate, size: number): { x: number; y: number } {
  return {
    x: size * (SQRT3 * coord.q + (SQRT3 / 2) * coord.r),
    y: size * 1.5 * coord.r,
  }
}

function hexPoints(cx: number, cy: number, size: number): string {
  const points: string[] = []
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90)
    points.push(`${cx + size * Math.cos(angle)},${cy + size * Math.sin(angle)}`)
  }
  return points.join(' ')
}

/** The line segment where two adjacent hexes' polygons touch — perpendicular to the line between their centers, centered on its midpoint, as long as one hex's edge (regular-hexagon side length equals its circumradius). */
function hexEdgeSegment(ax: number, ay: number, bx: number, by: number, radius: number): { x1: number; y1: number; x2: number; y2: number } {
  const dx = bx - ax
  const dy = by - ay
  const dist = Math.hypot(dx, dy) || 1
  const px = -dy / dist
  const py = dx / dist
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const half = radius / 2
  return { x1: mx - px * half, y1: my - py * half, x2: mx + px * half, y2: my + py * half }
}

/**
 * A territory border segment for hex (cx,cy)'s side facing neighbor
 * (nx,ny) — this hex's own true edge (same two vertices `hexPoints` would
 * place there, `radius` = size - 1), pulled inward toward this hex's own
 * center by `insetDist` rather than sitting on the shared boundary. Used so
 * two territories meeting at one physical edge each draw a fully separate,
 * self-contained line on their own side of it instead of both centering a
 * stroke on the same shared line — the earlier approach, which let a wide
 * stroke bleed across the boundary into the neighbor and visually blend
 * with (or get outweighted by) whatever the neighbor drew there too,
 * whether that was a different color or the same color at a different
 * width (bug report: "the colors coexist... should face inward and never
 * overlap").
 *
 * A regular hexagon's edge, pulled inward by a constant perpendicular
 * distance, is exactly that hexagon scaled toward its own center — so the
 * inset edge's two endpoints sit at the same angles from center as this
 * hex's own true vertices for that side (±30° from the direction to the
 * neighbor), just at a smaller radius. Two adjacent sides of the same hex
 * computed this way always share their common corner exactly (same center,
 * same inset radius, same shared angle) — no separate corner-mitering step
 * is needed, unlike the per-edge-translation approach an earlier version of
 * this tried (which left adjacent sides' translated endpoints mismatched).
 */
function territoryInsetEdge(cx: number, cy: number, nx: number, ny: number, radius: number, insetDist: number): { x1: number; y1: number; x2: number; y2: number } {
  const theta = Math.atan2(ny - cy, nx - cx)
  const apothemPerUnitRadius = SQRT3 / 2
  const insetRadius = Math.max(0, radius - insetDist / apothemPerUnitRadius)
  const a1 = theta - Math.PI / 6
  const a2 = theta + Math.PI / 6
  return {
    x1: cx + insetRadius * Math.cos(a1),
    y1: cy + insetRadius * Math.sin(a1),
    x2: cx + insetRadius * Math.cos(a2),
    y2: cy + insetRadius * Math.sin(a2),
  }
}

/** One outward-facing side of a territory's boundary, in true (un-inset) board coordinates — `v1`/`v2` are its two endpoints (see territoryInsetEdge, called with `insetDist: 0` to get them), `hexX`/`hexY` the center of whichever member hex this particular side belongs to (used to pick the inward direction when insetting, see edgeInwardNormal below). */
interface TerritoryBoundaryEdge {
  v1: { x: number; y: number }
  v2: { x: number; y: number }
  hexX: number
  hexY: number
}

/** Rounds a coordinate to a fixed precision, normalizing -0 to 0 — `(-1e-15).toFixed(3)` is the string `'-0.000'`, distinct from `(1e-15).toFixed(3)`'s `'0.000'`, so without this two edges computing the same true vertex as tiny opposite-signed floating-point noise around zero would produce different map keys (see vertexKey below). */
function roundCoord(n: number): number {
  const rounded = Math.round(n * 1000) / 1000
  return rounded === 0 ? 0 : rounded
}

/** Rounds a point to a fixed precision for use as a map key — two boundary edges computed independently from different (adjacent) hexes' own centers still land on the exact same true grid vertex, just with floating-point noise many orders of magnitude finer than this. */
function vertexKey(x: number, y: number): string {
  return `${roundCoord(x)},${roundCoord(y)}`
}

/** Where infinite line p1-p2 crosses infinite line p3-p4, or null if they're parallel (or nearly enough that the intersection would shoot off to an unreasonable distance). */
function lineIntersection(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
): { x: number; y: number } | null {
  const denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x)
  if (Math.abs(denom) < 1e-9) return null
  const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denom
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) }
}

/** Groups territory-controlled hexes into one array per contiguous same-owner-same-terrain region — the unit a single connected outline needs to trace over (see territoryBoundaryLoops below), matching the same "same colour and terrain" test the per-side border check already used. */
function groupTerritoryHexes<T extends { coord: Coordinate; color: string; terrain: string }>(board: Board, territoryByKey: Map<string, T>): T[][] {
  const visited = new Set<string>()
  const groups: T[][] = []
  for (const [key, territory] of territoryByKey) {
    if (visited.has(key)) continue
    visited.add(key)
    const group: T[] = []
    const queue = [territory]
    while (queue.length > 0) {
      const current = queue.pop()!
      group.push(current)
      for (const neighborCoord of neighborCoords(board, current.coord)) {
        const neighborKey = coordKey(neighborCoord)
        if (visited.has(neighborKey)) continue
        const neighborTerritory = territoryByKey.get(neighborKey)
        if (!neighborTerritory || neighborTerritory.color !== territory.color || neighborTerritory.terrain !== territory.terrain) continue
        visited.add(neighborKey)
        queue.push(neighborTerritory)
      }
    }
    groups.push(group)
  }
  return groups
}

/**
 * Every outward-facing side of one territory region, knitted into one or
 * more closed loops (normally one — a hole in a region, e.g. a player's
 * territory fully surrounding an enemy hex, would trace as a second, inner
 * loop). Each hex contributes its own outward sides as independent edges
 * (same true endpoints two adjacent hexes' sides always agree on, since
 * they're both reading off the same real hex-grid vertex); chaining them by
 * shared endpoint is what turns a whole multi-hex region into one connected
 * boundary instead of the disconnected per-hex sides `territoryInsetEdge`
 * alone produces.
 */
function territoryBoundaryLoops(
  board: Board,
  group: { coord: Coordinate; color: string; terrain: string }[],
  territoryByKey: Map<string, { coord: Coordinate; color: string; terrain: string }>,
  size: number,
): TerritoryBoundaryEdge[][] {
  const edges: TerritoryBoundaryEdge[] = []
  for (const territory of group) {
    const { x, y } = axialToPixel(territory.coord, size)
    for (const neighborCoord of neighborCoords(board, territory.coord)) {
      const neighborTerritory = territoryByKey.get(coordKey(neighborCoord))
      if (neighborTerritory && neighborTerritory.color === territory.color && neighborTerritory.terrain === territory.terrain) continue
      const { x: nx, y: ny } = axialToPixel(neighborCoord, size)
      // Deliberately `size`, not `size - 1` (the polygon's own drawn radius,
      // shrunk by 1px for a visual gap between hexes — see hexPoints). Two
      // adjacent hexes each compute this same shared grid vertex from their
      // own center independently (see this function's doc comment above),
      // and that only lands on the same point when the radius matches the
      // true circumradius implied by axialToPixel's center-to-center
      // spacing, which is `size`. Using `size - 1` left every such pair a
      // pixel or more apart — nowhere near vertexKey's float-noise rounding
      // tolerance — so the chain below broke apart into short, unclosed
      // fragments almost everywhere a territory spanned more than one hex,
      // and insetLoopVertices then produced degenerate zero-length segments
      // from those fragments, rendering as dots (bug report: "only circles
      // are drawn on most of the hexes").
      const trueEdge = territoryInsetEdge(x, y, nx, ny, size, 0)
      edges.push({ v1: { x: trueEdge.x1, y: trueEdge.y1 }, v2: { x: trueEdge.x2, y: trueEdge.y2 }, hexX: x, hexY: y })
    }
  }

  const byStartKey = new Map(edges.map((e) => [vertexKey(e.v1.x, e.v1.y), e]))
  const visited = new Set<TerritoryBoundaryEdge>()
  const loops: TerritoryBoundaryEdge[][] = []
  for (const start of edges) {
    if (visited.has(start)) continue
    const loop: TerritoryBoundaryEdge[] = []
    let current: TerritoryBoundaryEdge | undefined = start
    while (current && !visited.has(current)) {
      visited.add(current)
      loop.push(current)
      current = byStartKey.get(vertexKey(current.v2.x, current.v2.y))
    }
    loops.push(loop)
  }
  return loops
}

/** How far a mitered corner is allowed to shoot out past its true vertex, as a multiple of the inset distance, before falling back to a plain bevel — guards a very sharp reflex notch in a region's shape from producing a wild spike. */
const TERRITORY_BORDER_MITER_LIMIT = 4

/** The perpendicular unit vector to `edge`, pointing toward whichever hex it belongs to (see TerritoryBoundaryEdge.hexX/hexY) rather than away from it — i.e. "inward." */
function edgeInwardNormal(edge: TerritoryBoundaryEdge): { nx: number; ny: number } {
  const dx = edge.v2.x - edge.v1.x
  const dy = edge.v2.y - edge.v1.y
  const dist = Math.hypot(dx, dy) || 1
  let nx = -dy / dist
  let ny = dx / dist
  const midX = (edge.v1.x + edge.v2.x) / 2
  const midY = (edge.v1.y + edge.v2.y) / 2
  if (nx * (edge.hexX - midX) + ny * (edge.hexY - midY) < 0) {
    nx = -nx
    ny = -ny
  }
  return { nx, ny }
}

/**
 * A closed boundary loop (see territoryBoundaryLoops), pulled inward by
 * `insetDist` as a whole — each vertex becomes the intersection of its two
 * neighboring sides, each independently offset toward its own owning hex
 * (see edgeInwardNormal) — the standard mitered-polygon-offset construction.
 * Unlike insetting each hex's sides independently (which leaves adjacent
 * member hexes' segments pulled toward two different centers, and so not
 * meeting where the outline crosses from one hex to the next — the "broken"
 * line bug this replaces), every vertex here has exactly one inset position,
 * so consecutive segments always share an endpoint.
 */
function insetLoopVertices(loop: TerritoryBoundaryEdge[], insetDist: number): { x: number; y: number }[] {
  const n = loop.length
  return loop.map((edge, i) => {
    const prev = loop[(i - 1 + n) % n]
    const normalPrev = edgeInwardNormal(prev)
    const normalNext = edgeInwardNormal(edge)
    const trueVertex = edge.v1
    const bevel = {
      x: trueVertex.x + ((normalPrev.nx + normalNext.nx) / 2) * insetDist,
      y: trueVertex.y + ((normalPrev.ny + normalNext.ny) / 2) * insetDist,
    }
    const intersection = lineIntersection(
      { x: prev.v1.x + normalPrev.nx * insetDist, y: prev.v1.y + normalPrev.ny * insetDist },
      { x: prev.v2.x + normalPrev.nx * insetDist, y: prev.v2.y + normalPrev.ny * insetDist },
      { x: edge.v1.x + normalNext.nx * insetDist, y: edge.v1.y + normalNext.ny * insetDist },
      { x: edge.v2.x + normalNext.nx * insetDist, y: edge.v2.y + normalNext.ny * insetDist },
    )
    if (!intersection || Math.hypot(intersection.x - trueVertex.x, intersection.y - trueVertex.y) > insetDist * TERRITORY_BORDER_MITER_LIMIT) {
      return bevel
    }
    return intersection
  })
}

/** Pulls both ends of a line segment inward along its own direction — used to keep a history arrow (see HistoryArrow) from starting/ending right under a unit marker's plate. */
function insetSegment(x1: number, y1: number, x2: number, y2: number, startInset: number, endInset: number) {
  const dx = x2 - x1
  const dy = y2 - y1
  const dist = Math.hypot(dx, dy) || 1
  const ux = dx / dist
  const uy = dy / dist
  return { x1: x1 + ux * startInset, y1: y1 + uy * startInset, x2: x2 - ux * endInset, y2: y2 - uy * endInset }
}

/** A small filled triangle pointing along (x1,y1) -> (x2,y2), tip at (x2,y2) — the arrowhead on a history arrow. */
function arrowHeadPoints(x1: number, y1: number, x2: number, y2: number, headLength: number, headWidth: number): string {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const backX = x2 - headLength * Math.cos(angle)
  const backY = y2 - headLength * Math.sin(angle)
  const leftX = backX + headWidth * Math.cos(angle + Math.PI / 2)
  const leftY = backY + headWidth * Math.sin(angle + Math.PI / 2)
  const rightX = backX + headWidth * Math.cos(angle - Math.PI / 2)
  const rightY = backY + headWidth * Math.sin(angle - Math.PI / 2)
  return `${x2},${y2} ${leftX},${leftY} ${rightX},${rightY}`
}

export interface GhostCell {
  coord: Coordinate
  legal: boolean
}

/** A point at `angleDeg` (0 = +x axis, clockwise) around (cx, cy) at radius `r`, in SVG's y-down coordinate space. */
function polarPoint(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const angle = (Math.PI / 180) * angleDeg
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
}

/**
 * Rotate-hint glyph: a ~250° circular arrow centered at (cx, cy), open on
 * one side so it doesn't read as a plain "loading" ring — drawn on the
 * anchor hex during tile placement (see BoardSetupView's TilePlacementPanel)
 * to show both where clicking rotates the pending tile *and* which hex is
 * its anchor (the ruling this glyph exists for, see issue #115: the anchor
 * wasn't visually distinguishable from the rest of the tile's ghost cells
 * before this, just documented in help text below the board).
 */
function RotateHintIcon({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const arcStartDeg = -200
  const arcEndDeg = 40
  const start = polarPoint(cx, cy, r, arcStartDeg)
  const end = polarPoint(cx, cy, r, arcEndDeg)
  const beforeEnd = polarPoint(cx, cy, r, arcEndDeg - 18)
  const headLength = r * 0.65
  const headWidth = r * 0.5
  return (
    <g pointerEvents="none">
      <path d={`M ${start.x} ${start.y} A ${r} ${r} 0 1 1 ${end.x} ${end.y}`} fill="none" stroke="#eab308" strokeWidth={r * 0.28} strokeLinecap="round" />
      <polygon points={arrowHeadPoints(beforeEnd.x, beforeEnd.y, end.x, end.y, headLength, headWidth)} fill="#eab308" />
    </g>
  )
}

/** One event type worth ringing a unit for in history-review mode (see RoundView.tsx's history toggle) — 'moved' is drawn as an arrow instead (see HistoryArrow), not a halo. */
export type HistoryHaloType = 'created' | 'produced' | 'income' | 'converted'

const HISTORY_HALO_COLOR: Record<HistoryHaloType, string> = {
  created: '#22c55e', // green — newly built (created or transformed into)
  produced: '#ef4444', // red — gathered a resource
  income: '#eab308', // gold — generated income (or Ship's Trade)
  converted: '#a855f7', // purple — changed owner or kind via a convert
}

export interface UnitMarker {
  coord: Coordinate
  color: string
  /** Selects both the pictogram (see unitIcons.ts) and the marker shape (rectangle for City/Temple, circle otherwise). */
  kind: string
  /** Draws a bright ring around the unit — e.g. "this unit can still act this turn, click it." */
  highlighted?: boolean
  /**
   * Draws a teal ring around the unit while the player is choosing which
   * idle units will cover a shortfall (see RoundView's 'supporting' UI mode,
   * issue #147) — pulsing when it's an eligible-but-not-yet-chosen
   * candidate, solid once `supportSelected` too.
   */
  supportCandidate?: boolean
  /** Only meaningful alongside `supportCandidate: true` — this candidate is currently picked to help cover the shortfall. */
  supportSelected?: boolean
  /** History-review overlay: one ring per applicable event type since the reviewed window began — concentric if more than one applies to the same unit. */
  historyHalos?: HistoryHaloType[]
  /** History-review overlay: a small tag near the marker for an income/produce/trade amount, rendered as one icon+amount badge per affected resource (see RESOURCE_ICONS) rather than text, e.g. a coin icon next to "+5" instead of "+5 Gold". */
  historyDelta?: Partial<Resources>
  /** Mirrors Unit.connectedNeighborCoords (see ../engine/types) — the two neighboring hexes this structure spans between, e.g. Bridge. Drawn as a marker on those two hex sides so it's visible which sides land units may cross onto/from. */
  connectedNeighborCoords?: [Coordinate, Coordinate]
  /**
   * Which of the 3 customizable card-zone states (see cards.ts's CardZone)
   * this unit's card currently sits in — the plate fills the matching colour
   * from `unitPlateColors` (issue #305/#311/#313) instead of the usual
   * neutral one. `'hand'`: sitting untouched in the owner's hand. `'selected'`:
   * the card the owner has chosen to play this round, still awaiting their
   * turn to resolve. `'discard'`: already played this round (or otherwise
   * sitting in discard). Omitted (supply/decline/no card) renders the usual
   * neutral plate. Mutually exclusive with `declined` — a card is in exactly
   * one zone at a time.
   */
  cardState?: 'hand' | 'selected' | 'discard'
  /** This unit's card currently sits in its owner's decline pile (see cards.ts's CardZone) — the glyph is drawn grey with a thin dark outline instead of the usual near-black fill, so a declined unit still on the board reads as visually distinct (issue #305). */
  declined?: boolean
}

/** A movement event in history-review mode — one hex-to-hex hop, drawn as an arrow. A unit that moved more than once in the reviewed window gets one arrow per hop, in order. */
export interface HistoryArrow {
  from: Coordinate
  to: Coordinate
}

/** The unit glyph's fixed ink colour — always drawn on UNIT_PLATE_COLOR (see UnitGlyph), so contrast is guaranteed regardless of player colour or terrain. */
const UNIT_GLYPH_COLOR = '#14161a'
/** The glyph's fill while its card is in decline (see UnitMarker.declined, issue #305) — grey instead of the usual near-black, with a thin UNIT_GLYPH_COLOR outline standing in for the "thin black border" ask. */
const UNIT_GLYPH_DECLINED_COLOR = '#9ca3af'
/** The marker's fixed backdrop behind the glyph — deliberately NOT the player's colour (see unitIcons.ts's doc comment for why). Ownership shows instead as a small colour bar beneath it. */
const UNIT_PLATE_COLOR = '#f2f2ef'

/** Resolves a unit's plate fill for its `cardState` (see UnitMarker.cardState) against the board's configured `unitPlateColors` — falls back to the fixed neutral plate for `undefined` (supply/decline/no card). */
function plateColorFor(cardState: UnitMarker['cardState'], colors: UnitPlateColors): string {
  if (!cardState) return UNIT_PLATE_COLOR
  return colors[cardState]
}

/** A unit kind's pictogram, centered at (x, y) at `size` pixels square. Grey with a thin outline while `declined` (see UnitMarker.declined), otherwise the fixed ink colour. */
function UnitGlyph({ kind, x, y, size, declined }: { kind: string; x: number; y: number; size: number; declined?: boolean }) {
  const shapes = UNIT_ICONS[kind] ?? []
  const fill = declined ? UNIT_GLYPH_DECLINED_COLOR : UNIT_GLYPH_COLOR
  const stroke = declined ? UNIT_GLYPH_COLOR : undefined
  const strokeWidth = declined ? 0.5 : undefined
  return (
    <svg x={x - size / 2} y={y - size / 2} width={size} height={size} viewBox="0 0 24 24" pointerEvents="none">
      {shapes.map((shape: IconShape, i) => {
        switch (shape.kind) {
          case 'polygon':
            return <polygon key={i} points={shape.points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          case 'rect':
            return <rect key={i} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          case 'path':
            return <path key={i} d={shape.d} fill={fill} fillRule={shape.fillRule} stroke={stroke} strokeWidth={strokeWidth} />
          case 'circle':
            return <circle key={i} cx={shape.cx} cy={shape.cy} r={shape.r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        }
      })}
    </svg>
  )
}

export interface ActionMenuOption {
  /** Which acting unit this option belongs to — see ActionMenu's doc comment on stacked hexes (e.g. a Ship and its own Port sharing one Sea space, The Ports Tale). */
  unitId: string
  /** That unit's kind, e.g. 'ship'/'port' — shown as a small group label whenever the menu covers more than one unit, so a stacked hex's options read as "Ship: Trade" / "Port: Construct a Ship" rather than one ambiguous flat list. */
  unitKind: string
  id: string
  /** Full action name, shown in full in the option's box, bold and uppercased (e.g. "TRADE") — no abbreviation, since a 1-2 letter label made the menu unusable (had to hover to find out what each option was). */
  label: string
  /**
   * The action's full, static rulebook description (content/units.json's
   * `description` — constraints, inputs, possible outcomes) — shown as a
   * native tooltip on the option box regardless of `disabled`, since the
   * box is a plain `<div>` either way (not a real disabled `<button>`,
   * which browsers suppress hover/title on) — the one place a disabled
   * action's full rules stay readable instead of just "you can't do this
   * right now."
   */
  description?: string
  /**
   * A best-effort preview of what picking this action would gain/cost right
   * now (see computeActionOutcomePreview, ../engine/actionTargeting.ts) —
   * rendered as one resource-icon chip per nonzero entry, e.g. a Ship's
   * Trade next to 3 Cities showing a gold-coin icon + "+15". Undefined for
   * actions with nothing previewable yet (e.g. Move, or a target-dependent
   * action with no fixed cost).
   */
  outcome?: Partial<Resources>
  /**
   * True when the unit can't actually perform this action right now (e.g.
   * unaffordable, no legal target) — rendered with a distinct dim-red/
   * slashed-border treatment and no click handler, never with reduced
   * opacity (that reads as "loading"/"disabled-and-still-legible" rather
   * than "you cannot pick this").
   */
  disabled?: boolean
  /**
   * True when the unit can't afford this action right now, but could if
   * some of its idle same-kind teammates produced the shortfall first (see
   * isActionSupportable, ../engine/actionTargeting.ts — issue #147's
   * "supporting actions" QoL request). Rendered as a third, distinct amber
   * treatment, still clickable — picking it walks the player through
   * choosing target then support units instead of resolving immediately.
   * Never true at the same time as `disabled`.
   */
  supportable?: boolean
  /**
   * When `supportable`, how much more of each resource is still short (see
   * computeActionShortfall, ../engine/actionTargeting.ts) — rendered as a
   * terse line at the bottom of the option box (e.g. "Short 2 Stone") so the
   * amber border's meaning is legible without hovering for the tooltip
   * (issue #224). Undefined/omitted whenever `supportable` is false.
   */
  shortfall?: Partial<Resources>
}

/**
 * A ring of clickable action options radiating out from one hex. Normally
 * every option belongs to the single unit that was clicked, but a hex can
 * hold more than one of the current player's acting units at once — e.g. a
 * Ship sharing its Sea space with its own Port (The Ports Tale companion
 * piece) — in which case `options` covers all of them, tagged per-option
 * with `unitId`/`unitKind` (see ActionMenuOption). Callers should keep each
 * unit's options contiguous in the array (not interleaved) — rendering
 * groups by contiguous run of `unitId`, allocating each group its own
 * angular arc (with a small gap between groups) and, only once there's more
 * than one group, a small kind label per option so it's clear which unit
 * each action belongs to. A single-unit menu (the overwhelmingly common
 * case) renders exactly as before this concept existed.
 */
export interface ActionMenu {
  /** The hex the menu radiates out from. */
  coord: Coordinate
  options: ActionMenuOption[]
  onSelect: (unitId: string, optionId: string) => void
}

/** Distance from the unit to each option box's center — grows with option count so boxes wide enough for full action names (e.g. "Transform to Merchant") don't overlap (Merchant has 7 options, the most of any unit kind). */
function actionMenuRadius(size: number, optionCount: number): number {
  return size * (2.6 + Math.max(0, optionCount - 3) * 0.6)
}

/** One contiguous run of same-`unitId` options — see ActionMenu's doc comment. */
interface ActionMenuGroup {
  unitId: string
  unitKind: string
  options: ActionMenuOption[]
}

function groupActionMenuOptions(options: ActionMenuOption[]): ActionMenuGroup[] {
  const groups: ActionMenuGroup[] = []
  for (const option of options) {
    const lastGroup = groups[groups.length - 1]
    if (lastGroup && lastGroup.unitId === option.unitId) {
      lastGroup.options.push(option)
    } else {
      groups.push({ unitId: option.unitId, unitKind: option.unitKind, options: [option] })
    }
  }
  return groups
}

/**
 * Every option's placement angle (radians), walked around the circle
 * group by group. Options within a group are spaced `baseStep` apart —
 * the density a single, ungrouped ring of `totalOptions` options would
 * use *after* setting aside room for every group-to-group gap — so a
 * group's own options stay visually clustered together; only the
 * transition to the *next* group gets extra breathing room
 * (`GROUP_GAP_DEGREES`, on top of one `baseStep`), so different units'
 * options don't run into each other. Giving a multi-option group its own
 * proportional slice of the full 360° instead (an earlier version of this
 * function did) spreads that group's own options nearly as far apart as
 * the gap to the next group, which reads as *more* confusing than no
 * grouping at all — this keeps within-group spacing tight regardless of
 * how many groups there are. With one group (the overwhelmingly common
 * case), this reduces to the plain "evenly spaced around the full circle"
 * formula from before this concept existed.
 *
 * `baseStep` must reserve that room up front: a gap is added after every
 * group, including the last (its own boundary wraps back around to the
 * first group, which needs the same breathing room as any other
 * group-to-group seam) — `groups.length` gaps in total, not
 * `groups.length - 1`. A naive `360 / totalOptions` step, with gaps
 * layered on top of that unreduced spacing, overshoots a full circle by
 * exactly `GROUP_GAP_DEGREES * groups.length` degrees — invisible in the
 * placement of any individual option, but it all lands on the seam where
 * the ring wraps back to the first option, silently compressing (or, with
 * enough groups/gap size, even reversing) what should be that seam's own
 * gap. Bug report: "several elements are overlapping each other" — this
 * was a Ship sharing its hex with its own Port (The Ports Tale), an
 * 8-option, 2-group menu, whose wrap seam ended up 26° *narrower* than
 * every other gap in the ring instead of wider.
 */
const GROUP_GAP_DEGREES = 26

function computeActionMenuAngles(groups: ActionMenuGroup[]): Map<string, number> {
  const angles = new Map<string, number>()
  const totalOptions = groups.reduce((sum, g) => sum + g.options.length, 0)
  if (totalOptions === 0) return angles

  const totalGapDegrees = groups.length > 1 ? groups.length * GROUP_GAP_DEGREES : 0
  const baseStep = (360 - totalGapDegrees) / totalOptions
  let cursorDegrees = -90
  for (const group of groups) {
    group.options.forEach((option, i) => {
      angles.set(option.id, (Math.PI / 180) * (cursorDegrees + baseStep * i))
    })
    cursorDegrees += baseStep * group.options.length + (groups.length > 1 ? GROUP_GAP_DEGREES : 0)
  }
  return angles
}

const ACTION_MENU_BOX_WIDTH_FACTOR = 3.4
const ACTION_MENU_BOX_HEIGHT_FACTOR = 1.7
/** Generous enough for the longest realistic history label — up to 3 icon+amount badges, e.g. gold/wood/stone all changing in the same window. */
const HISTORY_LABEL_WIDTH_FACTOR = 1.9
const HISTORY_LABEL_HEIGHT_FACTOR = 0.46

/** Wide enough for the "Confirm" button at PLACEMENT_CONTROLS's own font size, tall enough for one line of button text. Sized generously (issue #157) so the button is easy to hit, especially on touch. */
const PLACEMENT_CONTROLS_WIDTH_FACTOR = 4.6
const PLACEMENT_CONTROLS_HEIGHT_FACTOR = 2.4
/** Vertical gap between the hex's bottom vertex and the placement controls box, so it doesn't sit flush against the tile it's positioned next to. */
const PLACEMENT_CONTROLS_Y_OFFSET_FACTOR = 1.3

/**
 * The Confirm control for the tile currently being placed (see
 * TilePlacementPanel in BoardSetupView.tsx), anchored to the hex the player
 * clicked rather than living in a static row above the board — on a large or
 * scrolled board that static row could end up far from the tile being
 * placed. Rotating happens by clicking the anchor hex again (see
 * rotateHintCoord) rather than a dedicated button here. The caller only
 * supplies this — and Confirm only ever renders — once the pending
 * placement is legal (issue #121: Confirm must never be shown for an
 * illegal placement, not even disabled); an illegal pending placement shows
 * no controls at all. Positioned the same way ActionMenu is: a
 * `foreignObject` placed via axialToPixel, with its reach folded into the
 * viewBox bounds calculation so it can't render off-screen near the board's
 * edge.
 */
export interface PlacementControls {
  coord: Coordinate
  onConfirm: () => void
}

/**
 * Top-left corner for each unit's history label (see UnitMarker.historyDelta),
 * keyed by that unit's index in `units` — normally centered just above the
 * unit's own hex, but a label is wider than the gap between adjacent hexes,
 * so two nearby labeled units would otherwise draw right on top of each
 * other. Each label greedily claims the first vertical "slot" (stacked
 * downward in `size`-scaled steps) that doesn't overlap a slot an
 * earlier-indexed unit already claimed at a similar x position — a simple,
 * deterministic layout, not a general solver, but enough to pull apart the
 * common case of two or three units near one another.
 */
function computeHistoryLabelPositions(units: UnitMarker[], size: number): Map<number, { x: number; y: number }> {
  const plateSize = size * 0.8
  const labelWidth = size * HISTORY_LABEL_WIDTH_FACTOR
  const labelHeight = size * HISTORY_LABEL_HEIGHT_FACTOR
  const stepY = labelHeight + size * 0.1
  // Gap between the unit plate's top edge and the label's bottom edge, so the
  // label clears the plate/glyph instead of sitting flush against it.
  const plateGap = size * 0.18

  const positions = new Map<number, { x: number; y: number }>()
  const claimed: { x: number; y: number }[] = []

  units.forEach((unit, i) => {
    if (!unit.historyDelta || RESOURCE_ORDER.every((key) => !unit.historyDelta![key])) return
    const { x, y } = axialToPixel(unit.coord, size)
    // Centered horizontally on the unit's own hex rather than offset to one
    // side, so the label reads as belonging to that hex at a glance.
    const baseX = x - labelWidth / 2
    const baseY = y - plateSize / 2 - plateGap - labelHeight

    let level = 0
    while (claimed.some((box) => Math.abs(box.x - baseX) < labelWidth && Math.abs(box.y - (baseY + level * stepY)) < labelHeight)) {
      level++
    }
    const position = { x: baseX, y: baseY + level * stepY }
    claimed.push(position)
    positions.set(i, position)
  })

  return positions
}

/**
 * Per-unit render position/scale, accounting for more than one unit
 * sharing one hex. Bug report: "when merchant stops in city, the city
 * icon is blocked" — both units were drawn at the exact same center, the
 * later one (in `units` array order) fully covering the earlier one's
 * plate and glyph. Two ways this legitimately happens: a mobile unit
 * (e.g. Merchant) landing on an immobile one (City/Temple) it's allowed
 * to end its move on (canEndMoveOnUnitTypes, ./movement.ts), and a Ship
 * docked at its own Port (The Ports Tale companion piece, ./movement.ts's
 * canEndMoveOnAlliedUnitTypes). Handled as the general case: every unit
 * sharing a hex offsets to its own spot around the hex center at a
 * reduced size instead of the hex's exact center, so every one stays
 * fully visible rather than one hiding the rest. A hex with just one
 * unit (the common case) is unaffected — full size, hex center.
 */
function computeUnitStackPositions(units: UnitMarker[], size: number): Map<number, { x: number; y: number; scale: number }> {
  const indicesByHex = new Map<string, number[]>()
  units.forEach((unit, i) => {
    const key = coordKey(unit.coord)
    const list = indicesByHex.get(key) ?? []
    list.push(i)
    indicesByHex.set(key, list)
  })

  const positions = new Map<number, { x: number; y: number; scale: number }>()
  for (const indices of indicesByHex.values()) {
    const { x: cx, y: cy } = axialToPixel(units[indices[0]].coord, size)
    if (indices.length === 1) {
      positions.set(indices[0], { x: cx, y: cy, scale: 1 })
      continue
    }
    // More than 2 on one hex isn't reachable under current movement rules
    // (canEndMoveOnUnitTypes only ever allows one mobile kind to land on
    // one static kind) but degrades gracefully here — spread evenly
    // around the hex center rather than assuming exactly 2.
    const scale = 0.62
    const offset = size * 0.34
    indices.forEach((unitIndex, stackI) => {
      const angle = (Math.PI / 180) * ((360 / indices.length) * stackI - 90)
      positions.set(unitIndex, { x: cx + offset * Math.cos(angle), y: cy + offset * Math.sin(angle), scale })
    })
  }
  return positions
}

/**
 * Renders a Board as an SVG hex grid, with optional extras for interactive
 * phases: `extraCoords` are untiled hexes that should still be visible/
 * clickable (e.g. empty space a water tile could go), `ghostCells` overlay a
 * translucent green/red preview of a pending placement/target, `units` draw
 * simple colored markers (optionally `highlighted`), and `actionMenu` draws
 * a ring of clickable action options radiating out from one hex (see
 * RoundView.tsx's per-unit action picker). `onHexClick` fires with the
 * axial coordinate of whichever base hex (tiled or not) was clicked —
 * action-menu options have their own `onSelect` and don't trigger it.
 */
export function HexBoard(props: {
  board: Board
  extraCoords?: Coordinate[]
  ghostCells?: GhostCell[]
  units?: UnitMarker[]
  /** Per-card-zone plate colours for `units[].cardState` (issue #311 follow-up) — a signed-in player's profile settings (see UnitColorSettings.tsx), resolved against DEFAULT_UNIT_PLATE_COLORS. Defaults to DEFAULT_UNIT_PLATE_COLORS itself when omitted, e.g. for a signed-out viewer or a context with no profile to load. */
  unitPlateColors?: UnitPlateColors
  /** History-review overlay (see RoundView.tsx's history toggle): one arrow per movement hop since the reviewed window began. */
  arrows?: HistoryArrow[]
  actionMenu?: ActionMenu
  /**
   * Victory-screen overlay (see EndGameView.tsx, calculateTerritoryControlByHex
   * in ../engine/scoring.ts): one entry per hex the terrain-majority rule
   * assigns to a player, in that player's colour. Rendered as an outline
   * tracing the boundary of each player's whole contiguous controlled
   * region rather than decorating each hex on its own — no line is drawn
   * between two of that player's own adjacent hexes, only along a region's
   * outer edge (the board's edge, an uncontrolled hex, another player's
   * territory, or a same-owner hex of a different terrain — a player
   * controlling both a Forest region and an adjacent Plains region still
   * gets two separate outlines, since those are two separate territories
   * per the underlying terrain-region rule even though one player holds
   * both), so a multi-hex win reads as one shape instead of a repeated
   * per-hex stamp. Deliberately an outline rather than a fill (issue #270):
   * filling hexes with a player's colour can blend into a same-hued terrain
   * (e.g. a blue player's water) and hides the terrain underneath either way.
   *
   * `points` is that hex's whole territory's total victory-point value
   * (hex count × content/terrain.json's per-hex rate for its terrain, e.g. a
   * 3-hex Mountain region at 4/hex is worth 12 here, not just 4) — the
   * outline's stroke gets thicker the more a territory is worth relative to
   * every other territory on this same board (see territoryBorderWidth
   * below), so a glance at line weight hints at which regions mattered most
   * for the final score. Deliberately the *territory's* total rather than
   * its terrain's flat per-hex rate: two Mountain regions of very different
   * size are worth very different amounts, and a small Mountain region can
   * be worth less than a large Water one despite Water's lower per-hex rate.
   *
   * Every side is drawn inset toward its own hex's center (see
   * territoryInsetEdge below) rather than centered on the shared boundary —
   * so a territory's stroke (and its dark halo, see
   * TERRITORY_BORDER_HALO_WIDTH_MULTIPLIER) always stays entirely within
   * its own hex, touching the true edge but never crossing it. That keeps
   * two territories meeting at one edge — different colours, or the same
   * colour at different widths — from ever visually coexisting on the same
   * line; where they meet, only their two dark halos touch, reading as one
   * thin dividing seam.
   *
   * Supplying this (even an empty array) also suppresses cliff-edge lines
   * for the whole board — cliffs aren't meaningful on the final board, and a
   * cliff's own fixed-width black line could otherwise show through a
   * territory border drawn on the same real hex edge.
   */
  territoryControl?: { coord: Coordinate; color: string; terrain: string; points: number; /** Renders this hex's border as black-and-white diagonal stripes instead of `color` — the review screen's "changes" mode (issue #281) uses this for a region that turned neutral, instead of a flat white that could be mistaken for an actual (very pale) player colour. */ striped?: boolean }[]
  /**
   * Overrides the min/max `points` this board's border widths (see
   * territoryBorderWidth) scale against, instead of deriving that range from
   * `territoryControl` itself. Needed by the review screen's "highlight only
   * changes" mode (issue #281 follow-up): that mode only puts the handful of
   * hexes that actually changed hands into `territoryControl`, so deriving
   * the range from that subset would make e.g. a small territory render at
   * max width just because it's the biggest among a few tiny changes, rather
   * than sizing it against every territory actually on the board.
   */
  territoryValueRange?: { min: number; max: number }
  selectedCoord?: Coordinate | null
  /**
   * Draws a rotate-arrow glyph on this hex — the pending tile placement's
   * anchor, clicking which rotates it (see TilePlacementPanel in
   * BoardSetupView.tsx). Purely a visual hint; the click itself is still
   * handled by the underlying hex polygon's own `onHexClick`.
   */
  rotateHintCoord?: Coordinate | null
  /** Rotate/Confirm/Cancel controls anchored next to the hex being placed (see PlacementControls). */
  placementControls?: PlacementControls | null
  interactive?: boolean
  /**
   * Restricts which hexes actually respond to hover/click while
   * `interactive` — a hex not in this list renders inert (no pointer
   * cursor, `onHexClick` never fires for it) instead of inviting a click
   * that's guaranteed to be rejected. Omit to make every hex clickable,
   * which is still correct for flows like tile placement where any hex
   * (tiled or not) can become a new anchor.
   */
  clickableCoords?: Coordinate[]
  onHexClick?: (coord: Coordinate) => void
  size?: number
  /** Raises the board's max on-screen height (see RoundView.tsx's "Expand board" toggle, used once the player status sidebar is hidden and there's more room to fill). Default false — the normal 70vh cap. */
  expanded?: boolean
  /**
   * Covers the board with an "Analyzing legal placement…" overlay — shown
   * while the rule-4 room-check search (see BoardSetupView's
   * TilePlacementPanel, canPlaceRemainingTilesDetailed in
   * ../engine/boardGeneration.ts) is running. That search is a bounded but
   * potentially slow synchronous computation that would otherwise block the
   * UI with no feedback (issue #205) — this covers the board for that
   * stretch instead of leaving it looking frozen.
   */
  analyzing?: boolean
}) {
  const size = props.size ?? 22
  const unitPlateColors = props.unitPlateColors ?? DEFAULT_UNIT_PLATE_COLORS
  // Scoped to this HexBoard instance (React can mount several at once, e.g. AdminMapsPage's
  // list) so each board's <pattern> definition only ever resolves to its own.
  const neutralStripePatternId = useId()

  const allCoords = new Map<string, Coordinate>()
  for (const tile of Object.values(props.board.tiles)) allCoords.set(coordKey(tile.coord), tile.coord)
  for (const c of props.extraCoords ?? []) allCoords.set(coordKey(c), c)
  for (const g of props.ghostCells ?? []) allCoords.set(coordKey(g.coord), g.coord)

  // Coords that are allowed to size the viewBox — tiles and `extraCoords`
  // only, never `ghostCells`. `extraCoords` is where a caller like
  // BoardSetupView pre-reserves the untiled hexes a pending placement could
  // ever land on, so it already covers the ghost's reach; keying the bounds
  // off the ghost's own (moving) coords instead made the whole board visibly
  // shift every time the player picked a different hex to preview a tile or
  // unit placement at. `pixels` below still includes ghost-only coords so
  // they render, just not so they influence `minX/minY/maxX/maxY`.
  const boundsCoordKeys = new Set<string>()
  for (const tile of Object.values(props.board.tiles)) boundsCoordKeys.add(coordKey(tile.coord))
  for (const c of props.extraCoords ?? []) boundsCoordKeys.add(coordKey(c))

  const clickableKeys = props.clickableCoords ? new Set(props.clickableCoords.map(coordKey)) : null

  const coords = [...allCoords.values()]
  if (coords.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-neutral-700 text-neutral-500">
        Board has not been generated yet.
      </div>
    )
  }

  const pixels = coords.map((coord) => ({ coord, ...axialToPixel(coord, size) }))
  const pad = size * 1.5
  const boundsPoints = pixels.filter((p) => boundsCoordKeys.has(coordKey(p.coord))).map((p) => ({ x: p.x, y: p.y }))
  // A history-review label (see UnitMarker.historyDelta) sits well outside
  // its own hex, and can get stacked further down still to dodge a nearby
  // label — extend the viewBox so neither can get clipped for a unit near
  // the board's edge.
  const historyLabelPositions = computeHistoryLabelPositions(props.units ?? [], size)
  const unitStackPositions = computeUnitStackPositions(props.units ?? [], size)
  for (const { x, y } of historyLabelPositions.values()) {
    boundsPoints.push({ x: x + size * HISTORY_LABEL_WIDTH_FACTOR, y: y + size * HISTORY_LABEL_HEIGHT_FACTOR })
  }

  const actionMenuCenter = props.actionMenu ? axialToPixel(props.actionMenu.coord, size) : null
  // The action menu's own reach used to be excluded from the bounding-box
  // calculation on the theory that folding it in would resize/recenter the
  // viewBox — and visibly shift the whole board — the instant the menu
  // opens or closes. In practice that let an option land outside the `<svg>`'s
  // own rendered box (kept visible only via `overflow: visible` below),
  // which for a unit near the board's edge could push the option off the
  // page entirely, beyond where the player could scroll to click it. Bug
  // report: "radial menu option is unreachable" (the topmost option, for a
  // unit near the top edge). A one-time resize while the menu is open is a
  // smaller cost than an unclickable option, so its reach is now included
  // here too, the same way a history label's is just above.
  let actionMenuLayout: {
    showGroupLabels: boolean
    angleByOptionId: Map<string, number>
    radius: number
    boxWidth: number
    boxHeight: number
  } | null = null
  if (props.actionMenu && actionMenuCenter) {
    const groups = groupActionMenuOptions(props.actionMenu.options)
    const showGroupLabels = groups.length > 1
    const hasOutcomes = props.actionMenu.options.some((o) => o.outcome && Object.values(o.outcome).some(Boolean))
    const angleByOptionId = computeActionMenuAngles(groups)
    const radius = actionMenuRadius(size, props.actionMenu.options.length)
    const boxWidth = size * ACTION_MENU_BOX_WIDTH_FACTOR
    const boxHeight = size * ACTION_MENU_BOX_HEIGHT_FACTOR * (showGroupLabels ? 1.5 : 1) * (hasOutcomes ? 1.5 : 1)
    actionMenuLayout = { showGroupLabels, angleByOptionId, radius, boxWidth, boxHeight }
    for (const option of props.actionMenu.options) {
      const angle = angleByOptionId.get(option.id) ?? 0
      const ox = actionMenuCenter.x + radius * Math.cos(angle)
      const oy = actionMenuCenter.y + radius * Math.sin(angle)
      boundsPoints.push({ x: ox - boxWidth / 2, y: oy - boxHeight / 2 })
      boundsPoints.push({ x: ox + boxWidth / 2, y: oy + boxHeight / 2 })
    }
  }

  const placementControlsCenter = props.placementControls ? axialToPixel(props.placementControls.coord, size) : null
  const placementControlsBox = placementControlsCenter
    ? {
        x: placementControlsCenter.x - (size * PLACEMENT_CONTROLS_WIDTH_FACTOR) / 2,
        y: placementControlsCenter.y + size * PLACEMENT_CONTROLS_Y_OFFSET_FACTOR,
        width: size * PLACEMENT_CONTROLS_WIDTH_FACTOR,
        height: size * PLACEMENT_CONTROLS_HEIGHT_FACTOR,
      }
    : null
  if (placementControlsBox) {
    boundsPoints.push({ x: placementControlsBox.x, y: placementControlsBox.y })
    boundsPoints.push({ x: placementControlsBox.x + placementControlsBox.width, y: placementControlsBox.y + placementControlsBox.height })
  }

  const minX = Math.min(...boundsPoints.map((p) => p.x)) - pad
  const maxX = Math.max(...boundsPoints.map((p) => p.x)) + pad
  const minY = Math.min(...boundsPoints.map((p) => p.y)) - pad
  const maxY = Math.max(...boundsPoints.map((p) => p.y)) + pad

  const ghostByKey = new Map((props.ghostCells ?? []).map((g) => [coordKey(g.coord), g]))

  // Cliff edges are skipped entirely once `territoryControl` is supplied
  // (the victory-screen board, see HexBoard.territoryControl's doc comment)
  // rather than drawn underneath the territory borders — every territory
  // border segment sits exactly where a cliff edge would (see
  // territoryBorderSegments below), so a cliff's own fixed-width black line
  // would otherwise show through a thinner border drawn right on top of it.
  // Cliffs aren't meaningful on the final board anyway, so this drops them
  // there entirely instead of trying to reconcile the two.
  const cliffEdges: { x1: number; y1: number; x2: number; y2: number }[] = []
  if (!props.territoryControl) {
    for (const { coord, x, y } of pixels) {
      const tile = props.board.tiles[coordKey(coord)]
      if (!tile) continue
      for (const dir of CLIFF_CHECK_DIRECTIONS) {
        const neighborCoord = { q: coord.q + dir.q, r: coord.r + dir.r }
        const neighborTile = props.board.tiles[coordKey(neighborCoord)]
        if (!neighborTile) continue
        if (!isCliffEdge(TERRAIN_LEVEL[tile.terrain], TERRAIN_LEVEL[neighborTile.terrain])) continue
        const { x: nx, y: ny } = axialToPixel(neighborCoord, size)
        cliffEdges.push(hexEdgeSegment(x, y, nx, ny, size - 1))
      }
    }
  }

  const structureConnectorEdges: { x1: number; y1: number; x2: number; y2: number }[] = []
  for (const unit of props.units ?? []) {
    if (!unit.connectedNeighborCoords) continue
    const { x, y } = axialToPixel(unit.coord, size)
    for (const neighborCoord of unit.connectedNeighborCoords) {
      const { x: nx, y: ny } = axialToPixel(neighborCoord, size)
      structureConnectorEdges.push(hexEdgeSegment(x, y, nx, ny, size - 1))
    }
  }

  // Each territory (one contiguous same-owner-same-terrain region — see
  // groupTerritoryHexes) traces as one or more closed boundary loops (see
  // territoryBoundaryLoops), which are then inset inward as a whole (see
  // insetLoopVertices) rather than one hex-side at a time: every vertex on
  // the loop gets exactly one inset position, shared by the two segments on
  // either side of it, so the outline stays connected as it crosses from one
  // member hex to the next — insetting each hex's sides independently (an
  // earlier version of this) instead pulled each hex's own sides toward its
  // own center, which left the outline visibly broken at that same crossing
  // (bug report: "line is broken when it crossed to a new hex").
  //
  // The loop is still inset by the halo's own half-width (not just the
  // colour line's), so the stroke — halo included — always stays within its
  // own territory, never crossing the real hex-to-hex edge into a
  // neighboring territory's side of it (see TERRITORY_BORDER_HALO_WIDTH_MULTIPLIER).
  const territoryByKey = new Map((props.territoryControl ?? []).map((t) => [coordKey(t.coord), t]))
  const territoryBorderSegments: { x1: number; y1: number; x2: number; y2: number; color: string; strokeWidth: number; striped: boolean }[] = []
  if (territoryByKey.size > 0) {
    const allPoints = [...territoryByKey.values()].map((t) => t.points)
    const minPoints = props.territoryValueRange?.min ?? Math.min(...allPoints)
    const maxPoints = props.territoryValueRange?.max ?? Math.max(...allPoints)

    for (const group of groupTerritoryHexes(props.board, territoryByKey)) {
      const { color, points, striped } = group[0]
      const strokeWidth = territoryBorderWidth(size, points, minPoints, maxPoints)
      const insetDist = strokeWidth * (TERRITORY_BORDER_HALO_WIDTH_MULTIPLIER / 2)
      for (const loop of territoryBoundaryLoops(props.board, group, territoryByKey, size)) {
        const insetVertices = insetLoopVertices(loop, insetDist)
        const n = insetVertices.length
        for (let i = 0; i < n; i++) {
          const a = insetVertices[i]
          const b = insetVertices[(i + 1) % n]
          territoryBorderSegments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color, strokeWidth, striped: striped ?? false })
        }
      }
    }
  }

  return (
    <div className="relative">
      {/*
       * The height cap lives on this wrapper, not the `<svg>` itself. An
       * `<svg>` sized via `width: 100%` with no explicit `height` derives its
       * height from `viewBox`'s aspect ratio — capping *that* element's own
       * `max-height` makes a tall/narrow board's computed height exceed the
       * cap, which per the CSS replaced-element sizing algorithm shrinks the
       * `<svg>`'s *width* too (to preserve the aspect ratio), leaving it
       * narrower than its container with empty space beside it. Bug report:
       * "on mobile, the victory screen is sometimes scaled incorrectly" (a
       * board that was tall relative to a narrow mobile viewport's width,
       * rendering at roughly half width with the other half blank). Capping
       * this wrapper's height instead leaves the `<svg>` always full width —
       * a board taller than the cap now scrolls vertically within the
       * wrapper rather than shrinking horizontally.
       */}
      <div className={`overflow-auto ${props.expanded ? 'max-h-[92vh]' : 'max-h-[70vh]'}`}>
      <svg
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ overflow: 'visible' }}
        className="block w-full rounded-md border border-neutral-800 bg-neutral-950"
      >
      <defs>
        {/* A region that turned neutral (see territoryControl's `striped` doc comment) renders with
            this instead of a flat colour, so it can't be mistaken for an actual (very pale) player
            colour. Rotated 45° for a "hazard tape" look distinct from any straight hex edge. */}
        <pattern
          id={neutralStripePatternId}
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={6} height={6} fill="#ffffff" />
          <rect width={3} height={6} fill="#000000" />
        </pattern>
      </defs>
      {pixels.map(({ coord, x, y }) => {
        const tile = props.board.tiles[coordKey(coord)]
        const selected = props.selectedCoord?.q === coord.q && props.selectedCoord?.r === coord.r
        const clickable = props.interactive && (clickableKeys === null || clickableKeys.has(coordKey(coord)))
        return (
          <polygon
            key={coordKey(coord)}
            data-coord={coordKey(coord)}
            points={hexPoints(x, y, size - 1)}
            fill={tile ? TERRAIN_COLOR[tile.terrain] : 'transparent'}
            stroke={selected ? '#eab308' : '#3f3f46'}
            strokeWidth={selected ? 2 : 1}
            className={clickable ? 'cursor-pointer hover:opacity-80' : undefined}
            onClick={clickable && props.onHexClick ? () => props.onHexClick?.(coord) : undefined}
          />
        )
      })}
      {cliffEdges.map((edge, i) => (
        <line
          key={`cliff-${i}`}
          x1={edge.x1}
          y1={edge.y1}
          x2={edge.x2}
          y2={edge.y2}
          stroke="#000000"
          strokeWidth={4}
          strokeLinecap="round"
          pointerEvents="none"
        />
      ))}
      {structureConnectorEdges.map((edge, i) => (
        <line
          key={`structure-connector-${i}`}
          x1={edge.x1}
          y1={edge.y1}
          x2={edge.x2}
          y2={edge.y2}
          stroke="#d6b98c"
          strokeWidth={4}
          strokeLinecap="round"
          pointerEvents="none"
        />
      ))}
      {territoryBorderSegments.map((seg, i) => (
        <line
          key={`territory-halo-${i}`}
          x1={seg.x1}
          y1={seg.y1}
          x2={seg.x2}
          y2={seg.y2}
          stroke="#000000"
          strokeOpacity={0.6}
          strokeWidth={seg.strokeWidth * TERRITORY_BORDER_HALO_WIDTH_MULTIPLIER}
          strokeLinecap="round"
          pointerEvents="none"
        />
      ))}
      {territoryBorderSegments.map((seg, i) => (
        <line
          key={`territory-${i}`}
          x1={seg.x1}
          y1={seg.y1}
          x2={seg.x2}
          y2={seg.y2}
          stroke={seg.striped ? `url(#${neutralStripePatternId})` : seg.color}
          data-striped={seg.striped || undefined}
          strokeWidth={seg.strokeWidth}
          strokeLinecap="round"
          pointerEvents="none"
        />
      ))}
      {pixels.map(({ coord, x, y }) => {
        const ghost = ghostByKey.get(coordKey(coord))
        if (!ghost) return null
        // A small center dot used to mark a legal target, but a Convert's
        // target hex always already has a unit standing on it — the unit's
        // own plate (drawn after this, on top) completely covered the dot,
        // making it invisible rather than just hard to see. Highlighting the
        // whole hex instead still shows past the unit's circular plate, at
        // the hex's own corners, regardless of what's drawn on top of it.
        return (
          <polygon
            key={`ghost-${coordKey(coord)}`}
            data-ghost-coord={coordKey(coord)}
            points={hexPoints(x, y, size - 1)}
            fill={ghost.legal ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)'}
            stroke={ghost.legal ? '#22c55e' : '#ef4444'}
            strokeWidth={3}
            pointerEvents="none"
          />
        )
      })}
      {props.rotateHintCoord &&
        (() => {
          const { x, y } = axialToPixel(props.rotateHintCoord, size)
          return (
            <g data-rotate-hint-coord={coordKey(props.rotateHintCoord)}>
              <RotateHintIcon cx={x} cy={y} r={size * 0.55} />
            </g>
          )
        })()}
      {(props.arrows ?? []).map((arrow, i) => {
        const from = axialToPixel(arrow.from, size)
        const to = axialToPixel(arrow.to, size)
        const headLength = size * 0.4
        const seg = insetSegment(from.x, from.y, to.x, to.y, size * 0.5, size * 0.5 + headLength * 0.6)
        return (
          <g key={`arrow-${i}`} pointerEvents="none">
            <line x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} stroke="#38bdf8" strokeWidth={2.5} strokeLinecap="round" />
            <polygon points={arrowHeadPoints(seg.x1, seg.y1, seg.x2, seg.y2, headLength, size * 0.24)} fill="#38bdf8" />
          </g>
        )
      })}
      {(props.units ?? []).map((unit, i) => {
        const { x, y, scale } = unitStackPositions.get(i) ?? { ...axialToPixel(unit.coord, size), scale: 1 }
        const plateSize = size * 0.8 * scale
        // The glyph fills the whole plate (and the bar is narrower still),
        // so it visibly spills past the ownership bar's edges on purpose —
        // see unitIcons.ts's doc comment for why the plate itself is a
        // fixed neutral colour rather than the player's.
        const glyphSize = plateSize
        const barWidth = plateSize * 0.7
        const barHeight = plateSize * 0.26
        const barY = y + plateSize / 2 - barHeight * 0.25
        const historyHalos = unit.historyHalos ?? []
        return (
          <g key={i} pointerEvents="none">
            {unit.highlighted && (
              <circle cx={x} cy={y} r={size * 0.55 * scale} fill="none" stroke="#fbbf24" strokeWidth={2}>
                <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
              </circle>
            )}
            {unit.supportCandidate && (
              <circle cx={x} cy={y} r={size * 0.65 * scale} fill="none" stroke="#2dd4bf" strokeWidth={unit.supportSelected ? 3 : 2}>
                {!unit.supportSelected && <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />}
              </circle>
            )}
            {historyHalos.map((haloType, hi) => (
              <circle
                key={`halo-${haloType}`}
                cx={x}
                cy={y}
                r={plateSize / 2 + size * 0.22 + hi * size * 0.14}
                fill="none"
                stroke={HISTORY_HALO_COLOR[haloType]}
                strokeWidth={2.5}
              >
                <title>{haloType}</title>
              </circle>
            ))}
            {STATIC_UNIT_KINDS.has(unit.kind) ? (
              <rect
                x={x - plateSize / 2}
                y={y - plateSize / 2}
                width={plateSize}
                height={plateSize}
                rx={plateSize * 0.15}
                fill={plateColorFor(unit.cardState, unitPlateColors)}
                stroke="#000"
                strokeWidth={1}
              />
            ) : (
              <circle cx={x} cy={y} r={plateSize / 2} fill={plateColorFor(unit.cardState, unitPlateColors)} stroke="#000" strokeWidth={1} />
            )}
            <rect
              x={x - barWidth / 2}
              y={barY}
              width={barWidth}
              height={barHeight}
              rx={barHeight * 0.3}
              fill={unit.color}
              stroke="#000"
              strokeWidth={0.75}
            />
            <UnitGlyph kind={unit.kind} x={x} y={y} size={glyphSize} declined={unit.declined} />
          </g>
        )
      })}
      {/*
       * Rendered as its own pass after every unit, rather than inline in the
       * loop above, so a label always sits on top of every unit plate —
       * including a later-indexed unit whose own plate would otherwise be
       * drawn after (and on top of) an earlier unit's label. Bug report:
       * "label is sometimes not the top most element".
       */}
      {(props.units ?? []).map((unit, i) => {
        if (!unit.historyDelta || !historyLabelPositions.has(i)) return null
        const { x, y } = historyLabelPositions.get(i)!
        return (
          <foreignObject
            key={`history-${i}`}
            x={x}
            y={y}
            width={size * HISTORY_LABEL_WIDTH_FACTOR}
            height={size * HISTORY_LABEL_HEIGHT_FACTOR}
            pointerEvents="none"
          >
            <div
              style={{ fontSize: size * 0.34, lineHeight: 1.1 }}
              // `w-fit`/shrink-to-fit sizing doesn't reliably compute inside
              // an SVG foreignObject (observed in Chromium: the box instead
              // expands to fill the foreignObject's full declared width,
              // pushing the actually-narrow text mostly out of view) — fill
              // the box exactly instead and center within it, the same
              // fixed-size approach the action-menu option boxes below
              // already use safely.
              className="flex h-full w-full items-center justify-center gap-1 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-900/95 px-1.5 font-medium text-neutral-100"
            >
              {RESOURCE_ORDER.filter((key) => unit.historyDelta![key]).map((key) => {
                const amount = unit.historyDelta![key]!
                return (
                  <span key={key} className={`inline-flex items-center gap-0.5 font-bold ${RESOURCE_COLOR_CLASS[key]}`}>
                    <ResourceIcon resource={key} title={RESOURCE_LABEL[key]} className="h-[1em] w-[1em] shrink-0" />
                    {amount > 0 ? '+' : ''}
                    {amount}
                  </span>
                )
              })}
            </div>
          </foreignObject>
        )
      })}
      {props.actionMenu && actionMenuCenter && actionMenuLayout && (
        <g>
          {(() => {
            const { options } = props.actionMenu!
            const { showGroupLabels, angleByOptionId, radius, boxWidth, boxHeight } = actionMenuLayout
            return options.map((option) => {
              const angle = angleByOptionId.get(option.id) ?? 0
              const ox = actionMenuCenter.x + radius * Math.cos(angle)
              const oy = actionMenuCenter.y + radius * Math.sin(angle)
              const disabled = option.disabled ?? false
              const supportable = !disabled && (option.supportable ?? false)
              return (
                <g
                  key={`${option.unitId}-${option.id}`}
                  className={disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
                  onClick={disabled ? undefined : () => props.actionMenu?.onSelect(option.unitId, option.id)}
                >
                  <line
                    x1={actionMenuCenter.x}
                    y1={actionMenuCenter.y}
                    x2={ox}
                    y2={oy}
                    stroke={disabled ? '#3f3f46' : supportable ? '#b45309' : '#71717a'}
                    strokeWidth={1}
                    strokeDasharray={disabled ? '3 3' : undefined}
                  />
                  <foreignObject x={ox - boxWidth / 2} y={oy - boxHeight / 2} width={boxWidth} height={boxHeight}>
                    <div
                      style={{ fontSize: size * 0.3, lineHeight: 1.15 }}
                      title={supportable ? `${option.description ?? ''}\n\nOther idle units can cover the shortfall — pick this to choose which ones.`.trim() : option.description}
                      className={
                        disabled
                          ? 'flex h-full w-full flex-col items-center justify-center rounded-md border-2 border-dashed border-red-900 bg-neutral-900 px-1 text-center font-medium text-neutral-500'
                          : supportable
                            ? 'flex h-full w-full flex-col items-center justify-center rounded-md border-2 border-amber-500 bg-indigo-950 px-1 text-center font-medium text-indigo-100 hover:bg-indigo-900'
                            : 'flex h-full w-full flex-col items-center justify-center rounded-md border-2 border-indigo-400 bg-indigo-950 px-1 text-center font-medium text-indigo-100 hover:bg-indigo-900'
                      }
                    >
                      {showGroupLabels && (
                        <span className="text-[0.75em] font-normal uppercase tracking-wide opacity-70">{option.unitKind}</span>
                      )}
                      <span className="font-bold uppercase tracking-wide">{option.label}</span>
                      {option.outcome && Object.values(option.outcome).some(Boolean) && (
                        <span className="mt-0.5 flex items-center gap-1.5 text-[0.95em]">
                          {RESOURCE_ORDER.filter((key) => option.outcome?.[key]).map((key) => {
                            const amount = option.outcome![key]!
                            return (
                              <span key={key} className={`flex items-center gap-0.5 font-bold ${RESOURCE_COLOR_CLASS[key]}`}>
                                <ResourceIcon resource={key} className="h-[1.15em] w-[1.15em]" />
                                {amount > 0 ? '+' : ''}
                                {amount}
                              </span>
                            )
                          })}
                        </span>
                      )}
                      {supportable && option.shortfall && (
                        <span className="mt-0.5 text-[0.7em] leading-tight font-normal text-amber-500">{formatShortfall(option.shortfall)}</span>
                      )}
                    </div>
                  </foreignObject>
                </g>
              )
            })
          })()}
        </g>
      )}
      {props.placementControls && placementControlsBox && (
        <foreignObject x={placementControlsBox.x} y={placementControlsBox.y} width={placementControlsBox.width} height={placementControlsBox.height}>
          <div style={{ fontSize: size * 0.4 }} className="flex h-full w-full items-center justify-center gap-1.5 whitespace-nowrap">
            <button
              onClick={props.placementControls.onConfirm}
              className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500"
            >
              Confirm
            </button>
          </div>
        </foreignObject>
      )}
      </svg>
      </div>
      {props.analyzing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-neutral-950/70">
          <span className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm font-medium text-neutral-200">
            Analyzing legal placement…
          </span>
        </div>
      )}
    </div>
  )
}
