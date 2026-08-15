import { listAchievements, listTerrainTypes } from '../content/resolveContent'
import type { AchievementContent } from '../engine/achievementContent'
import type { ScoreSnapshot } from '../engine/scoreHistory'
import type { TaleContent } from '../engine/taleContent'
import { calculateVPBreakdown, calculateVPDetail } from '../engine/victoryPoints'
import type { VPDetail } from '../engine/victoryPoints'
import type { GameState } from '../engine/types'
import type { PlayerRow } from '../lib/dbTypes'
import { HexBoard } from './HexBoard'
import type { UnitMarker } from './HexBoard'
import { ScoreCategoryChart } from './ScoreCategoryChart'
import { ScoreOverTimeChart } from './ScoreOverTimeChart'
import { scoredCategories } from './scoreCategories'
import { UnitIcon } from './UnitIcon'

const ACHIEVEMENTS = listAchievements()
const TERRAIN_TYPES = listTerrainTypes()

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Naive English pluralization ("city" -> "cities", "temple" -> "temples") — good enough for this game's unit/structure kind names. */
function pluralize(word: string, count: number): string {
  if (count === 1) return word
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`
  return `${word}s`
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
    lines.push({ label: `${boardCount.count} ${pluralize(capitalize(boardCount.kind), boardCount.count)}`, vp: boardCount.vp })
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
  scoreHistory,
}: {
  state: GameState
  players: PlayerRow[]
  achievementContent: AchievementContent
  taleContent: TaleContent
  /** The "total score over time" series (./engine/scoreHistory.ts), for the line chart below. Undefined/null (a caller that hasn't derived it, e.g. this component's own tests) simply skips that chart. */
  scoreHistory?: ScoreSnapshot[] | null
}) {
  const detailByPlayerId = calculateVPDetail(state, achievementContent, taleContent)
  const breakdownByPlayerId = calculateVPBreakdown(state, achievementContent, taleContent)
  const winnerIds = new Set(state.winnerPlayerIds)

  const ranked = [...state.players].sort((a, b) => (detailByPlayerId[b.id]?.total ?? 0) - (detailByPlayerId[a.id]?.total ?? 0))
  const rankedIds = ranked.map((p) => p.id)
  const ranks = ranksFor(ranked, (id) => detailByPlayerId[id]?.total ?? 0)
  const categories = scoredCategories(breakdownByPlayerId, rankedIds)
  const eliminatedIds = new Set(state.players.filter((p) => p.eliminated).map((p) => p.id))

  const boardUnits: UnitMarker[] = state.units.map((unit) => ({
    coord: unit.coord,
    color: players.find((p) => p.id === unit.ownerId)?.color ?? '#a3a3a3',
    kind: unit.kind,
  }))

  return (
    <div className="flex flex-col gap-6 rounded-md border border-amber-700/50 bg-amber-500/10 p-4">
      <div>
        <p className="text-lg font-semibold text-amber-300">Game over</p>
        <p className="text-sm text-amber-300/90">
          Winner{state.winnerPlayerIds.length > 1 ? 's' : ''}:{' '}
          {state.winnerPlayerIds.map((id) => players.find((p) => p.id === id)?.display_name ?? id).join(', ') || 'none'}
        </p>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-neutral-200">Final score</p>
        <ol className="flex flex-col divide-y divide-neutral-800 rounded-md border border-neutral-800">
          {ranked.map((player) => {
            const row = players.find((p) => p.id === player.id)
            const isWinner = winnerIds.has(player.id)
            return (
              <li key={player.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="w-8 shrink-0 text-neutral-500">{ordinal(ranks.get(player.id) ?? ranked.length)}</span>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row?.color ?? '#a3a3a3' }} />
                <span className={`flex-1 ${isWinner ? 'font-semibold text-amber-200' : 'text-neutral-200'}`}>
                  {row?.display_name ?? player.id}
                  {isWinner && <span title="Winner"> 🏆</span>}
                  {player.eliminated && <span className="text-neutral-500"> (eliminated)</span>}
                </span>
                <span className={`font-medium ${isWinner ? 'text-amber-200' : 'text-neutral-200'}`}>{detailByPlayerId[player.id]?.total ?? 0} pts</span>
              </li>
            )
          })}
        </ol>
      </div>

      {categories.length > 0 && (
        <div className="flex flex-col gap-3" data-testid="score-categories">
          <p className="text-sm font-medium text-neutral-200">Score categories</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-800 text-xs text-neutral-500">
                  <th className="py-1 pr-3 font-normal">Category</th>
                  {ranked.map((player) => (
                    <th key={player.id} className="px-3 py-1 font-normal text-neutral-400">
                      {players.find((p) => p.id === player.id)?.display_name ?? player.id}
                      {player.eliminated && <span className="text-neutral-500"> (eliminated)</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => {
                  const activeValues = rankedIds.filter((id) => !eliminatedIds.has(id)).map((id) => breakdownByPlayerId[id]?.[category.key] ?? 0)
                  const leaderValue = activeValues.length > 0 ? Math.max(...activeValues) : 0
                  return (
                    <tr key={category.key} className="border-b border-neutral-800/60 last:border-0">
                      <td className="py-1 pr-3 text-neutral-400">{category.label}</td>
                      {rankedIds.map((id) => {
                        if (eliminatedIds.has(id)) {
                          return (
                            <td key={id} className="px-3 py-1 text-neutral-500">
                              —
                            </td>
                          )
                        }
                        const value = breakdownByPlayerId[id]?.[category.key] ?? 0
                        const isLeader = value > 0 && value === leaderValue
                        return (
                          <td key={id} className={`px-3 py-1 ${isLeader ? 'font-semibold text-amber-200' : 'text-neutral-300'}`}>
                            {value}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
                <tr className="text-neutral-200">
                  <td className="py-1 pr-3 font-medium">Total</td>
                  {rankedIds.map((id) => (
                    <td key={id} className="px-3 py-1 font-medium">
                      {breakdownByPlayerId[id]?.total ?? 0}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <ScoreCategoryChart breakdownByPlayerId={breakdownByPlayerId} players={players} playerIds={rankedIds} />
        </div>
      )}

      {scoreHistory && scoreHistory.length > 1 && <ScoreOverTimeChart history={scoreHistory} players={players} playerIds={rankedIds} />}

      <div data-testid="score-breakdown">
        <p className="mb-2 text-sm font-medium text-neutral-200">Score breakdown</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-xs text-neutral-500">
                <th className="py-1 pr-3 font-normal">Player</th>
                {ranked.map((player) => {
                  const row = players.find((p) => p.id === player.id)
                  const isWinner = winnerIds.has(player.id)
                  return (
                    <th key={player.id} data-testid={`breakdown-header-${player.id}`} className="px-3 py-1 align-top font-normal">
                      <span className="flex items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row?.color ?? '#a3a3a3' }} />
                        <span className={isWinner ? 'font-semibold text-amber-200' : 'font-medium text-neutral-200'}>{row?.display_name ?? player.id}</span>
                        {isWinner && <span title="Winner">🏆</span>}
                        {player.eliminated && <span className="text-neutral-500">(eliminated)</span>}
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-neutral-800/60">
                <td className="py-1 pr-3 text-neutral-500">Place</td>
                {ranked.map((player) => (
                  <td key={player.id} data-testid={`breakdown-place-${player.id}`} className="px-3 py-1 text-xs text-neutral-500">
                    {ordinal(ranks.get(player.id) ?? ranked.length)}
                  </td>
                ))}
              </tr>
              <tr className="border-b border-neutral-800/60">
                <td className="py-1 pr-3 text-neutral-500">Points</td>
                {ranked.map((player) => {
                  const isWinner = winnerIds.has(player.id)
                  const total = detailByPlayerId[player.id]?.total ?? 0
                  return (
                    <td key={player.id} data-testid={`breakdown-points-${player.id}`} className={`px-3 py-1 ${isWinner ? 'font-semibold text-amber-200' : 'font-medium text-neutral-200'}`}>
                      {total} point{total === 1 ? '' : 's'}
                    </td>
                  )
                })}
              </tr>
              <tr className="border-b border-neutral-800/60">
                <td className="py-1 pr-3 align-top text-neutral-500">Breakdown</td>
                {ranked.map((player) => {
                  if (player.eliminated) {
                    return (
                      <td key={player.id} data-testid={`breakdown-lines-${player.id}`} className="px-3 py-1 align-top text-xs text-neutral-500">
                        Eliminated
                      </td>
                    )
                  }
                  const detail = detailByPlayerId[player.id]
                  const lines = detail ? scoreLinesFor(detail) : []
                  return (
                    <td key={player.id} data-testid={`breakdown-lines-${player.id}`} className="px-3 py-1 align-top">
                      {lines.length > 0 ? (
                        <ul className="flex flex-col gap-0.5 text-xs text-neutral-400">
                          {lines.map((line, i) => (
                            <li key={i}>
                              {line.label}: <span className="text-neutral-300">{line.vp} point{line.vp === 1 ? '' : 's'}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-neutral-500">No points scored</span>
                      )}
                    </td>
                  )
                })}
              </tr>
              <tr className="border-b border-neutral-800/60">
                <td className="py-1 pr-3 text-neutral-500">Resources</td>
                {ranked.map((player) =>
                  player.eliminated ? (
                    <td key={player.id} data-testid={`breakdown-resources-${player.id}`} className="px-3 py-1 text-xs text-neutral-500">
                      Eliminated
                    </td>
                  ) : (
                    <td key={player.id} data-testid={`breakdown-resources-${player.id}`} className="px-3 py-1 text-xs text-neutral-400">
                      {player.resources.gold} Gold, {player.resources.wood} Wood, {player.resources.stone} Stone
                    </td>
                  ),
                )}
              </tr>
              <tr>
                <td className="py-1 pr-3 align-top text-neutral-500">Units</td>
                {ranked.map((player) => {
                  if (player.eliminated) {
                    return (
                      <td key={player.id} data-testid={`breakdown-units-${player.id}`} className="px-3 py-1 align-top text-xs text-neutral-500">
                        Eliminated
                      </td>
                    )
                  }
                  const unitCounts = unitCountsFor(state, player.id)
                  return (
                    <td key={player.id} data-testid={`breakdown-units-${player.id}`} className="px-3 py-1 align-top">
                      {unitCounts.length > 0 ? (
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-400">
                          {unitCounts.map(({ kind, count }) => (
                            <span key={kind} className="inline-flex items-center gap-1" title={capitalize(kind)}>
                              <UnitIcon kind={kind} className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                              <span>{count}</span>
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-xs text-neutral-500">—</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-neutral-200">Final board</p>
        <HexBoard board={state.board} units={boardUnits} />
      </div>
    </div>
  )
}
