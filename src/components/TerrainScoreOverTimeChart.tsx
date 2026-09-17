import type { ScoreSnapshot } from '../engine/scoreHistory'
import type { PlayerRow } from '../lib/dbTypes'
import { niceMax } from './chartScale'

const WIDTH = 560
const HEIGHT = 220
const MARGIN = { top: 12, right: 12, bottom: 24, left: 28 }
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom

/**
 * Line chart of each player's terrain-control VP across every round of the
 * game — the "terrain score over time" graph requested for the end-of-game
 * screen (issue #614), alongside the existing "total score over time" and
 * "gold over time" charts (ScoreOverTimeChart.tsx, GoldOverTimeChart.tsx).
 * Shares those components' data source (ScoreSnapshot, ./engine/scoreHistory.ts
 * — one snapshot per round boundary, plus a final one for a mid-round finish)
 * and visual conventions (plain SVG, one fixed color per player using their
 * existing seat color, a legend, a `<title>` per point for a hover tooltip),
 * kept as its own component rather than a generalized one, matching this
 * codebase's existing convention of one component per chart (see
 * GoldOverTimeChart.tsx's own doc comment for why). The Y axis ceiling
 * defaults to this chart's own highest value (niceMax), but a caller
 * plotting it alongside the other "over time" charts (EndGameView.tsx) can
 * pass `maxValue` to force a shared ceiling across all of them, so their
 * scales are directly comparable (issue #618).
 */
export function TerrainScoreOverTimeChart({
  history,
  players,
  playerIds,
  maxValue,
}: {
  history: ScoreSnapshot[]
  players: PlayerRow[]
  playerIds: string[]
  /** Overrides the Y axis ceiling (see doc comment above) — omit to derive it from this chart's own series. */
  maxValue?: number
}) {
  if (history.length < 2) return null

  const maxTerrainVP = maxValue ?? niceMax(Math.max(1, ...history.flatMap((snapshot) => playerIds.map((id) => snapshot.terrainVPByPlayerId[id] ?? 0))))
  const xFor = (index: number) => MARGIN.left + (history.length === 1 ? PLOT_WIDTH / 2 : (index / (history.length - 1)) * PLOT_WIDTH)
  const yFor = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / maxTerrainVP) * PLOT_HEIGHT

  // Round labels are thinned out once there are too many to fit without overlapping.
  const labelStride = Math.max(1, Math.ceil(history.length / 8))
  const gridSteps = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-neutral-200">Terrain score over time</p>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full text-neutral-500" role="img" aria-label="Line chart of each player's terrain-control score by round">
        {gridSteps.map((step) => {
          const y = MARGIN.top + PLOT_HEIGHT - step * PLOT_HEIGHT
          return (
            <g key={step}>
              <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
              <text x={MARGIN.left - 6} y={y} textAnchor="end" dominantBaseline="middle" fontSize={9} fill="currentColor">
                {Math.round(maxTerrainVP * step)}
              </text>
            </g>
          )
        })}

        {history.map((snapshot, index) =>
          index % labelStride === 0 || index === history.length - 1 ? (
            <text key={snapshot.turn} x={xFor(index)} y={HEIGHT - 4} textAnchor="middle" fontSize={9} fill="currentColor">
              R{snapshot.turn}
            </text>
          ) : null,
        )}

        {playerIds.map((playerId) => {
          const color = players.find((p) => p.id === playerId)?.color ?? '#a3a3a3'
          const points = history.map((snapshot, index) => ({
            x: xFor(index),
            y: yFor(snapshot.terrainVPByPlayerId[playerId] ?? 0),
            value: snapshot.terrainVPByPlayerId[playerId] ?? 0,
            turn: snapshot.turn,
          }))
          return (
            <g key={playerId}>
              <polyline points={points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              {points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={3} fill={color}>
                  <title>{`${players.find((pl) => pl.id === playerId)?.display_name ?? playerId} — ${p.value} point${p.value === 1 ? '' : 's'} (round ${p.turn})`}</title>
                </circle>
              ))}
            </g>
          )
        })}
      </svg>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
        {playerIds.map((playerId) => {
          const row = players.find((p) => p.id === playerId)
          return (
            <span key={playerId} className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row?.color ?? '#a3a3a3' }} />
              {row?.display_name ?? playerId}
            </span>
          )
        })}
      </div>

      <table className="sr-only">
        <caption>Terrain score by round, per player</caption>
        <thead>
          <tr>
            <th>Round</th>
            {playerIds.map((playerId) => (
              <th key={playerId}>{players.find((p) => p.id === playerId)?.display_name ?? playerId}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {history.map((snapshot) => (
            <tr key={snapshot.turn}>
              <td>{snapshot.turn}</td>
              {playerIds.map((playerId) => (
                <td key={playerId}>{snapshot.terrainVPByPlayerId[playerId] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
