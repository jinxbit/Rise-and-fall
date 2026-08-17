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

import { resolveBoardGenerationContent, resolveMapTemplateBoard, resolveResourceBank } from '../content/resolveContent'
import { createEmptyBoard } from '../engine/board'
import { createNewGame, startGame, startGameWithPresetBoard } from '../engine/createGame'
import type { GameState } from '../engine/types'
import type { GameRow, GameSettings, MapPoolRow, PlayerRow } from './dbTypes'

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
    activeTaleIds: game.settings.activeTaleIds,
    gameLength: game.settings.gameLength,
  })

  if (game.settings.mapTemplateId) {
    const presetBoard = resolveMapTemplateBoard(game.settings.mapTemplateId)
    if (!presetBoard) throw new Error(`Unknown map template: ${game.settings.mapTemplateId}`)
    return startGameWithPresetBoard(lobbyState, presetBoard)
  }
  if (game.settings.mapPoolBoard) {
    return startGameWithPresetBoard(lobbyState, game.settings.mapPoolBoard)
  }
  return startGame(lobbyState, resolveBoardGenerationContent(players.length))
}

/**
 * Resolves GameSettings.mapPoolRandomAtStart ("truly random" map, issue
 * #166) against an already-looked-up map_pool row for the actual seated
 * player count, into an updated GameSettings with that board locked in —
 * or `settings` unchanged if the mode isn't active, a board's already
 * locked in, or `picked` is null (no saved map fits that count, so
 * buildGenesisState falls back to its normal interactive board-building
 * path). Pure and synchronous — unlike buildGenesisState it doesn't touch
 * the DB itself; LobbyPage.tsx's handleStart() does the actual
 * pickRandomMapFromPool lookup (mapPoolApi.ts) and persists the result via
 * updateGameSettings before calling buildGenesisState, so genesis stays a
 * deterministic function of the game row alone (see buildGenesisState's
 * doc comment) once the game is under way.
 */
export function resolveMapPoolRandomAtStart(settings: GameSettings, picked: MapPoolRow | null): GameSettings {
  if (!settings.mapPoolRandomAtStart || settings.mapPoolBoard || !picked) return settings
  return { ...settings, mapPoolBoard: picked.board, mapPoolMapId: picked.id }
}
