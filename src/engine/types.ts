// Core data types for the Rise & Fall rules engine.
//
// This module is pure TypeScript: no React, no Supabase, no I/O. The engine
// operates purely on these types via applyAction() in ./applyAction.ts.
// The exact card/unit roster is still being designed — the unions below are
// intentionally open-ended (string ids resolved against a content table)
// rather than hardcoding every card/unit as a literal type.

import type { LoggedAction } from './actions'

export type PlayMode = 'live' | 'async' | 'hotseat'

/**
 * `boardSetup` is the first phase of a game (see src/engine/boardSetup.ts):
 * players place tiles, then starting units, before the round cycle
 * (`selectCards`/`actions`/`decline`/`purchase`) begins. `active` only
 * starts once that's fully done.
 */
export type GameStatus = 'lobby' | 'boardSetup' | 'active' | 'completed'

/** Board tiling scheme, fixed for the lifetime of a single game. */
export type BoardShape = 'hex' | 'square'

/**
 * Terrain a tile can have (content/terrain.json). Cliffs are not a terrain
 * type — they're a per-edge property derived from two hexes' elevation
 * `level` (see src/engine/cliffs.ts), which every unit can cross except
 * those whose `movement.canCrossCliffs` is true (units.json).
 */
export type Terrain = 'water' | 'plain' | 'forest' | 'mountain' | 'glacier'

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

/**
 * A unit's movement/traversal capabilities, mirroring content/units.json's
 * `movement` object.
 */
