import { UNIT_KINDS } from '../engine/cards'
import type { UnitValueBreakdown, UnitValueDetail } from '../engine/unitValue'
import type { PlayerRow } from '../lib/dbTypes'
import { niceMax } from './chartScale'
import { UnitIcon } from './UnitIcon'

const WIDTH = 560
const HEIGHT = 240
const MARGIN = { top: 12, right: 12, bottom: 44, left: 28 }
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom
/** Gap between bars within the same unit kind's cluster — matches ScoreCategoryChart's BAR_GAP. */
const BAR_GAP = 2
/** Gap between one unit kind's cluster and the next — matches ScoreCategoryChart's CLUSTER_GAP. */
const CLUSTER_GAP = 14
/** Surface gap separating two stacked segments within the same bar (dataviz skill's "surface gap" spacer). */
const SEGMENT_GAP = 2

/** Fixed stacking order (bottom to top) and color for each of the four factors issue #335 asks the stacked bar to distinguish — first four slots of the validated categorical palette (dark-surface steps, this app being dark-themed throughout). */
const FACTORS: { key: keyof UnitValueBreakdown; label: string; color: string }[] = [
  { key: 'achievement', label: 'Achievement', color: '#3987e5' },
  { key: 'presence', label: 'Presence', color: '#d95926' },
  { key: 'territoryControl', label: 'Territory control', color: '#199e70' },
  { key: 'goldProduced', label: 'Gold produced', color: '#c98500' },
]

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Rounds to 1 decimal place for display — territoryControl/goldProduced are fractional VP-equivalents (see calculateUnitValueDetail), and a whole number would silently hide the split. */
function formatValue(value: number): string {
  return Math.round(value * 10) / 10 === Math.round(value) ? `${Math.round(value)}` : (Math.round(value * 10) / 10).toString()
}

/**
 * Stacked bar chart comparing every player's "unit value" (issue #335) per
 * unit kind — how much each of achievement/presence/territory-control/gold
 * production actually contributed to a kind's worth. Laid out like
 * ScoreCategoryChart (unit kinds as clusters, one bar per player within a
 * cluster), except each bar is itself a stack of the four factors instead of
 * one solid player color, since color here carries factor identity, not
 * player identity — a small dot in the player's own color sits just under
 * each bar so it can still be matched back to a player without relying on
 * position alone.
 */
export function UnitValueChart({ detailByPlayerId, players, playerIds }: { detailByPlayerId: Record<string, UnitValueDetail[]>; players: PlayerRow[]; playerIds: string[] }) {
  const kinds = UNIT_KINDS.filter((kind) => playerIds.some((id) => (detailByPlayerId[id] ?? []).some((d) => d.kind === kind && d.total > 0)))
  if (kinds.length === 0 || playerIds.length === 0) return null

  const detailFor = (playerId: string, kind: string): UnitValueDetail | undefined => detailByPlayerId[playerId]?.find((d) => d.kind === kind)

  const maxValue = niceMax(Math.max(1, ...kinds.flatMap((kind) => playerIds.map((id) => detailFor(id, kind)?.total ?? 0))))
  const yFor = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / maxValue) * PLOT_HEIGHT

  const clusterWidth = (PLOT_WIDTH - CLUSTER_GAP * (kinds.length - 1)) / kinds.length
  const barWidth = Math.max(2, (clusterWidth - BAR_GAP * (playerIds.length + 1)) / playerIds.length)

  const gridSteps = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full text-neutral-500" role="img" aria-label="Stacked bar chart comparing each player's unit value by unit kind">
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

        {kinds.map((kind, kindIndex) => {
          const clusterX = MARGIN.left + kindIndex * (clusterWidth + CLUSTER_GAP)
          const iconSize = 16

          return (
            <g key={kind}>
              <rect x={clusterX - BAR_GAP} y={MARGIN.top} width={clusterWidth + BAR_GAP * 2} height={PLOT_HEIGHT} rx={3} fill="currentColor" fillOpacity={kindIndex % 2 === 0 ? 0.04 : 0.09} />
              <svg x={clusterX + clusterWidth / 2 - iconSize / 2} y={HEIGHT - MARGIN.bottom + 9} width={iconSize} height={iconSize}>
                <UnitIcon kind={kind} className="h-full w-full" title={capitalize(kind)} />
              </svg>

              {playerIds.map((playerId, playerIndex) => {
                const detail = detailFor(playerId, kind)
                const total = detail?.total ?? 0
                const x = clusterX + BAR_GAP + playerIndex * (barWidth + BAR_GAP)
                const playerColor = players.find((p) => p.id === playerId)?.color ?? '#a3a3a3'
                const playerName = players.find((p) => p.id === playerId)?.display_name ?? playerId

                let cumulative = 0
                const segments = FACTORS.map((factor) => ({ ...factor, value: detail?.breakdown[factor.key] ?? 0 })).filter((s) => s.value > 0)

                return (
                  <g key={playerId}>
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
                          <title>{`${playerName} — ${capitalize(kind)} — ${segment.label}: ${formatValue(segment.value)} point${segment.value === 1 ? '' : 's'}`}</title>
                        </rect>
                      )
                    })}
                    <circle cx={x + barWidth / 2} cy={HEIGHT - MARGIN.bottom + 5} r={2} fill={playerColor} />
                    {total > 0 && (
                      <text x={x + barWidth / 2} y={yFor(total) - 3} textAnchor="middle" fontSize={9} fill="currentColor">
                        {formatValue(total)}
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
        {FACTORS.map((factor) => (
          <span key={factor.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: factor.color }} />
            {factor.label}
          </span>
        ))}
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
        <caption>Unit value by unit kind, per player, split by achievement, presence, territory control, and gold produced</caption>
        <thead>
          <tr>
            <th>Player</th>
            <th>Unit kind</th>
            {FACTORS.map((factor) => (
              <th key={factor.key}>{factor.label}</th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {playerIds.map((playerId) =>
            kinds.map((kind) => {
              const detail = detailFor(playerId, kind)
              return (
                <tr key={`${playerId}-${kind}`}>
                  <td>{players.find((p) => p.id === playerId)?.display_name ?? playerId}</td>
                  <td>{capitalize(kind)}</td>
                  {FACTORS.map((factor) => (
                    <td key={factor.key}>{formatValue(detail?.breakdown[factor.key] ?? 0)}</td>
                  ))}
                  <td>{formatValue(detail?.total ?? 0)}</td>
                </tr>
              )
            }),
          )}
        </tbody>
      </table>
    </div>
  )
}
