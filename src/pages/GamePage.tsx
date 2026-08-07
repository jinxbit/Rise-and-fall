import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { BoardView } from '../components/BoardView'
import { useAuth } from '../hooks/useAuth'
import { createEmptyBoard, setTile } from '../engine/board'
import { getGameByRoomCode, listPlayers } from '../lib/gameApi'
import type { GameRow, PlayerRow } from '../lib/dbTypes'

// Placeholder board so the screen renders something meaningful before real
// board generation/drafting is implemented.
function placeholderBoard() {
  let board = createEmptyBoard('hex')
  for (let q = -3; q <= 3; q++) {
    for (let r = -3; r <= 3; r++) {
      if (Math.abs(q + r) > 3) continue
      const terrain = Math.abs(q) === 3 || Math.abs(r) === 3 ? 'water' : 'land'
      board = setTile(board, { q, r }, terrain)
    }
  }
  return board
}

export function GamePage() {
  const { roomCode } = useParams<{ roomCode: string }>()
  const { session, loading: authLoading } = useAuth()

  const [game, setGame] = useState<GameRow | null>(null)
  const [players, setPlayers] = useState<PlayerRow[]>([])

  useEffect(() => {
    if (!roomCode) return
    void (async () => {
      const foundGame = await getGameByRoomCode(roomCode)
      setGame(foundGame)
      if (foundGame) setPlayers(await listPlayers(foundGame.id))
    })()
  }, [roomCode])

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>
  if (!session) return <div className="p-8 text-neutral-400">Sign in from the home page first.</div>
  if (!game) return <div className="p-8 text-neutral-400">Looking for room {roomCode}…</div>

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Room {game.room_code}</h1>
        <ul className="flex gap-3 text-sm text-neutral-400">
          {players.map((p) => (
            <li key={p.id} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
              {p.display_name}
            </li>
          ))}
        </ul>
      </header>

      <p className="rounded-md border border-dashed border-neutral-700 p-3 text-sm text-neutral-500">
        Placeholder board — real board generation, unit rendering, and card play come in the next milestone.
      </p>

      <BoardView board={placeholderBoard()} />
    </div>
  )
}
