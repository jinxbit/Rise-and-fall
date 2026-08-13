import { listAchievements, listTerrainTypes } from '../content/resolveContent'
import type { AchievementContent } from '../engine/achievementContent'
import type { TaleContent } from '../engine/taleContent'
import { calculateVPDetail } from '../engine/victoryPoints'
import type { VPDetail } from '../engine/victoryPoints'
import type { GameState } from '../engine/types'
import type { PlayerRow } from '../lib/dbTypes'

const ACHIEVEMENTS = listAchievements()
const TERRAIN_TYPES = listTerrainTypes()

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function achievementName(achievementId: string): string {
  return ACHIEVEMENTS.find((a) => a.id === achievementId)?.name ?? achievementId
}

function terrainName(terrainId: string): string {
  return TERRAIN_TYPES.find((t) => t.id === terrainId)?.name ?? capitalize(terrainId)
}

function ordinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/**
 * Standard competition ranking (1224): players tied on total VP share the
 * same place, and the next distinct total skips ahead by however many
 * players are tied above it — e.g. two players tied for 1st means the next
 * player is 3rd, not 2nd. `totals` must already be sorted descending.
 */
function ranksFor(totals: number[]): number[] {
  return totals.map((total) => totals.findIndex((t) => t === total) + 1)
}

interface ScoreLine {
  label: string
  vp: number
}

/**
 * Flattens a player's VPDetail into "what they have: the points it's worth"
 * lines — e.g. "4 Forest: 12 points", "City Mastery: 5 points" — the format
 * requested for the end-of-game screen, rather than just a per-source
 * total. Zero-quantity sources (no achievements claimed, no board-count/
 * terrain-control presence, no gold) contribute no line at all; a source
 * the player *does* have something in still gets a line even if it happens
 * to be worth 0 points, since the point is showing what they have.
 */
function scoreLinesFor(detail: VPDetail): ScoreLine[] {
  const lines: ScoreLine[] = []
  for (const achievement of detail.achievements) {
    lines.push({ label: achievementName(achievement.achievementId), vp: achievement.vp })
  }
  for (const boardCount of detail.boardCount) {
    lines.push({ label: `${boardCount.count} ${capitalize(boardCount.kind)}${boardCount.count === 1 ? '' : 's'}`, vp: boardCount.vp })
  }
  for (const terrainControl of detail.terrainControl) {
    lines.push({ label: `${terrainControl.hexCount} ${terrainName(terrainControl.terrain)}`, vp: terrainControl.vp })
  }
  if (detail.gold.amount > 0) {
    lines.push({ label: `${detail.gold.amount} Gold`, vp: detail.gold.vp })
  }
  for (const structure of detail.controllableStructures) {
    lines.push({ label: structure.name, vp: structure.vp })
  }
  return lines
}

/**
 * The end-of-game screen: every player, ranked by final total VP, with a
 * full breakdown of what that total is made of — not just the bottom line,
 * but each thing they have and the points it's worth (calculateVPDetail).
 * Winner(s) — everyone tied for the highest total, per the "no tiebreaker"
 * rule (GameState.winnerPlayerIds, already computed once by finishRound())
 * — are highlighted.
 */
export function EndGameView({
  state,
  players,
  achievementContent,
  taleContent,
}: {
  state: GameState
  players: PlayerRow[]
  achievementContent: AchievementContent
  taleContent: TaleContent
}) {
  const detailByPlayerId = calculateVPDetail(state, achievementContent, taleContent)
  const winnerIds = new Set(state.winnerPlayerIds)

  const ranked = [...state.players].sort((a, b) => (detailByPlayerId[b.id]?.total ?? 0) - (detailByPlayerId[a.id]?.total ?? 0))
  const positions = ranksFor(ranked.map((player) => detailByPlayerId[player.id]?.total ?? 0))

  return (
    <div className="flex flex-col gap-4 rounded-md border border-amber-700/50 bg-amber-500/10 p-4">
      <div>
        <p className="text-lg font-semibold text-amber-300">Game over</p>
        <p className="text-sm text-amber-300/90">
          Winner{state.winnerPlayerIds.length > 1 ? 's' : ''}:{' '}
          {state.winnerPlayerIds.map((id) => players.find((p) => p.id === id)?.display_name ?? id).join(', ') || 'none'}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {ranked.map((player, i) => {
          const row = players.find((p) => p.id === player.id)
          const detail = detailByPlayerId[player.id]
          const isWinner = winnerIds.has(player.id)
          const lines = detail ? scoreLinesFor(detail) : []

          return (
            <div key={player.id} className={`rounded-md border p-3 ${isWinner ? 'border-amber-500/60 bg-amber-500/5' : 'border-neutral-800'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row?.color ?? '#a3a3a3' }} />
                  <span className={isWinner ? 'font-semibold text-amber-200' : 'font-medium text-neutral-200'}>{row?.display_name ?? player.id}</span>
                  {isWinner && <span title="Winner">🏆</span>}
                  {player.eliminated && <span className="text-xs text-neutral-500">(eliminated)</span>}
                </span>
                <span className={`text-sm ${isWinner ? 'font-semibold text-amber-200' : 'font-medium text-neutral-200'}`}>
                  {detail?.total ?? 0} point{detail?.total === 1 ? '' : 's'}
                </span>
              </div>
              <p className="pl-4 text-xs text-neutral-500">{ordinal(positions[i])} place</p>

              {lines.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-0.5 pl-4 text-xs text-neutral-400">
                  {lines.map((line, i) => (
                    <li key={i} className="list-disc">
                      {line.label}: <span className="text-neutral-300">{line.vp} point{line.vp === 1 ? '' : 's'}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 pl-4 text-xs text-neutral-500">No points scored</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
