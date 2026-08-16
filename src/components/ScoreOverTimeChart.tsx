import type { AchievementClaimEvent, ScoreSnapshot } from '../engine/scoreHistory'
import type { PlayerRow } from '../lib/dbTypes'
import { niceMax } from './chartScale'

const WIDTH = 560
const HEIGHT = 220
const MARGIN = { top: 12, right: 12, bottom: 24, left: 28 }
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom
/** Horizontal spacing between two markers landing on the same round, so simultaneous claims don't draw as one indistinguishable line. */
const MARKER_OFFSET = 4

/**
 * Line chart of each player's total VP across every round of the game — the
 * "total player score over time" graph requested for the end-of-game screen.
 * Built as plain SVG (no charting library in this project): thin 2px lines
 * with rounded ends, one fixed color per player (their existing seat color,
 * the same identity color already used everywhere else on this screen —
 * not a separately-invented chart palette), a legend since there's always
 * more than one series, and a `<title>` per point for a native hover
 * tooltip with the exact value. The Y axis ceiling is always derived from
 * the highest total actually reached in the game (via niceMax), so it never
 * wastes space scaling to some larger fixed maximum.
 */
export function ScoreOverTimeChart({
  history,
  players,
  playerIds,
  achievementClaims = [],
  achievementName,
}: {
  history: ScoreSnapshot[]
  players: PlayerRow[]
  playerIds: string[]
  /** Rounds where an achievement was claimed (./engine/scoreHistory.ts) — rendered as a thin vertical line, colored as the claiming player, at that round's x-position. Omitted/empty simply skips this overlay. */
  achievementClaims?: AchievementClaimEvent[]
  /** Resolves an achievementId to its display name for the marker's hover tooltip — required whenever `achievementClaims` is non-empty. */
  achievementName?: (achievementId: string) => string
}) {
  if (history.length < 2) return null

  const maxTotal = niceMax(Math.max(1, ...history.flatMap((snapshot) => playerIds.map((id) => snapshot.totalByPlayerId[id] ?? 0))))
  const xFor = (index: number) => MARGIN.left + (history.length === 1 ? PLOT_WIDTH / 2 : (index / (history.length - 1)) * PLOT_WIDTH)
  const yFor = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / maxTotal) * PLOT_HEIGHT
  const xForTurn = (turn: number) => {
    const index = history.findIndex((snapshot) => snapshot.turn === turn)
    return index === -1 ? null : xFor(index)
  }

  // Round labels are thinned out once there are too many to fit without overlapping.
  const labelStride = Math.max(1, Math.ceil(history.length / 8))
  const gridSteps = [0, 0.25, 0.5, 0.75, 1]

  // Group claims by round so simultaneous claims can be spread out rather than drawn as one overlapping line.
  const claimsByTurn = new Map<number, AchievementClaimEvent[]>()
  for (const claim of achievementClaims) {
    const list = claimsByTurn.get(claim.turn) ?? []
    claimsByTurn.set(claim.turn, list)
    list.push(claim)
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-neutral-200">Total score over time</p>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full text-neutral-500" role="img" aria-label="Line chart of each player's total score by round">
        {gridSteps.map((step) => {
          const y = MARGIN.top + PLOT_HEIGHT - step * PLOT_HEIGHT
          return (
            <g key={step}>
              <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
              <text x={MARGIN.left - 6} y={y} textAnchor="end" dominantBaseline="middle" fontSize={9} fill="currentColor">
                {Math.round(maxTotal * step)}
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

        {[...claimsByTurn.entries()].map(([turn, claims]) => {
          const baseX = xForTurn(turn)
          if (baseX === null) return null
          const spread = (claims.length - 1) * MARKER_OFFSET
          return claims.map((claim, i) => {
            const color = players.find((p) => p.id === claim.playerId)?.color ?? '#a3a3a3'
            const x = baseX - spread / 2 + i * MARKER_OFFSET
            const playerName = players.find((p) => p.id === claim.playerId)?.display_name ?? claim.playerId
            return (
              <line key={claim.achievementId} x1={x} x2={x} y1={MARGIN.top} y2={MARGIN.top + PLOT_HEIGHT} stroke={color} strokeWidth={1.5} strokeDasharray="3 2" strokeOpacity={0.85}>
                <title>{`${achievementName?.(claim.achievementId) ?? claim.achievementId} — claimed by ${playerName} (round ${turn})`}</title>
              </line>
            )
          })
        })}

        {playerIds.map((playerId) => {
          const color = players.find((p) => p.id === playerId)?.color ?? '#a3a3a3'
          const points = history.map((snapshot, index) => ({ x: xFor(index), y: yFor(snapshot.totalByPlayerId[playerId] ?? 0), value: snapshot.totalByPlayerId[playerId] ?? 0, turn: snapshot.turn }))
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
        <caption>Total score by round, per player</caption>
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
                <td key={playerId}>{snapshot.totalByPlayerId[playerId] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
