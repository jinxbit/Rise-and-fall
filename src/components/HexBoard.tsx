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

export interface GhostCell {
  coord: Coordinate
  legal: boolean
}

export interface UnitMarker {
  coord: Coordinate
  color: string
  label: string
}

/**
 * Renders a Board as an SVG hex grid, with optional extras for the
 * board-setup interaction: `extraCoords` are untiled hexes that should still
 * be visible/clickable (e.g. empty space a water tile could go), `ghostCells`
 * overlay a translucent green/red preview of a pending placement, and
 * `units` draw simple colored markers. `onHexClick` fires with the axial
 * coordinate of whichever hex (tiled or not) was clicked.
 */
export function HexBoard(props: {
  board: Board
  extraCoords?: Coordinate[]
  ghostCells?: GhostCell[]
  units?: UnitMarker[]
  selectedCoord?: Coordinate | null
  interactive?: boolean
  onHexClick?: (coord: Coordinate) => void
  size?: number
}) {
  const size = props.size ?? 22

  const allCoords = new Map<string, Coordinate>()
  for (const tile of Object.values(props.board.tiles)) allCoords.set(coordKey(tile.coord), tile.coord)
  for (const c of props.extraCoords ?? []) allCoords.set(coordKey(c), c)
  for (const g of props.ghostCells ?? []) allCoords.set(coordKey(g.coord), g.coord)

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
  const minX = Math.min(...pixels.map((p) => p.x)) - pad
  const maxX = Math.max(...pixels.map((p) => p.x)) + pad
  const minY = Math.min(...pixels.map((p) => p.y)) - pad
  const maxY = Math.max(...pixels.map((p) => p.y)) + pad

  const ghostByKey = new Map((props.ghostCells ?? []).map((g) => [coordKey(g.coord), g]))

  return (
    <svg
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      className="max-h-[70vh] w-full rounded-md border border-neutral-800 bg-neutral-950"
    >
      {pixels.map(({ coord, x, y }) => {
        const tile = props.board.tiles[coordKey(coord)]
        const selected = props.selectedCoord?.q === coord.q && props.selectedCoord?.r === coord.r
        return (
          <polygon
            key={coordKey(coord)}
            points={hexPoints(x, y, size - 1)}
            fill={tile ? TERRAIN_COLOR[tile.terrain] : 'transparent'}
            stroke={selected ? '#eab308' : '#3f3f46'}
            strokeWidth={selected ? 2 : 1}
            className={props.interactive ? 'cursor-pointer hover:opacity-80' : undefined}
            onClick={props.onHexClick ? () => props.onHexClick?.(coord) : undefined}
          />
        )
      })}
      {pixels.map(({ coord, x, y }) => {
        const ghost = ghostByKey.get(coordKey(coord))
        if (!ghost) return null
        return (
          <polygon
            key={`ghost-${coordKey(coord)}`}
            points={hexPoints(x, y, size - 1)}
            fill={ghost.legal ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}
            stroke={ghost.legal ? '#22c55e' : '#ef4444'}
            strokeWidth={2}
            pointerEvents="none"
          />
        )
      })}
      {(props.units ?? []).map((unit, i) => {
        const { x, y } = axialToPixel(unit.coord, size)
        return (
          <g key={i} pointerEvents="none">
            <circle cx={x} cy={y} r={size * 0.4} fill={unit.color} stroke="#000" strokeWidth={1} />
            <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={size * 0.4} fill="#000">
              {unit.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
