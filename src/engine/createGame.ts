import { getTile, setTile } from './board'
import { createPlayerCards, syncCardZonesWithBoard } from './cards'
import { beginSelectCardsPhase } from './round'
import type { Board, Card, Coordinate, GameState, PlayMode, Player, Resources, Unit } from './types'

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
 * byPlayerCount` looked up for `players.length`, and `unitLimits` should be
 * content/units.json's `supply.byPlayerCount` per unit kind (same value
 * across every player count) — the engine stays content-agnostic (see
 * UNIT_KINDS in ./cards.ts), so the caller resolves both. Both are optional
 * and default to empty (no limit/no resources) so existing callers/tests
 * that don't touch them aren't forced to pass them.
 */
export function createNewGame(params: {
  gameId: string
  playMode: PlayMode
  board: Board
  players: PlayerSeed[]
  resourceBank?: Resources
  unitLimits?: Record<string, number>
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
    turnOrder,
    board: params.board,
    players,
    units: [],
    cards,
    resourceBank: params.resourceBank ?? { ...EMPTY_RESOURCES },
    unitLimits: params.unitLimits ?? {},
    log: [],
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: null,
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
 *
 * TEMPORARY: the real rules are now known (see src/content/README.md's
 * "Board generation" section and todo.md #7) and partly implemented —
 * beginBoardSetup()/placeTile()/placeUnit() in ./boardSetup.ts run the
 * real board+starting-unit-placement procedure via PLACE_TILE/PLACE_UNIT
 * actions. This function still exists because nothing calls those yet;
 * it'll be replaced by `beginBoardSetup(state, boardGenerationContent)`
 * (skipping the `startingPositions` param entirely — there's no
 * per-player starting coordinate in the real rules, units go anywhere
 * legal) once a caller is ready to drive the real interactive phase
 * instead of this shortcut.
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
      board = setTile(board, coord, 'plain')
    }

    units.push(
      {
        id: nextUnitId(),
        ownerId: player.id,
        kind: 'settlement',
        coord,
        movement: { isMobile: false, terrains: [], canCrossCliffs: false },
        traits: ['settlement'],
      },
      {
        id: nextUnitId(),
        ownerId: player.id,
        kind: 'mobile-unit',
        coord,
        movement: { isMobile: true, terrains: ['plain'], canCrossCliffs: false, moveDistance: 1 },
        traits: ['mobile'],
      },
      {
        id: nextUnitId(),
        ownerId: player.id,
        kind: 'ship',
        coord,
        movement: { isMobile: true, terrains: ['water'], canCrossCliffs: false, moveDistance: 1 },
        traits: ['ship'],
      },
    )
  }

  const nextState: GameState = {
    ...state,
    board,
    units,
    status: 'active',
  }

  // Rule 6: a player's card enters their hand the moment they get their
  // first unit of that kind on the board — apply that for the starting units.
  // Then kick off round 1's select-cards phase.
  return beginSelectCardsPhase(syncCardZonesWithBoard(nextState))
}
