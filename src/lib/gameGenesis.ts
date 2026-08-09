// Rebuilds a game's genesis GameState — the exact state LobbyPage.tsx's
// handleStart() originally created and persisted (status: 'boardSetup' or,
// for a preset map, straight past interactive tile placement; actionHistory:
// []) — on demand instead of storing it separately. Deterministic from the
// game's row + seated players: player roster/seat order never changes after
// creation, and content resolution only depends on player count, so this
// always reconstructs the same genesis a second time. Used by handleStart()
// itself and by GamePage.tsx's undo feature, which replays
// actionHistory.slice(0, -1) against this genesis (see replayActions in
// ../engine/replay.ts) to step the game back one action.

import { resolveBoardGenerationContent, resolveMapTemplateBoard, resolveResourceBank, resolveUnitLimits } from '../content/resolveContent'
import { createEmptyBoard } from '../engine/board'
import { createNewGame, startGame, startGameWithPresetBoard } from '../engine/createGame'
import type { GameState } from '../engine/types'
import type { GameRow, PlayerRow } from './dbTypes'

export function buildGenesisState(game: GameRow, players: PlayerRow[]): GameState {
  const lobbyState = createNewGame({
    gameId: game.id,
    playMode: game.play_mode,
    board: createEmptyBoard('hex'),
    players: players.map((p) => ({
      id: p.id,
      authUserId: p.user_id,
      displayName: p.display_name,
      color: p.color,
    })),
    resourceBank: resolveResourceBank(players.length),
    unitLimits: resolveUnitLimits(players.length),
  })

  if (game.map_template_id) {
    const presetBoard = resolveMapTemplateBoard(game.map_template_id)
    if (!presetBoard) throw new Error(`Unknown map template: ${game.map_template_id}`)
    return startGameWithPresetBoard(lobbyState, presetBoard)
  }
  return startGame(lobbyState, resolveBoardGenerationContent(players.length))
}
