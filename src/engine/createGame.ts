import { beginBoardSetup, beginBoardSetupWithPresetBoard } from './boardSetup'
import type { BoardGenerationContent } from './boardGenerationContent'
import { createPlayerCards } from './cards'
import type { Board, Card, GameState, PlayMode, Player, Resources } from './types'

export interface PlayerSeed {
  id: string
  authUserId: string | null
  displayName: string
  color: string
}

const EMPTY_RESOURCES: Resources = { gold: 0, wood: 0, stone: 0 }

/**
 * Builds a fresh lobby-status game: board is set but no units are placed
 * yet. Each player's six unit cards (one per unit kind) start in supply per
 * rule 5 — nobody has any units on the board yet.
 *
 * `resourceBank` should be content/resources.json's `globalSupply.
 * byPlayerCount` looked up for `players.length` — the engine stays
 * content-agnostic (see UNIT_KINDS in ./cards.ts), so the caller resolves
 * it. Optional and defaults to empty (no resources) so existing
 * callers/tests that don't touch it aren't forced to pass it.
 */
export function createNewGame(params: {
  gameId: string
  playMode: PlayMode
  board: Board
  players: PlayerSeed[]
  resourceBank?: Resources
}): GameState {
  const cards: Record<string, Card> = {}
  const players: Player[] = params.players.map((seed) => {
    const playerCards = createPlayerCards(seed.id)
    for (const card of playerCards) {
      cards[card.id] = card
    }
    return {
      id: seed.id,
      authUserId: seed.authUserId,
      displayName: seed.displayName,
      color: seed.color,
      handCardIds: [],
      currentlyPlayedCardId: null,
      discardCardIds: [],
      supplyCardIds: playerCards.map((c) => c.id),
      declineCardIds: [],
      eliminated: false,
      resources: { ...EMPTY_RESOURCES },
    }
  })

  const turnOrder = players.map((p) => p.id)

  return {
    gameId: params.gameId,
    playMode: params.playMode,
    status: 'lobby',
    turn: 0,
    activePlayerId: null,
    roundPhase: 'selectCards',
    chosenCardIdByPlayerId: Object.fromEntries(players.map((p) => [p.id, null])),
    pendingPlayerIds: [...turnOrder],
    resolvedUnitIdsThisTurn: [],
    unitsCreatedThisTurn: [],
    turnOrder,
    board: params.board,
    players,
    units: [],
    cards,
    resourceBank: params.resourceBank ?? { ...EMPTY_RESOURCES },
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
  }
}

/**
 * Starts a lobby-status game: kicks off the real board-setup procedure
 * (src/engine/boardSetup.ts's beginBoardSetup — seed the starting water
 * tiles, then the interactive PLACE_TILE/PLACE_UNIT actions take it from
 * there). `status` becomes `'boardSetup'`, not `'active'` — the round
 * cycle only begins once every player has placed all three starting units
 * (see PROJECT_PLAN.md section 2 / todo.md #7 for what board setup covers
 * and what's still open, namely the no-space/move-tiles rule).
 */
export function startGame(state: GameState, boardGenerationContent: BoardGenerationContent): GameState {
  if (state.status !== 'lobby') {
    throw new Error(`Cannot start a game with status ${state.status}`)
  }
  return beginBoardSetup(state, boardGenerationContent)
}

/**
 * Alternative to startGame() for games starting from a pre-made map (see
 * content/mapTemplates.json / resolveMapTemplateBoard in
 * content/resolveContent.ts): skips the interactive tile-placement
 * sub-phase, using `board` as-is, but still runs the normal interactive
 * starting-unit placement sub-phase from there — `status` becomes
 * `'boardSetup'` just like startGame(), not `'active'` directly.
 */
export function startGameWithPresetBoard(state: GameState, board: Board): GameState {
  if (state.status !== 'lobby') {
    throw new Error(`Cannot start a game with status ${state.status}`)
  }
  return beginBoardSetupWithPresetBoard(state, board)
}
