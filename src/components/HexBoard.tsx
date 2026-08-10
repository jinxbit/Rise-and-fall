import { isCliffEdge } from '../engine/cliffs'
import type { Board, Coordinate, Terrain } from '../engine/types'
import { coordKey } from '../engine/types'

// Pointy-top axial hex rendering. Matches the axial convention used
// throughout src/engine (HEX_DIRECTIONS in ../engine/board.ts, the shape
// math in ../engine/boardGeneration.ts): x grows with q and half of r, y
// grows with r.

const TERRAIN_COLOR: Record<Terrain, string> = {
  water: '#075985',
  plain: '#3f6212',
  forest: '#065f46',
  mountain: '#57534e',
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

export interface GhostCell {
  coord: Coordinate
  legal: boolean
}

export interface UnitMarker {
  coord: Coordinate
  color: string
  label: string
  /** Draws a bright ring around the unit — e.g. "this unit can still act this turn, click it." */
  highlighted?: boolean
}

export interface ActionMenuOption {
  id: string
  /** Full action name, shown in full in the option's box — no abbreviation, since a 1-2 letter label made the menu unusable (had to hover to find out what each option was). */
  label: string
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
        if (ghost.legal) {
          return <circle key={`ghost-${coordKey(coord)}`} cx={x} cy={y} r={size * 0.16} fill="#ffffff" pointerEvents="none" />
        }
        return (
          <polygon
            key={`ghost-${coordKey(coord)}`}
            points={hexPoints(x, y, size - 1)}
            fill="rgba(239,68,68,0.2)"
            stroke="#ef4444"
            strokeWidth={2}
            pointerEvents="none"
          />
        )
      })}
      {(props.units ?? []).map((unit, i) => {
        const { x, y } = axialToPixel(unit.coord, size)
        return (
          <g key={i} pointerEvents="none">
            {unit.highlighted && (
              <circle cx={x} cy={y} r={size * 0.55} fill="none" stroke="#fbbf24" strokeWidth={2}>
                <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
              </circle>
            )}
            <circle cx={x} cy={y} r={size * 0.4} fill={unit.color} stroke="#000" strokeWidth={1} />
            <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={size * 0.4} fill="#000">
              {unit.label}
            </text>
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
            return (
              <g key={option.id} className="cursor-pointer" onClick={() => props.actionMenu?.onSelect(option.id)}>
                <line x1={actionMenuCenter.x} y1={actionMenuCenter.y} x2={ox} y2={oy} stroke="#71717a" strokeWidth={1} />
                <foreignObject x={ox - boxWidth / 2} y={oy - boxHeight / 2} width={boxWidth} height={boxHeight}>
                  <div
                    style={{ fontSize: size * 0.3, lineHeight: 1.15 }}
                    className="flex h-full w-full items-center justify-center rounded-md border-2 border-indigo-400 bg-indigo-950 px-1 text-center font-medium text-indigo-100 hover:bg-indigo-900"
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
