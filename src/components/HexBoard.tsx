import { isCliffEdge } from '../engine/cliffs'
import type { Board, Coordinate, Terrain } from '../engine/types'
import { coordKey } from '../engine/types'
import type { IconShape } from './unitIcons'
import { STATIC_UNIT_KINDS, UNIT_ICONS } from './unitIcons'

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
  /** History-review overlay: one ring per applicable event type since the reviewed window began — concentric if more than one applies to the same unit. */
  historyHalos?: HistoryHaloType[]
  /** History-review overlay: a small tag near the marker for an income/produce/trade amount, e.g. "+5 Gold" or "+1 Wood, -5 Gold". */
  historyLabel?: string
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
  id: string
  /** Full action name, shown in full in the option's box — no abbreviation, since a 1-2 letter label made the menu unusable (had to hover to find out what each option was). */
  label: string
  /**
   * True when the unit can't actually perform this action right now (e.g.
   * unaffordable, no legal target) — rendered with a distinct dim-red/
   * slashed-border treatment and no click handler, never with reduced
   * opacity (that reads as "loading"/"disabled-and-still-legible" rather
   * than "you cannot pick this").
   */
  disabled?: boolean
}

export interface ActionMenu {
  /** The hex the menu radiates out from — normally the unit that was clicked. */
  coord: Coordinate
  options: ActionMenuOption[]
  onSelect: (optionId: string) => void
}

/** Distance from the unit to each option box's center — grows with option count so boxes wide enough for full action names (e.g. "Transform to Merchant") don't overlap (Merchant has 7 options, the most of any unit kind). */
function actionMenuRadius(size: number, optionCount: number): number {
  return size * (2.6 + Math.max(0, optionCount - 3) * 0.6)
}

