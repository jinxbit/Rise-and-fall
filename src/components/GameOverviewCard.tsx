import type { ReactNode } from 'react'
import type { PlayerRow } from '../lib/dbTypes'
import type { GameCardSummary } from '../lib/gameCardView'

/**
 * The card used everywhere a game/room is listed (MyGamesPage.tsx,
 * HomePage.tsx, PublicRoomsPage.tsx): highlights the whole card when it's
 * the viewer's turn, bolds whichever seated player(s) are pending, tints
 * finished games yellow and joinable games green, and shows the phase and a
 * relative "last updated" time in the lower right corner.
 */
export interface GameOverviewCardProps {
  name: string
  description?: string
  phase: string
  players: PlayerRow[]
  pendingPlayerIds: string[]
  isMyTurn: boolean
  isFinished: boolean
  isJoinable?: boolean
  updatedAt: string
  action?: ReactNode
  /** Config/score summary (issue #204) — see gameCardView.ts's buildGameCardSummary. Omitted entirely skips this section. */
  summary?: GameCardSummary
  onOpen: () => void
}

export function GameOverviewCard({
  name,
  description,
  phase,
  players,
  pendingPlayerIds,
  isMyTurn,
  isFinished,
  isJoinable = false,
  updatedAt,
  action,
  summary,
  onOpen,
}: GameOverviewCardProps) {
  const dimText = isFinished ? 'text-yellow-600' : 'text-neutral-500'
  const scoreByPlayerId = new Map((summary?.scores ?? []).map((s) => [s.playerId, s.score]))

  return (
    <li>
      <button
        onClick={onOpen}
        className={`flex w-full flex-col gap-1 rounded-md border px-4 py-3 text-left ${
          isMyTurn
            ? 'border-indigo-500 bg-indigo-950/40 hover:border-indigo-400'
            : isFinished
              ? 'border-yellow-800/60 bg-yellow-950/40 hover:border-yellow-700'
              : isJoinable
                ? 'border-green-800/60 bg-green-950/40 hover:border-green-600'
                : 'border-neutral-800 bg-neutral-900 hover:border-neutral-600'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <span className={`font-medium ${isFinished ? 'text-yellow-600' : ''}`}>{name}</span>
          {action && (
            <span className="shrink-0 rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white">{action}</span>
          )}
        </div>
        <span className={`text-sm ${isFinished ? 'text-yellow-700' : 'text-neutral-400'}`}>
          {description && <>{description} · </>}
          {players.length === 0
            ? 'no players yet'
            : players.map((p, i) => (
                <span key={p.id} className={pendingPlayerIds.includes(p.id) ? 'font-semibold text-neutral-100' : undefined}>
                  {i > 0 && ', '}
                  {p.display_name}
                  {scoreByPlayerId.has(p.id) && `: ${scoreByPlayerId.get(p.id)}`}
                </span>
              ))}
        </span>
        {summary && <GameCardSummaryLines summary={summary} isFinished={isFinished} />}
        <div className="flex flex-col items-end text-right">
          {/* Once finished, updatedAt is already the "Finished at ..." label — the phase line would just repeat "Finished". */}
          {!isFinished && <span className={`text-xs ${dimText}`}>{phase}</span>}
          <span className={`text-xs ${dimText}`}>{updatedAt}</span>
        </div>
      </button>
    </li>
  )
}

/**
 * Renders whichever fields of `summary` apply to the game's current phase
 * (see GameCardSummary's doc comment for which fields are populated when) —
 * issue #204's per-phase config/score summary.
 */
function GameCardSummaryLines({ summary, isFinished }: { summary: GameCardSummary; isFinished: boolean }) {
  const hasPregameInfo = summary.playerRange !== null || summary.mapBuildStyle !== null

  if (!hasPregameInfo && summary.moduleNames.length === 0 && summary.roundNumber === null && summary.winnerNames.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col gap-0.5 text-xs text-neutral-500">
      {hasPregameInfo && (
        <span>
          {summary.playerRange}
          {summary.playerRange && summary.mapBuildStyle && ' · '}
          {summary.mapBuildStyle}
        </span>
      )}
      {summary.moduleNames.length > 0 && <span>Modules: {summary.moduleNames.join(', ')}</span>}
      {!isFinished && summary.roundNumber !== null && <span>Round {summary.roundNumber}</span>}
      {isFinished && summary.winnerNames.length > 0 && <span>👑 {summary.winnerNames.join(', ')}</span>}
    </div>
  )
}
