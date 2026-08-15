import type { VPBreakdown } from '../engine/victoryPoints'
import type { PlayerRow } from '../lib/dbTypes'
import { scoredCategories } from './scoreCategories'

const WIDTH = 560
const HEIGHT = 220
const MARGIN = { top: 12, right: 12, bottom: 30, left: 28 }
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom
const BAR_GAP = 2

/** Rounds `value` up to a "nice" axis ceiling (1/2/5 × a power of ten) — never a jagged max like 137. */
function niceMax(value: number): number {
  if (value <= 0) return 5
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

/**
 * Grouped bar chart comparing every player's VP across each scoring
 * category — the "bar chart of the different categories" requested for the
 * end-of-game screen, laid out so categories (not players) are the
 * clusters: easiest way to compare players against each other within one
 * category at a glance. Categories no player scored anything in (e.g.
 * "Structures" outside a Tale that has any) are dropped entirely rather
 * than showing an all-zero cluster.
 */
export function ScoreCategoryChart({ breakdownByPlayerId, players, playerIds }: { breakdownByPlayerId: Record<string, VPBreakdown>; players: PlayerRow[]; playerIds: string[] }) {
  const categories = scoredCategories(breakdownByPlayerId, playerIds)
  if (categories.length === 0 || playerIds.length === 0) return null

  const maxValue = niceMax(Math.max(1, ...categories.flatMap((c) => playerIds.map((id) => breakdownByPlayerId[id]?.[c.key] ?? 0))))
  const yFor = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / maxValue) * PLOT_HEIGHT

  const clusterWidth = PLOT_WIDTH / categories.length
  const barWidth = Math.max(2, (clusterWidth - BAR_GAP * (playerIds.length + 1)) / playerIds.length)

  const gridSteps = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-neutral-200">Score by category</p>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full text-neutral-500" role="img" aria-label="Bar chart comparing each player's score by category">
        {gridSteps.map((step) => {
          const y = MARGIN.top + PLOT_HEIGHT - step * PLOT_HEIGHT
          return (
            <g key={step}>
              <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
              <text x={MARGIN.left - 6} y={y} textAnchor="end" dominantBaseline="middle" fontSize={9} fill="currentColor">
                {Math.round(maxValue * step)}
              </text>
            </g>
          )
        })}

        {categories.map((category, categoryIndex) => {
          const clusterX = MARGIN.left + categoryIndex * clusterWidth
          const values = playerIds.map((id) => breakdownByPlayerId[id]?.[category.key] ?? 0)
          const leaderValue = Math.max(...values)

          return (
            <g key={category.key}>
              <text x={clusterX + clusterWidth / 2} y={HEIGHT - 4} textAnchor="middle" fontSize={9} fill="currentColor">
                {category.label}
              </text>
              {playerIds.map((playerId, playerIndex) => {
                const value = breakdownByPlayerId[playerId]?.[category.key] ?? 0
                const color = players.find((p) => p.id === playerId)?.color ?? '#a3a3a3'
                const x = clusterX + BAR_GAP + playerIndex * (barWidth + BAR_GAP)
                const y = yFor(value)
                const height = MARGIN.top + PLOT_HEIGHT - y
                const isLeader = value === leaderValue && value > 0

                return (
                  <g key={playerId}>
                    <rect x={x} y={y} width={barWidth} height={Math.max(height, 0)} rx={2} fill={color}>
                      <title>{`${players.find((p) => p.id === playerId)?.display_name ?? playerId} — ${category.label}: ${value} point${value === 1 ? '' : 's'}`}</title>
                    </rect>
                    {isLeader && (
                      <text x={x + barWidth / 2} y={y - 3} textAnchor="middle" fontSize={9} fill="currentColor">
                        {value}
                      </text>
                    )}
                  </g>
                )
              })}
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
        <caption>Score by category, per player</caption>
        <thead>
          <tr>
            <th>Category</th>
            {playerIds.map((playerId) => (
              <th key={playerId}>{players.find((p) => p.id === playerId)?.display_name ?? playerId}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <tr key={category.key}>
              <td>{category.label}</td>
              {playerIds.map((playerId) => (
                <td key={playerId}>{breakdownByPlayerId[playerId]?.[category.key] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