const ACTION_MENU_BOX_WIDTH_FACTOR = 3.4
const ACTION_MENU_BOX_HEIGHT_FACTOR = 1.7
/** Generous enough for the longest realistic history label, e.g. "+1 Wood, -5 Gold". */
const HISTORY_LABEL_WIDTH_FACTOR = 3.4

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
}) {
  const size = props.size ?? 22

  const allCoords = new Map<string, Coordinate>()
  for (const tile of Object.values(props.board.tiles)) allCoords.set(coordKey(tile.coord), tile.coord)
  for (const c of props.extraCoords ?? []) allCoords.set(coordKey(c), c)
  for (const g of props.ghostCells ?? []) allCoords.set(coordKey(g.coord), g.coord)

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
  const boundsPoints = [...pixels.map((p) => ({ x: p.x, y: p.y }))]
  if (props.actionMenu) {
    const { x, y } = axialToPixel(props.actionMenu.coord, size)
    const menuPad =
      actionMenuRadius(size, props.actionMenu.options.length) + size * Math.max(ACTION_MENU_BOX_WIDTH_FACTOR, ACTION_MENU_BOX_HEIGHT_FACTOR)
    boundsPoints.push({ x: x - menuPad, y: y - menuPad }, { x: x + menuPad, y: y + menuPad })
  }
  // A history-review label (see UnitMarker.historyLabel) sits well outside
  // its own hex — extend the viewBox so it can't get clipped for a unit
  // near the board's edge.
  for (const unit of props.units ?? []) {
    if (!unit.historyLabel) continue
    const { x, y } = axialToPixel(unit.coord, size)
    const plateSize = size * 0.8
    boundsPoints.push({ x: x + plateSize * 0.4 + size * HISTORY_LABEL_WIDTH_FACTOR, y: y - plateSize * 1.05 })
  }
  const minX = Math.min(...boundsPoints.map((p) => p.x)) - pad
  const maxX = Math.max(...boundsPoints.map((p) => p.x)) + pad
  const minY = Math.min(...boundsPoints.map((p) => p.y)) - pad
  const maxY = Math.max(...boundsPoints.map((p) => p.y)) + pad

  const ghostByKey = new Map((props.ghostCells ?? []).map((g) => [coordKey(g.coord), g]))

  const actionMenuCenter = props.actionMenu ? axialToPixel(props.actionMenu.coord, size) : null

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

  return (
    <svg
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      className="max-h-[70vh] w-full rounded-md border border-neutral-800 bg-neutral-950"
    >
      {pixels.map(({ coord, x, y }) => {
        const tile = props.board.tiles[coordKey(coord)]
        const selected = props.selectedCoord?.q === coord.q && props.selectedCoord?.r === coord.r
        const clickable = props.interactive && (clickableKeys === null || clickableKeys.has(coordKey(coord)))
        return (
          <polygon
            key={coordKey(coord)}
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
            points={hexPoints(x, y, size - 1)}
            fill={ghost.legal ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.2)'}
            stroke={ghost.legal ? '#22c55e' : '#ef4444'}
            strokeWidth={2}
            pointerEvents="none"
          />
        )
      })}
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
        const { x, y } = axialToPixel(unit.coord, size)
        const plateSize = size * 0.8
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
              <circle cx={x} cy={y} r={size * 0.55} fill="none" stroke="#fbbf24" strokeWidth={2}>
                <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
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
            {unit.historyLabel && (
              <foreignObject x={x + plateSize * 0.4} y={y - plateSize * 1.05} width={size * HISTORY_LABEL_WIDTH_FACTOR} height={size * 0.62}>
                <div
                  style={{ fontSize: size * 0.28, lineHeight: 1.1 }}
                  // `w-fit`/shrink-to-fit sizing doesn't reliably compute inside
                  // an SVG foreignObject (observed in Chromium: the box instead
                  // expands to fill the foreignObject's full declared width,
                  // pushing the actually-narrow text mostly out of view) — fill
                  // the box exactly instead and center within it, the same
                  // fixed-size approach the action-menu option boxes below
                  // already use safely.
                  className="flex h-full w-full items-center justify-center whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-900/95 px-1.5 font-medium text-neutral-100"
                >
                  {unit.historyLabel}
                </div>
              </foreignObject>
            )}
          </g>
        )
      })}
      {props.actionMenu && actionMenuCenter && (
        <g>
          {props.actionMenu.options.map((option, i) => {
            const count = props.actionMenu!.options.length
            const angle = (Math.PI / 180) * ((360 / count) * i - 90)
            const radius = actionMenuRadius(size, count)
            const ox = actionMenuCenter.x + radius * Math.cos(angle)
            const oy = actionMenuCenter.y + radius * Math.sin(angle)
            const boxWidth = size * ACTION_MENU_BOX_WIDTH_FACTOR
            const boxHeight = size * ACTION_MENU_BOX_HEIGHT_FACTOR
            const disabled = option.disabled ?? false
            return (
              <g
                key={option.id}
                className={disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
                onClick={disabled ? undefined : () => props.actionMenu?.onSelect(option.id)}
              >
                <line
                  x1={actionMenuCenter.x}
                  y1={actionMenuCenter.y}
                  x2={ox}
                  y2={oy}
                  stroke={disabled ? '#3f3f46' : '#71717a'}
                  strokeWidth={1}
                  strokeDasharray={disabled ? '3 3' : undefined}
                />
                <foreignObject x={ox - boxWidth / 2} y={oy - boxHeight / 2} width={boxWidth} height={boxHeight}>
                  <div
                    style={{ fontSize: size * 0.3, lineHeight: 1.15 }}
                    className={
                      disabled
                        ? 'flex h-full w-full items-center justify-center rounded-md border-2 border-dashed border-red-900 bg-neutral-900 px-1 text-center font-medium text-neutral-500'
                        : 'flex h-full w-full items-center justify-center rounded-md border-2 border-indigo-400 bg-indigo-950 px-1 text-center font-medium text-indigo-100 hover:bg-indigo-900'
                    }
                  >
                    {option.label}
                  </div>
                </foreignObject>
              </g>
            )
          })}
        </g>
      )}
    </svg>
  )
}
