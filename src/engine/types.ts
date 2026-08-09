// Core data types for the Rise & Fall rules engine.
//
// This module is pure TypeScript: no React, no Supabase, no I/O. The engine
// operates purely on these types via applyAction() in ./applyAction.ts.
// The exact card/unit roster is still being designed — the unions below are
// intentionally open-ended (string ids resolved against a content table)
// rather than hardcoding every card/unit as a literal type.

export type PlayMode = 'live' | 'async' | 'hotseat'

export type GameStatus = 'lobby' | 'active' | 'completed'

/** Board tiling scheme, fixed for the lifetime of a single game. */
export type BoardShape = 'hex' | 'square'

/**
 * Terrain a tile can have. `cliff` is passable only by units whose
 * `canTraverseCliffs` trait is true — everything else treats it like land
 * for adjacency purposes but cannot end a move there.
 */
export type Terrain = 'land' | 'water' | 'cliff'

/**
 * Axial-ish grid coordinate shared by both hex and square boards. For square
 * boards `r` is just the row; for hex boards it's the axial row per the
 * standard axial coordinate system. Keeping one coordinate shape for both
 * lets board-agnostic code (rendering, pathing) stay simple.
 */
export interface Coordinate {
  q: number
  r: number
}

export function coordKey(coord: Coordinate): string {
  return `${coord.q},${coord.r}`
}

export interface Tile {
  id: string
  coord: Coordinate
  terrain: Terrain
  /** Unit/settlement ids currently occupying this tile. */
  occupantIds: string[]
}

export interface Board {
  shape: BoardShape
  /** Tiles keyed by coordKey(tile.coord) for O(1) lookup. */
  tiles: Record<string, Tile>
}

/** A unit's movement/traversal capabilities. */
export interface UnitMovement {
  domains: Terrain[]
  canTraverseCliffs: boolean
  range: number
}

/**
 * A unit on the board. Covers the starting mobile unit and ship as well as
 * settlements (which have movement range 0) and any unit types introduced
 * later by cards. `kind` is a content id looked up in a future unit
 * definition table rather than a fixed literal union, since the full unit
 * roster isn't finalized yet.
 */
export interface Unit {
  id: string
  ownerId: string
  kind: string
  coord: Coordinate
  movement: UnitMovement
  /** Arbitrary per-unit tags for rules that key off unit traits (e.g. 'settlement', 'ship'). */
  traits: string[]
}

/**
 * The five places a card can be, per the card-play rules:
 * - `hand`: playable by its owner.
 * - `currentlyPlayed`: transient — the card mid-resolution on the turn it's played.
 * - `discard`: played cards, recycled into the hand once the hand is empty.
 * - `supply`: the card's owner currently has no unit of its kind on the board.
 * - `decline`: leaves only when bought back (rules for this land later).
 */
export type CardZone = 'hand' | 'currentlyPlayed' | 'discard' | 'supply' | 'decline'

/**
 * A card in a player's personal set. Each player has exactly one card per
 * unit kind (`kind`), so `kind` doubles as which unit type this card
 * governs. `effectId` is resolved against a content table by the
 * (not-yet-written) action-resolution logic; the engine skeleton only needs
 * to move cards between zones.
 */
export interface Card {
  id: string
  ownerId: string
  /** Unit kind this card corresponds to — matches `Unit.kind` / content/units.json ids. */
  kind: string
  name: string
  description: string
  effectId: string
}

export interface Player {
  id: string
  /** Supabase auth user id / Discord identity, when known. */
  authUserId: string | null
  displayName: string
  color: string
  handCardIds: string[]
  /** At most one card, since only a single card can be played per round. */
  currentlyPlayedCardId: string | null
  discardCardIds: string[]
  supplyCardIds: string[]
  declineCardIds: string[]
  /**
   * True once eliminated: had to play a card (select-cards phase) or give
   * one up (decline phase) with none available. Eliminated players are
   * removed from the board and turn order for the rest of the game and
   * excluded from winning (see src/engine/elimination.ts).
   */
  eliminated: boolean
}

/**
 * The phases within a single round, per the round sequence:
 * 1. `selectCards` — every player simultaneously picks the one card they'll
 *    play from their hand.
 * 2. `actions` — in turn order, each player resolves the action for the
 *    unit kind they chose.
 * 3. `decline` — only inserted when a player reached a unit-kind limit this
 *    round; in turn order, each player moves one card from hand/discard to
 *    decline.
 * 4. `purchase` — every player, in turn order, may buy one card back from
 *    their decline (cost rules TBD) or pass.
 * Recycle-check and round-end/game-end are automatic bookkeeping the engine
 * performs when the purchase phase completes, so they aren't states a game
 * ever sits in — see `finishRound` in ./round.ts.
 */
export type RoundPhase = 'selectCards' | 'actions' | 'decline' | 'purchase'

/** Append-only log entry, kept since the game has no hidden information. */
export interface GameEvent {
  id: string
  turn: number
  playerId: string | null
  message: string
  timestamp: string
}

export interface GameState {
  gameId: string
  playMode: PlayMode
  status: GameStatus
  /** Round number — increments each time a round finishes (see ./round.ts). */
  turn: number
  /**
   * Whoever must act next in the current sequential phase (actions/decline/
   * purchase) — the head of `pendingPlayerIds`. Null during `selectCards`,
   * since that phase is simultaneous and has no single active player.
   */
  activePlayerId: string | null
  roundPhase: RoundPhase
  /** This round's simultaneous card pick (rule 1); null until that player has chosen. */
  chosenCardIdByPlayerId: Record<string, string | null>
  /** Players, in turn order, still owed a turn in the current phase. */
  pendingPlayerIds: string[]
  /** Ordered turn sequence, e.g. player ids in seating order. turnOrder[0] is the current first player. */
  turnOrder: string[]
  board: Board
  players: Player[]
  units: Unit[]
  cards: Record<string, Card>
  log: GameEvent[]
  /**
   * The winner(s) once the game ends: whoever has the most total VP
   * (achievements + board-count + terrain-control — see
   * src/engine/victoryPoints.ts). There is no tiebreaker, so this can hold
   * more than one player id on a tie. Empty until the game ends.
   */
  winnerPlayerIds: string[]
}
