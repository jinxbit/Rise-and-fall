import type { AchievementContent } from '../engine/achievementContent'
import { calculateVPBreakdown } from '../engine/victoryPoints'
import type { GameState } from '../engine/types'
import type { PlayerRow } from '../lib/dbTypes'

/**
 * The end-of-game screen: every player, ranked by final total VP, with the
 * per-source breakdown (achievements/board-count/terrain-control/gold —
 * see calculateVPBreakdown) that total is made of, not just the bottom
 * line. Winner(s) — everyone tied for the highest total, per the "no
 * tiebreaker" rule (GameState.winnerPlayerIds, already computed once by
 * finishRound() using this same breakdown) — are highlighted.
 */
export function EndGameView({ state, players, achievementContent }: { state: GameState; players: PlayerRow[]; achievementContent: AchievementContent }) {
  const breakdownByPlayerId = calculateVPBreakdown(state, achievementContent)
  const winnerIds = new Set(state.winnerPlayerIds)

  const ranked = [...state.players].sort((a, b) => (breakdownByPlayerId[b.id]?.total ?? 0) - (breakdownByPlayerId[a.id]?.total ?? 0))

  return (
    <div className="flex flex-col gap-4 rounded-md border border-amber-700/50 bg-amber-500/10 p-4">
      <div>
        <p className="text-lg font-semibold text-amber-300">Game over</p>
        <p className="text-sm text-amber-300/90">
          Winner{state.winnerPlayerIds.length > 1 ? 's' : ''}:{' '}
          {state.winnerPlayerIds.map((id) => players.find((p) => p.id === id)?.display_name ?? id).join(', ') || 'none'}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-amber-700/50 text-left text-xs uppercase tracking-wide text-amber-400/80">
              <th className="py-1.5 pr-3">Player</th>
              <th className="px-3 py-1.5 text-right">Total VP</th>
              <th className="px-3 py-1.5 text-right">Achievements</th>
              <th className="px-3 py-1.5 text-right">Board count</th>
              <th className="px-3 py-1.5 text-right">Terrain control</th>
              <th className="px-3 py-1.5 text-right">Gold</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((player) => {
              const row = players.find((p) => p.id === player.id)
              const breakdown = breakdownByPlayerId[player.id]
              const isWinner = winnerIds.has(player.id)
              return (
                <tr key={player.id} className={`border-b border-amber-700/20 last:border-0 ${isWinner ? 'text-amber-200' : 'text-neutral-300'}`}>
                  <td className="py-1.5 pr-3">
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row?.color ?? '#a3a3a3' }} />
                      <span className={isWinner ? 'font-semibold' : undefined}>{row?.display_name ?? player.id}</span>
                      {isWinner && <span title="Winner">🏆</span>}
                      {player.eliminated && <span className="text-xs text-neutral-500">(eliminated)</span>}
                    </span>
                  </td>
                  <td className={`px-3 py-1.5 text-right ${isWinner ? 'font-semibold' : ''}`}>{breakdown?.total ?? 0}</td>
                  <td className="px-3 py-1.5 text-right text-neutral-400">{breakdown?.achievements ?? 0}</td>
                  <td className="px-3 py-1.5 text-right text-neutral-400">{breakdown?.boardCount ?? 0}</td>
                  <td className="px-3 py-1.5 text-right text-neutral-400">{breakdown?.terrainControl ?? 0}</td>
                  <td className="px-3 py-1.5 text-right text-neutral-400">{breakdown?.gold ?? 0}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
