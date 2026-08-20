import type { ReactNode } from 'react'
import type { PlayerRow } from '../lib/dbTypes'

/**
 * The card used everywhere a game/room is listed (MyGamesPage.tsx,
 * HomePage.tsx, PublicRoomsPage.tsx): highlights the whole card when it's
 * the viewer's turn, bolds whichever seated player(s) are pending, greys out
 * finished games, and shows a relative "last updated" time.
 */
export interface GameOverviewCardProps {
  name: string
  description: string
  roomCode?: string
  players: PlayerRow[]
  pendingPlayerIds: string[]
  isMyTurn: boolean
  isFinished: boolean
  updatedAt: string
  action?: ReactNode
  onOpen: () => void
}

export function GameOverviewCard({
  name,
  description,
  roomCode,
  players,
  pendingPlayerIds,
  isMyTurn,
  isFinished,
  updatedAt,
  action,
  onOpen,
}: GameOverviewCardProps) {
  return (
    <li>
      <button
        onClick={onOpen}
        className={`flex w-full flex-col gap-1 rounded-md border px-4 py-3 text-left ${
          isMyTurn
            ? 'border-indigo-500 bg-indigo-950/40 hover:border-indigo-400'
            : isFinished
              ? 'border-neutral-800/60 bg-neutral-900/40 text-neutral-500 hover:border-neutral-700'
              : 'border-neutral-800 bg-neutral-900 hover:border-neutral-600'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <span className={`font-medium ${isFinished ? 'text-neutral-500' : ''}`}>{name}</span>
          {action && (
            <span className="shrink-0 rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white">{action}</span>
          )}
        </div>
        <span className={`text-sm ${isFinished ? 'text-neutral-600' : 'text-neutral-400'}`}>
          {roomCode && <>Room {roomCode} · </>}
          {description} ·{' '}
          {players.length === 0
            ? 'no players yet'
            : players.map((p, i) => (
                <span key={p.id} className={pendingPlayerIds.includes(p.id) ? 'font-semibold text-neutral-100' : undefined}>
                  {i > 0 && ', '}
                  {p.display_name}
                </span>
              ))}
        </span>
        <span className={`text-xs ${isFinished ? 'text-neutral-600' : 'text-neutral-500'}`}>{updatedAt}</span>
      </button>
    </li>
  )
}