export interface UnitMovement {
  /** False for static units (City, Temple) — they occupy a tile but never move. */
  isMobile: boolean
  /** Terrain ids this unit may move onto. Empty for immobile units. */
  terrains: Terrain[]
  /** Whether this unit ignores cliff edges, which otherwise block movement/adjacency for every unit. */
  canCrossCliffs: boolean
  /**
   * Max hexes this unit can move in a single move action, or 'unlimited'
   * for a unit with no distance cap (e.g. Ship — still bounded by its
   * connected region of terrain it can move onto, just not by distance).
   * Undefined where not yet decided for a unit.
   */
  moveDistance?: number | 'unlimited'
  /** Which units this unit's movement path is blocked by. Undefined where not yet decided for a unit. */
  blockedByUnits?: 'none' | 'enemy' | 'all'
  /** Unit kind ids this unit may end its move on top of, as an exception to the normal unoccupied-hex rule. */
  canEndMoveOnUnitTypes?: string[]
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

/**
 * A holding of the 3 resource types (content/resources.json). Used both for
 * a single player's personal stock (Player.resources) and for the shared
 * bank everyone draws from (GameState.resourceBank) — same shape, since a
 * resource only ever moves from one to the other.
 */
export interface Resources {
  gold: number
  wood: number
  stone: number
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
   * excluded from winning (see src/engine/elimination.ts). Their resources
   * are returned to the bank at that point (resources.wood/stone/gold all
   * reset to 0 — see eliminatePlayer()).
   */
  eliminated: boolean
  /**
   * A player's own resource holdings. Wood/Stone are capped at
   * content/resources.json's `playerCap` (5); Gold is uncapped for a player
   * (playerCap: null) — only the shared bank below limits it. Enforced by
   * gainResource()/spendResource() in src/engine/resources.ts, not by this
   * type — nothing stops a raw object literal from violating the cap.
   */
  resources: Resources
}

/**
 * The phases within a single round, per the round sequence:
 * 1. `selectCards` — every player simultaneously picks the one card they'll
 *    play from their hand.
 * 2. `actions` — in turn order, each player resolves the action for the
 *    unit kind they chose.
 * 3. `decline` — only inserted when a player reached a unit-kind limit this
 *    round; every player simultaneously (not turn order — same as
 *    `selectCards`) moves one or more cards from hand/discard to decline —
 *    more than one if more than one achievement was claimed this round
 *    (`GameState.achievementsClaimedThisRound`).
 * 4. `purchase` — every player, in turn order, may buy one card back from
 *    their decline (cost rules TBD) or pass.
 * Recycle-check and round-end/game-end are automatic bookkeeping the engine
 * performs when the purchase phase completes, so they aren't states a game
 * ever sits in — see `finishRound` in ./round.ts.
 */
export type RoundPhase = 'selectCards' | 'actions' | 'decline' | 'purchase'

/**
 * Progress through the `boardSetup` game status (see
 * src/engine/boardSetup.ts). Two sequential sub-phases:
 *
 * 1. Tile placement: `tileTierQueue` holds the terrain ids still needing
 *    tiles placed, front-to-back (e.g. water, then plain, then forest,
 *    then mountain, then glacier — the starting water tiles are seeded
 *    automatically before this state even exists, so water here only
 *    covers its `expansion` shapeGroup). `tilesRemainingInTier` counts
 *    down within `tileTierQueue[0]`; once it hits 0 that tier is shifted
 *    off the front (and skipped entirely if its pool was 0 to begin
 *    with). Whoever's turn it is to place next is
 *    `turnOrder[tilePlacerIndex % turnOrder.length]` — deliberately a
 *    plain wrapping index rather than a draining queue, since tile pools
 *    don't necessarily divide evenly by player count.
 * 2. Unit placement: begins once `tileTierQueue` is empty.
 *    `unitsRemainingByPlayerId` maps each player id to which of their
 *    three starting unit kinds (city/nomad/ship) they still need to
 *    place, shrinking as they place them; `unitPlacerIndex` is the same
 *    kind of wrapping turn-order index as `tilePlacerIndex` (though here
 *    every player always has the same count, so it never needs to skip
 *    anyone). `boardSetup` on GameState goes back to `null` once every
 *    player has placed all three.
 */
export interface BoardSetupState {
  tileTierQueue: Terrain[]
  tilesRemainingInTier: number
  tilePlacerIndex: number
  unitsRemainingByPlayerId: Record<string, string[]>
  unitPlacerIndex: number
}

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
   * Whoever must act next in the current sequential phase (`actions`/
   * `purchase`) — the head of `pendingPlayerIds`. Null during `selectCards`
   * and `decline`, since both are simultaneous phases with no single active
   * player.
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
  /**
   * The shared bank's remaining resources — starts at content/resources.json's
   * `globalSupply.byPlayerCount` for however many players are in this game
   * (see createNewGame's `resourceBank` param) and moves opposite a
   * player's `resources` on every gain/spend (src/engine/resources.ts).
   */
  resourceBank: Resources
  /**
   * Per-unit-kind limit (decline rules 1 & 2): once any player reaches this
   * many of a kind, decline triggers for the round. Set once at game
   * creation (createNewGame's `unitLimits` param) from content/units.json's
   * `supply.byPlayerCount` — see src/engine/decline.ts's `getUnitLimit`.
   */
  unitLimits: Record<string, number>
  log: GameEvent[]
  /**
   * The winner(s) once the game ends: whoever has the most total VP
   * (achievements + board-count + terrain-control — see
   * src/engine/victoryPoints.ts). There is no tiebreaker, so this can hold
   * more than one player id on a tie. Empty until the game ends.
   */
  winnerPlayerIds: string[]
  /**
   * achievement id -> the player id who claimed it (content/achievements.
   * json). An achievement can only ever be claimed once, by one player, for
   * the whole game — permanent even if that player later drops below the
   * qualifying threshold or is eliminated (src/engine/elimination.ts).
   * Empty until claimed. Populated by updateAchievementClaims() in
   * src/engine/achievements.ts.
   */
  claimedByAchievementId: Record<string, string>
  /**
   * How many achievements were newly claimed during the CURRENT round so
   * far — reset to 0 at the start of every round (beginSelectCardsPhase in
   * src/engine/round.ts). Drives the decline phase's per-player card count:
   * each pending player must move max(1, achievementsClaimedThisRound)
   * cards to decline (see beginDeclinePhase).
   */
  achievementsClaimedThisRound: number
  /**
   * Progress through the `boardSetup` status's tile/unit placement — see
   * BoardSetupState above and src/engine/boardSetup.ts. Null before setup
   * starts (`status: 'lobby'`) and again once it's finished
   * (`status: 'active'`); only meaningful while `status: 'boardSetup'`.
   */
  boardSetup: BoardSetupState | null
  /**
   * Monotonic counter for generating unique unit ids (src/engine/
   * idSequence.ts's nextSequenceId) — kept in GameState itself, not a
   * module-level variable, since the engine runs independently in each
   * player's browser tab and a process-local counter would restart at 0
   * per client and collide the moment two clients each create a unit off
   * their own copy of the shared state. Starts at 0, increments by 1 each
   * time a unit is created (PLACE_UNIT, RESOLVE_UNIT_ACTION's create/
   * transform).
   */
  idSequence: number
  /**
   * Event sourcing: every action applyAction() has accepted and applied so
   * far, in order — including PLACE_TILE/PLACE_UNIT from the board-setup
   * phase, not just round actions. Empty right after createNewGame() +
   * startGame(), since that genesis transition is deterministic from the
   * player roster and current content and isn't itself a dispatched
   * Action; everything from the first PLACE_TILE onward is captured here.
   * Replaying these through applyAction() from that same genesis state
   * always reconstructs this exact GameState (see replayActions in
   * ./replay.ts) — this array *is* "the action history", and the rest of
   * GameState is the cached/materialized "final state" derived from it, so
   * a reader never has to replay from scratch just to see where things
   * stand.
   */
  actionHistory: LoggedAction[]
}

/**
 * The result of applying a single action (applyAction in ./applyAction.ts,
 * and the boardSetup.ts action handlers it delegates PLACE_TILE/PLACE_UNIT
 * to). Declared here rather than in applyAction.ts so boardSetup.ts can
 * return it too without an import cycle.
 */
export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string }
