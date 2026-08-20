import type { ReactNode } from 'react'
import type { PlayerRow } from '../lib/dbTypes'

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
  onOpen,
}: GameOverviewCardProps) {
  const dimText = isFinished ? 'text-yellow-600' : 'text-neutral-500'

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
                </span>
              ))}
        </span>
        <div className="flex flex-col items-end text-right">
          <span className={`text-xs ${dimText}`}>{phase}</span>
          <span className={`text-xs ${dimText}`}>{updatedAt}</span>
        </div>
      </button>
    </li>
  )
}
