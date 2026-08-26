import { UNIT_KINDS } from '../engine/cards'
import type { DeclinePurchaseDetail } from '../engine/unitValue'
import type { PlayerRow } from '../lib/dbTypes'
import { niceMax } from './chartScale'
import { UnitIcon } from './UnitIcon'

const WIDTH = 560
const HEIGHT = 220
const MARGIN = { top: 12, right: 12, bottom: 34, left: 28 }
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom
/** Gap between bars within the same unit kind's cluster — matches UnitValueChart's BAR_GAP. */
const BAR_GAP = 2
/** Gap between one unit kind's cluster and the next — matches UnitValueChart's CLUSTER_GAP. */
const CLUSTER_GAP = 14

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Rounds to 1 decimal place for display — `vp` is a fractional VP-equivalent (see calculateDeclinePurchaseDetail), and a whole number would silently hide the split. */
function formatValue(value: number): string {
  return Math.round(value * 10) / 10 === Math.round(value) ? `${Math.round(value)}` : (Math.round(value * 10) / 10).toString()
}

/**
 * Bar chart comparing every player's gold spent buying cards back from
 * decline, per unit kind, expressed in VP-equivalent points (issue #336
 * follow-up) — laid out like UnitValueChart (unit kinds as clusters, one bar
 * per player within a cluster) but each bar is a single flat value rather
 * than a stack, since there's only one factor here. `kinds` is derived from
 * whatever kinds actually appear in the data (UNIT_KINDS first, for a
 * stable/familiar order, then any Tale-only kind found — e.g. a Tale's
 * Capital or Cathedral card can also sit in decline) rather than filtering
 * UNIT_KINDS directly, so a Tale-only kind's spend is never silently dropped.
 */
export function DeclinePurchaseChart({ detailByPlayerId, players, playerIds }: { detailByPlayerId: Record<string, DeclinePurchaseDetail[]>; players: PlayerRow[]; playerIds: string[] }) {
  const presentKinds = new Set(playerIds.flatMap((id) => (detailByPlayerId[id] ?? []).filter((d) => d.vp > 0).map((d) => d.kind)))
  const kinds = [...UNIT_KINDS.filter((kind) => presentKinds.has(kind)), ...[...presentKinds].filter((kind) => !(UNIT_KINDS as readonly string[]).includes(kind))]
  if (kinds.length === 0 || playerIds.length === 0) return null

  const detailFor = (playerId: string, kind: string): DeclinePurchaseDetail | undefined => detailByPlayerId[playerId]?.find((d) => d.kind === kind)

  const maxValue = niceMax(Math.max(1, ...kinds.flatMap((kind) => playerIds.map((id) => detailFor(id, kind)?.vp ?? 0))))
  const yFor = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / maxValue) * PLOT_HEIGHT

  const clusterWidth = (PLOT_WIDTH - CLUSTER_GAP * (kinds.length - 1)) / kinds.length
  const barWidth = Math.max(2, (clusterWidth - BAR_GAP * (playerIds.length + 1)) / playerIds.length)

  const gridSteps = [0, 0.25, 0.5, 0.75, 1]
  const iconSize = 16

  return (
    <div className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full text-neutral-500" role="img" aria-label="Bar chart comparing each player's VP-equivalent gold spent buying cards back from decline, by unit kind">
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

          return (
            <g key={kind}>
              <rect x={clusterX - BAR_GAP} y={MARGIN.top} width={clusterWidth + BAR_GAP * 2} height={PLOT_HEIGHT} rx={3} fill="currentColor" fillOpacity={kindIndex % 2 === 0 ? 0.04 : 0.09} />
              <svg x={clusterX + clusterWidth / 2 - iconSize / 2} y={HEIGHT - MARGIN.bottom + 6} width={iconSize} height={iconSize}>
                <UnitIcon kind={kind} className="h-full w-full" title={capitalize(kind)} />
              </svg>

              {playerIds.map((playerId, playerIndex) => {
                const detail = detailFor(playerId, kind)
                const value = detail?.vp ?? 0
                const color = players.find((p) => p.id === playerId)?.color ?? '#a3a3a3'
                const playerName = players.find((p) => p.id === playerId)?.display_name ?? playerId
                const x = clusterX + BAR_GAP + playerIndex * (barWidth + BAR_GAP)
                const y = yFor(value)
                const height = MARGIN.top + PLOT_HEIGHT - y

                return (
                  <g key={playerId}>
                    <rect x={x} y={y} width={barWidth} height={Math.max(height, 0)} rx={2} fill={color}>
                      <title>{`${playerName} — ${capitalize(kind)}: ${formatValue(value)} point${value === 1 ? '' : 's'} (${formatValue(detail?.cost ?? 0)} gold)`}</title>
                    </rect>
                    {value > 0 && (
                      <text x={x + barWidth / 2} y={y - 3} textAnchor="middle" fontSize={9} fill="currentColor">
                        {formatValue(value)}
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
        <caption>VP-equivalent gold spent buying cards back from decline, by unit kind, per player</caption>
        <thead>
          <tr>
            <th>Player</th>
            <th>Unit kind</th>
            <th>Gold spent</th>
            <th>VP-equivalent</th>
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
                  <td>{detail?.cost ?? 0}</td>
                  <td>{formatValue(detail?.vp ?? 0)}</td>
                </tr>
              )
            }),
          )}
        </tbody>
      </table>
    </div>
  )
}
