import type { SpendingBreakdown } from '../engine/unitValue'
import type { PlayerRow } from '../lib/dbTypes'
import { niceMax } from './chartScale'

const WIDTH = 560
const HEIGHT = 220
const MARGIN = { top: 12, right: 12, bottom: 22, left: 28 }
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom
/** Gap between one player's bar and the next — matches ScoreCategoryChart's CLUSTER_GAP. */
const BAR_GAP = 14
/** Surface gap separating two stacked segments within the same bar — matches UnitValueChart's SEGMENT_GAP. */
const SEGMENT_GAP = 2

/** Fixed stacking order (bottom to top) and color for each way gold leaves a player's bank — first five slots of the validated categorical palette (dark-surface steps), same convention as UnitValueChart's FACTORS. */
const CATEGORIES: { key: keyof SpendingBreakdown; label: string; color: string }[] = [
  { key: 'unitCreation', label: 'Unit creation', color: '#3987e5' },
  { key: 'transform', label: 'Transform', color: '#d95926' },
  { key: 'convert', label: 'Convert', color: '#199e70' },
  { key: 'tradeResource', label: 'Resource trading', color: '#c98500' },
  { key: 'declineBuyback', label: 'Decline buyback', color: '#d55181' },
]

function formatValue(value: number): string {
  return `${Math.round(value)}`
}

/**
 * Stacked bar chart comparing every player's total gold spending, split by
 * category (issue #336 follow-up: "change [the decline buyback chart] to a
 * spending chart, stacked with the different types of spending amounts, one
 * bar per player") — unlike UnitValueChart/the unit-kind decline chart it
 * replaces, there's no secondary "unit kind" dimension here, so players
 * themselves are the clusters: each gets exactly one bar, stacked into the
 * five ways gold leaves a player's bank over the course of the game
 * (calculateGoldSpendingByCategory) — building units, transforming/converting
 * them, buying wood/stone, and buying cards back from decline.
 */
export function SpendingChart({ breakdownByPlayerId, players, playerIds }: { breakdownByPlayerId: Record<string, SpendingBreakdown>; players: PlayerRow[]; playerIds: string[] }) {
  const totalFor = (playerId: string) => CATEGORIES.reduce((sum, c) => sum + (breakdownByPlayerId[playerId]?.[c.key] ?? 0), 0)
  if (playerIds.length === 0 || !playerIds.some((id) => totalFor(id) > 0)) return null

  const maxValue = niceMax(Math.max(1, ...playerIds.map(totalFor)))
  const yFor = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / maxValue) * PLOT_HEIGHT

  const barWidth = Math.max(2, (PLOT_WIDTH - BAR_GAP * (playerIds.length - 1)) / playerIds.length)

  const gridSteps = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full text-neutral-500" role="img" aria-label="Stacked bar chart comparing each player's total gold spending by category">
        {gridSteps.map((step) => {
          const y = MARGIN.top + PLOT_HEIGHT - step * PLOT_HEIGHT
          return (
            <g key={step}>
              <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
              <text x={MARGIN.left - 6} y={y} textAnchor="end" dominantBaseline="middle" fontSize={9} fill="currentColor">
                {formatValue(maxValue * step)}
              </text>
            </g>
          )
        })}

        {playerIds.map((playerId, playerIndex) => {
          const x = MARGIN.left + playerIndex * (barWidth + BAR_GAP)
          const playerName = players.find((p) => p.id === playerId)?.display_name ?? playerId
          const total = totalFor(playerId)

          let cumulative = 0
          const segments = CATEGORIES.map((category) => ({ ...category, value: breakdownByPlayerId[playerId]?.[category.key] ?? 0 })).filter((s) => s.value > 0)

          return (
            <g key={playerId}>
              <rect x={x - BAR_GAP / 2} y={MARGIN.top} width={barWidth + BAR_GAP} height={PLOT_HEIGHT} rx={3} fill="currentColor" fillOpacity={playerIndex % 2 === 0 ? 0.04 : 0.09} />
              <text x={x + barWidth / 2} y={HEIGHT - 4} textAnchor="middle" fontSize={9} fill="currentColor">
                {playerName}
              </text>

              {segments.map((segment, segmentIndex) => {
                const segStart = cumulative
                cumulative += segment.value
                const yTop = yFor(cumulative)
                const yBottom = yFor(segStart)
                const insetTop = segmentIndex < segments.length - 1 ? SEGMENT_GAP / 2 : 0
                const insetBottom = segmentIndex > 0 ? SEGMENT_GAP / 2 : 0
                const height = Math.max(yBottom - yTop - insetTop - insetBottom, 0)
                return (
                  <rect key={segment.key} x={x} y={yTop + insetTop} width={barWidth} height={height} rx={2} fill={segment.color}>
                    <title>{`${playerName} — ${segment.label}: ${formatValue(segment.value)} gold`}</title>
                  </rect>
                )
              })}
              {total > 0 && (
                <text x={x + barWidth / 2} y={yFor(total) - 3} textAnchor="middle" fontSize={9} fill="currentColor">
                  {formatValue(total)}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
        {CATEGORIES.map((category) => (
          <span key={category.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: category.color }} />
            {category.label}
          </span>
        ))}
      </div>

      <table className="sr-only">
        <caption>Gold spending by category, per player</caption>
        <thead>
          <tr>
            <th>Player</th>
            {CATEGORIES.map((category) => (
              <th key={category.key}>{category.label}</th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {playerIds.map((playerId) => (
            <tr key={playerId}>
              <td>{players.find((p) => p.id === playerId)?.display_name ?? playerId}</td>
              {CATEGORIES.map((category) => (
                <td key={category.key}>{formatValue(breakdownByPlayerId[playerId]?.[category.key] ?? 0)}</td>
              ))}
              <td>{formatValue(totalFor(playerId))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
