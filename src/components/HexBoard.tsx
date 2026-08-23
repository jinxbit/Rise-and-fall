import { isCliffEdge } from '../engine/cliffs'
import type { Board, Coordinate, Resources, Terrain } from '../engine/types'
import { coordKey } from '../engine/types'
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
}

/** A movement event in history-review mode — one hex-to-hex hop, drawn as an arrow. A unit that moved more than once in the reviewed window gets one arrow per hop, in order. */
export interface HistoryArrow {
  from: Coordinate
  to: Coordinate
}

/** The unit glyph's fixed ink colour — always drawn on UNIT_PLATE_COLOR (see UnitGlyph), so contrast is guaranteed regardless of player colour or terrain. */
const UNIT_GLYPH_COLOR = '#14161a'
/** The marker's fixed backdrop behind the glyph — deliberately NOT the player's colour (see unitIcons.ts's doc comment for why). Ownership shows instead as a small colour bar beneath it. */
const UNIT_PLATE_COLOR = '#f2f2ef'

/** A unit kind's pictogram, centered at (x, y) at `size` pixels square, in the fixed ink colour. */
function UnitGlyph({ kind, x, y, size }: { kind: string; x: number; y: number; size: number }) {
  const shapes = UNIT_ICONS[kind] ?? []
  return (
    <svg x={x - size / 2} y={y - size / 2} width={size} height={size} viewBox="0 0 24 24" pointerEvents="none">
      {shapes.map((shape: IconShape, i) => {
        switch (shape.kind) {
          case 'polygon':
            return <polygon key={i} points={shape.points} fill={UNIT_GLYPH_COLOR} />
          case 'rect':
            return <rect key={i} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} fill={UNIT_GLYPH_COLOR} />
          case 'path':
            return <path key={i} d={shape.d} fill={UNIT_GLYPH_COLOR} fillRule={shape.fillRule} />
          case 'circle':
            return <circle key={i} cx={shape.cx} cy={shape.cy} r={shape.r} fill={UNIT_GLYPH_COLOR} />
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
const HISTORY_LABEL_WIDTH_FACTOR = 2.6
const HISTORY_LABEL_HEIGHT_FACTOR = 0.62

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
 * keyed by that unit's index in `units` — normally just above-right of the
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

  const positions = new Map<number, { x: number; y: number }>()
  const claimed: { x: number; y: number }[] = []

  units.forEach((unit, i) => {
    if (!unit.historyDelta || RESOURCE_ORDER.every((key) => !unit.historyDelta![key])) return
    const { x, y } = axialToPixel(unit.coord, size)
    const baseX = x + plateSize * 0.4
    const baseY = y - plateSize * 1.05

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
  /** History-review overlay (see RoundView.tsx's history toggle): one arrow per movement hop since the reviewed window began. */
  arrows?: HistoryArrow[]
  actionMenu?: ActionMenu
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

  const cliffEdges: { x1: number; y1: number; x2: number; y2: number }[] = []
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

  const structureConnectorEdges: { x1: number; y1: number; x2: number; y2: number }[] = []
  for (const unit of props.units ?? []) {
    if (!unit.connectedNeighborCoords) continue
    const { x, y } = axialToPixel(unit.coord, size)
    for (const neighborCoord of unit.connectedNeighborCoords) {
      const { x: nx, y: ny } = axialToPixel(neighborCoord, size)
      structureConnectorEdges.push(hexEdgeSegment(x, y, nx, ny, size - 1))
    }
  }

  return (
    <div className="relative">
      <svg
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ overflow: 'visible' }}
        className={`w-full rounded-md border border-neutral-800 bg-neutral-950 ${props.expanded ? 'max-h-[92vh]' : 'max-h-[70vh]'}`}
      >
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
                fill={UNIT_PLATE_COLOR}
                stroke="#000"
                strokeWidth={1}
              />
            ) : (
              <circle cx={x} cy={y} r={plateSize / 2} fill={UNIT_PLATE_COLOR} stroke="#000" strokeWidth={1} />
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
            <UnitGlyph kind={unit.kind} x={x} y={y} size={glyphSize} />
            {unit.historyDelta && historyLabelPositions.has(i) && (
              <foreignObject
                x={historyLabelPositions.get(i)!.x}
                y={historyLabelPositions.get(i)!.y}
                width={size * HISTORY_LABEL_WIDTH_FACTOR}
                height={size * HISTORY_LABEL_HEIGHT_FACTOR}
              >
                <div
                  style={{ fontSize: size * 0.28, lineHeight: 1.1 }}
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
            )}
          </g>
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
