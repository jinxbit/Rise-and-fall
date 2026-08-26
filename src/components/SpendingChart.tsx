import type { DeclineBuybackPurchase, SpendingBreakdown } from '../engine/unitValue'
import type { PlayerRow } from '../lib/dbTypes'
import { niceMax } from './chartScale'
import { UnitIcon } from './UnitIcon'

const WIDTH = 560
const HEIGHT = 220
const MARGIN = { top: 12, right: 12, bottom: 26, left: 28 }
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom
/** Gap between one player's bar and the next — matches ScoreCategoryChart's CLUSTER_GAP. */
const BAR_GAP = 14
/** Surface gap separating two stacked segments within the same bar — matches UnitValueChart's SEGMENT_GAP. */
const SEGMENT_GAP = 2

/** Fixed stacking order (bottom to top) and color for the four non-decline spending categories — first four slots of the validated categorical palette (dark-surface steps), same convention as UnitValueChart's FACTORS. */
const CATEGORIES: { key: 'unitCreation' | 'transform' | 'convert' | 'tradeResource'; label: string; color: string }[] = [
  { key: 'unitCreation', label: 'Unit creation', color: '#3987e5' },
  { key: 'transform', label: 'Transform', color: '#d95926' },
  { key: 'convert', label: 'Convert', color: '#199e70' },
  { key: 'tradeResource', label: 'Resource trading', color: '#c98500' },
]
/** Shared by every individual decline-buyback segment (fifth palette slot) — each purchase gets its own segment (stacked on top, in purchase order) rather than one summed segment, so a card bought back more than once shows up that many times, distinguished by its own icon. */
const DECLINE_BUYBACK_COLOR = '#d55181'
const DECLINE_BUYBACK_LABEL = 'Decline buyback'

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function declineTotal(purchases: DeclineBuybackPurchase[]): number {
  return purchases.reduce((sum, purchase) => sum + purchase.cost, 0)
}

/** Rounds to 1 decimal place for display — every value here is a VP-equivalent (see calculateGoldSpendingByCategory), and a whole number would silently hide fractional spending. */
function formatValue(value: number): string {
  return Math.round(value * 10) / 10 === Math.round(value) ? `${Math.round(value)}` : (Math.round(value * 10) / 10).toString()
}

interface Segment {
  key: string
  label: string
  color: string
  value: number
  kind: string | null
}

/**
 * Stacked bar chart comparing every player's total gold spending, in
 * VP-equivalent points, split by category (issue #336 follow-ups) — one bar
 * per player, stacked into the four non-decline spending categories plus one
 * segment per decline-card purchase (rather than one summed decline segment),
 * each carrying its bought-back card's icon so repeated buybacks of the same
 * kind are each individually visible. Players are identified by a colored
 * dot under their bar plus a legend below (like UnitValueChart), not a text
 * label, since a category's color already occupies the bar itself.
 */
export function SpendingChart({ breakdownByPlayerId, players, playerIds }: { breakdownByPlayerId: Record<string, SpendingBreakdown>; players: PlayerRow[]; playerIds: string[] }) {
  const totalFor = (playerId: string) => {
    const breakdown = breakdownByPlayerId[playerId]
    if (!breakdown) return 0
    return CATEGORIES.reduce((sum, c) => sum + breakdown[c.key], 0) + declineTotal(breakdown.declineBuybacks)
  }
  if (playerIds.length === 0 || !playerIds.some((id) => totalFor(id) > 0)) return null

  const maxValue = niceMax(Math.max(1, ...playerIds.map(totalFor)))
  const yFor = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / maxValue) * PLOT_HEIGHT

  const barWidth = Math.max(2, (PLOT_WIDTH - BAR_GAP * (playerIds.length - 1)) / playerIds.length)

  const gridSteps = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full text-neutral-500"
        role="img"
        aria-label="Stacked bar chart comparing each player's total gold spending, in victory-point-equivalent points, by category"
      >
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
          const playerColor = players.find((p) => p.id === playerId)?.color ?? '#a3a3a3'
          const playerName = players.find((p) => p.id === playerId)?.display_name ?? playerId
          const breakdown = breakdownByPlayerId[playerId]
          const total = totalFor(playerId)

          const segments: Segment[] = [
            ...CATEGORIES.map((c) => ({ key: c.key, label: c.label, color: c.color, value: breakdown?.[c.key] ?? 0, kind: null })),
            ...(breakdown?.declineBuybacks ?? []).map((purchase, i) => ({
              key: `decline-${i}`,
              label: `${DECLINE_BUYBACK_LABEL} — ${capitalize(purchase.kind)}`,
              color: DECLINE_BUYBACK_COLOR,
              value: purchase.cost,
              kind: purchase.kind,
            })),
          ].filter((s) => s.value > 0)

          let cumulative = 0

          return (
            <g key={playerId}>
              <rect x={x - BAR_GAP / 2} y={MARGIN.top} width={barWidth + BAR_GAP} height={PLOT_HEIGHT} rx={3} fill="currentColor" fillOpacity={playerIndex % 2 === 0 ? 0.04 : 0.09} />

              {segments.map((segment, segmentIndex) => {
                const segStart = cumulative
                cumulative += segment.value
                const yTop = yFor(cumulative)
                const yBottom = yFor(segStart)
                const insetTop = segmentIndex < segments.length - 1 ? SEGMENT_GAP / 2 : 0
                const insetBottom = segmentIndex > 0 ? SEGMENT_GAP / 2 : 0
                const height = Math.max(yBottom - yTop - insetTop - insetBottom, 0)
                const iconSize = Math.min(barWidth - 4, height - 2, 12)
                return (
                  <g key={segment.key}>
                    <rect x={x} y={yTop + insetTop} width={barWidth} height={height} rx={2} fill={segment.color}>
                      <title>{`${playerName} — ${segment.label}: ${formatValue(segment.value)} point${segment.value === 1 ? '' : 's'}`}</title>
                    </rect>
                    {segment.kind && iconSize >= 8 && (
                      <svg
                        x={x + barWidth / 2 - iconSize / 2}
                        y={yTop + insetTop + (height - iconSize) / 2}
                        width={iconSize}
                        height={iconSize}
                        className="pointer-events-none text-white"
                      >
                        <UnitIcon kind={segment.kind} className="h-full w-full" />
                      </svg>
                    )}
                  </g>
                )
              })}

              <circle cx={x + barWidth / 2} cy={HEIGHT - MARGIN.bottom + 9} r={3} fill={playerColor} />
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
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: DECLINE_BUYBACK_COLOR }} />
          {DECLINE_BUYBACK_LABEL}
        </span>
      </div>
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
        <caption>Gold spending by category, in victory-point-equivalent points, per player</caption>
        <thead>
          <tr>
            <th>Player</th>
            {CATEGORIES.map((category) => (
              <th key={category.key}>{category.label}</th>
            ))}
            <th>{DECLINE_BUYBACK_LABEL}</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {playerIds.map((playerId) => {
            const breakdown = breakdownByPlayerId[playerId]
            return (
              <tr key={playerId}>
                <td>{players.find((p) => p.id === playerId)?.display_name ?? playerId}</td>
                {CATEGORIES.map((category) => (
                  <td key={category.key}>{formatValue(breakdown?.[category.key] ?? 0)}</td>
                ))}
                <td>{formatValue(declineTotal(breakdown?.declineBuybacks ?? []))}</td>
                <td>{formatValue(totalFor(playerId))}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
