import { getTile, setTile } from './board'
import type { Board, Coordinate, GameState, PlayMode, Player, Unit } from './types'

export interface PlayerSeed {
  id: string
  authUserId: string | null
  displayName: string
  color: string
}

/** Builds a fresh lobby-status game: board is set but no units are placed yet. */
export function createNewGame(params: {
  gameId: string
  playMode: PlayMode
  board: Board
  players: PlayerSeed[]
}): GameState {
  const players: Player[] = params.players.map((seed) => ({
    id: seed.id,
    authUserId: seed.authUserId,
    displayName: seed.displayName,
    color: seed.color,
    handCardIds: [],
    deckCardIds: [],
    discardCardIds: [],
  }))

  return {
    gameId: params.gameId,
    playMode: params.playMode,
    status: 'lobby',
    turn: 0,
    activePlayerId: null,
    turnOrder: players.map((p) => p.id),
    board: params.board,
    players,
    units: [],
    cards: {},
    log: [],
    winnerPlayerId: null,
  }
}

let unitCounter = 0
function nextUnitId(): string {
  unitCounter += 1
  return `unit_${unitCounter}`
}

/**
 * Places each player's starting tribe (one settlement, one mobile unit, one
 * ship) at their drafted starting coordinate and moves the game to active.
 * The exact stat block for each starting unit is a placeholder pending the
 * full rules — traits/movement here are enough to exercise board placement
 * and turn order, not final balance.
 */
export function startGame(state: GameState, startingPositions: Record<string, Coordinate>): GameState {
  if (state.status !== 'lobby') {
    throw new Error(`Cannot start a game with status ${state.status}`)
  }

  let board = state.board
  const units: Unit[] = [...state.units]

  for (const player of state.players) {
    const coord = startingPositions[player.id]
    if (!coord) {
      throw new Error(`No starting position given for player ${player.id}`)
    }
    if (!getTile(board, coord)) {
      board = setTile(board, coord, 'land')
    }

    units.push(
      {
        id: nextUnitId(),
        ownerId: player.id,
        kind: 'settlement',
        coord,
        movement: { domains: [], canTraverseCliffs: false, range: 0 },
        traits: ['settlement'],
      },
      {
        id: nextUnitId(),
        ownerId: player.id,
        kind: 'mobile-unit',
        coord,
        movement: { domains: ['land'], canTraverseCliffs: false, range: 1 },
        traits: ['mobile'],
      },
      {
        id: nextUnitId(),
        ownerId: player.id,
        kind: 'ship',
        coord,
        movement: { domains: ['water'], canTraverseCliffs: false, range: 1 },
        traits: ['ship'],
      },
    )
  }

  return {
    ...state,
    board,
    units,
    status: 'active',
    activePlayerId: state.turnOrder[0] ?? null,
  }
}
