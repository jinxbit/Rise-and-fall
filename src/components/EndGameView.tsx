import { listAchievements, listTerrainTypes } from '../content/resolveContent'
import type { AchievementContent } from '../engine/achievementContent'
import type { TaleContent } from '../engine/taleContent'
import { calculateVPDetail } from '../engine/victoryPoints'
import type { VPDetail } from '../engine/victoryPoints'
import type { GameState } from '../engine/types'
import type { PlayerRow } from '../lib/dbTypes'
import type { UnitMarker } from './HexBoard'
import { HexBoard } from './HexBoard'
import { UnitIcon } from './UnitIcon'

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

/** "1st"/"2nd"/"3rd"/"4th"... — 11th/12th/13th stay "-th" (the usual English exception to the mod-10 rule). */
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
 * Standard competition ranking ("1224" ranking): players tied on total VP
 * share the same place, and whoever's next skips ahead by however many are
 * tied above them (e.g. two players tied for 1st -> the next player is 3rd,
 * not 2nd) — consistent with this game's "no tiebreaker" win rule, where
 * tied totals really do share a result rather than one arbitrarily coming
 * out ahead. `ranked` must already be sorted by descending total.
 */
function ranksFor(ranked: { id: string }[], totalOf: (id: string) => number): Map<string, number> {
  const ranks = new Map<string, number>()
  let place = 1
  for (let i = 0; i < ranked.length; i++) {
    if (i > 0 && totalOf(ranked[i].id) !== totalOf(ranked[i - 1].id)) place = i + 1
    ranks.set(ranked[i].id, place)
  }
  return ranks
}

/** Every unit `playerId` has on the board, grouped by kind — the "what did they build" half of their end-game player details, alongside resources. */
function unitCountsFor(state: GameState, playerId: string): { kind: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const unit of state.units) {
    if (unit.ownerId !== playerId) continue
    counts.set(unit.kind, (counts.get(unit.kind) ?? 0) + 1)
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }))
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
  const ranks = ranksFor(ranked, (id) => detailByPlayerId[id]?.total ?? 0)

  const boardUnits: UnitMarker[] = state.units.map((unit) => ({
    coord: unit.coord,
    color: players.find((p) => p.id === unit.ownerId)?.color ?? '#a3a3a3',
    kind: unit.kind,
  }))

  return (
    <div className="flex flex-col gap-4 rounded-md border border-amber-700/50 bg-amber-500/10 p-4">
      <div>
        <p className="text-lg font-semibold text-amber-300">Game over</p>
        <p className="text-sm text-amber-300/90">
          Winner{state.winnerPlayerIds.length > 1 ? 's' : ''}:{' '}
          {state.winnerPlayerIds.map((id) => players.find((p) => p.id === id)?.display_name ?? id).join(', ') || 'none'}
        </p>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-neutral-200">Final board</p>
        <HexBoard board={state.board} units={boardUnits} />
      </div>

      <div className="flex flex-col gap-3">
        {ranked.map((player) => {
          const row = players.find((p) => p.id === player.id)
          const detail = detailByPlayerId[player.id]
          const isWinner = winnerIds.has(player.id)
          const lines = detail ? scoreLinesFor(detail) : []
          const unitCounts = unitCountsFor(state, player.id)

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
              <p className="text-xs text-neutral-500">{ordinal(ranks.get(player.id) ?? ranked.length)} place</p>

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

              <p className="mt-2 pl-4 text-xs text-neutral-400">
                Resources: {player.resources.gold} Gold, {player.resources.wood} Wood, {player.resources.stone} Stone
              </p>
              {unitCounts.length > 0 && (
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-xs text-neutral-400">
                  Units:
                  {unitCounts.map(({ kind, count }) => (
                    <span key={kind} className="inline-flex items-center gap-1" title={capitalize(kind)}>
                      <UnitIcon kind={kind} className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                      <span>{count}</span>
                    </span>
                  ))}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
