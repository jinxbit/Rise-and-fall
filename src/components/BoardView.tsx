import type { Board } from '../engine/types'

/**
 * Placeholder board renderer. Draws each tile as a plain square keyed by
 * grid position — enough to confirm the board data flows from GameState
 * into the UI. Real hex/square tile art and interaction come in the next
 * milestone.
 */
export function BoardView(props: { board: Board }) {
  const tiles = Object.values(props.board.tiles)

  if (tiles.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border border-dashed border-neutral-700 text-neutral-500">
        Board has not been generated yet.
      </div>
    )
  }

  const qs = tiles.map((t) => t.coord.q)
  const rs = tiles.map((t) => t.coord.r)
  const minQ = Math.min(...qs)
  const minR = Math.min(...rs)

  const TERRAIN_COLOR: Record<string, string> = {
    water: 'bg-sky-800',
    plain: 'bg-lime-800',
    forest: 'bg-emerald-800',
    mountain: 'bg-stone-600',
    glacier: 'bg-cyan-100',
  }

  return (
    <div
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${Math.max(...qs) - minQ + 1}, minmax(2rem, 1fr))` }}
    >
      {tiles.map((tile) => (
        <div
          key={tile.id}
          title={`${tile.terrain} (${tile.coord.q}, ${tile.coord.r})`}
          className={`aspect-square rounded-sm ${TERRAIN_COLOR[tile.terrain] ?? 'bg-neutral-700'}`}
          style={{
            gridColumn: tile.coord.q - minQ + 1,
            gridRow: tile.coord.r - minR + 1,
          }}
        />
      ))}
    </div>
  )
}
