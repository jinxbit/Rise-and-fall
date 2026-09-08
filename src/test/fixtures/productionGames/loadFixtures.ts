// Turns a game export copied out of production into everything a test needs
// to replay it against the Supabase stack.
//
// The input is the app's own export file — the exact JSON the "Copy game
// export" button on GamePage.tsx produces (see src/lib/gameStateExport.ts),
// dropped into this directory unmodified. That file carries a single
// GameState, which is enough on its own: `actionHistory` is the whole game
// (see GameState.actionHistory's doc comment), and the `games`/`players` rows
// the Edge Functions need around it are reconstructable from the state plus
// the history, as `reconstructRoom` below explains. A `<name>.room.json`
// sidecar can override any of that when a game's real room row is available
// or the inference can't work it out.
//
// Every fixture is verified at load time: the reconstructed genesis is
// replayed through the engine and must reproduce the exported final state
// exactly. A fixture that doesn't is rejected with a message saying so,
// rather than being handed to a test that would then "pass" against a game
// that never happened.

import { resolveHistory } from '../../../engine/historyFold.ts'
import { replayActions } from '../../../engine/replay.ts'
import type { Board, GameState } from '../../../engine/types.ts'
import { calculateVPBreakdown } from '../../../engine/victoryPoints.ts'
import { buildGenesisState } from '../../../lib/gameGenesis.ts'
import type { GameRow, GameSettings, PlayerRow } from '../../../lib/dbTypes.ts'
import { decodeGameStateExport } from '../../../lib/gameStateExport.ts'
import { resolveGameContent, type GameContent } from '../../supabaseStack/sampleGame.ts'

/**
 * What a game is expected to have *ended* as, declared in the sidecar rather
 * than derived — the point being that it comes from outside the code under
 * test. A scoring change that silently moves every game's total would still
 * satisfy "the replay matches the export" (both sides move together); it
 * cannot satisfy a number a human read off the end-of-game screen and wrote
 * down here.
 *
 * Players are named by display name or by engine player id, whichever is
 * easier to read for that game; an ambiguous or unknown name is an error at
 * load time, not a silently skipped assertion.
 */
export interface ExpectedResult {
  /** Final total VP per player — the "Final score" figures on EndGameView.tsx. */
  finalScores?: Record<string, number>
  /** Who won. Empty array asserts nobody did (an unfinished game). */
  winners?: string[]
}

/** Optional `<name>.room.json` sidecar — anything here wins over what `reconstructRoom` infers. */
export interface RoomOverrides {
  /** The game's recorded outcome, asserted against the replay. */
  expected?: ExpectedResult
  createdBy?: string
  roomCode?: string
  name?: string
  visibility?: GameRow['visibility']
  /** Auth user ids to mark `profiles.is_admin` — §4.5's carve-out. */
  admins?: string[]
  settings?: Partial<GameSettings>
  /** Auth user id per engine player id, for a game whose export predates authUserId being populated. */
  userIdByPlayerId?: Record<string, string>
}

export interface ProductionGameFixture {
  /** File name without extension — becomes the test name. */
  name: string
  exportedAt: string
  game: GameRow
  players: PlayerRow[]
  /** The state the game started from, rebuilt by gameGenesis.ts exactly as the server rebuilds it for undo/redo. */
  genesis: GameState
  /** The state as exported from production — what a replay has to reproduce. */
  finalState: GameState
  content: GameContent
  /** Which signed-in user submits a given seat's actions. */
  userIdForPlayer(playerId: string): string
  /** The sidecar's declared outcome, resolved to player ids — absent when the sidecar doesn't declare one. */
  expected: { finalScoreByPlayerId?: Record<string, number>; winnerPlayerIds?: string[] }
  /** Final total VP per player for any state of this game, the same way EndGameView.tsx computes the "Final score" column. */
  finalScores(state: GameState): Record<string, number>
  /** `playerId` rendered for a failure message: display name plus colour. */
  describePlayer(playerId: string): string
}

/** applyAction() stamps wall-clock time, so two independently-produced states never match byte-for-byte there even when every game-logic field does. */
export function stripTimestamps(state: GameState): GameState {
  return { ...state, actionHistory: state.actionHistory.map((entry) => ({ ...entry, timestamp: '' })) }
}

/**
 * `JSON.stringify` with object keys sorted, so two structurally identical
 * states compare equal regardless of the order their keys happen to be in.
 * A replayed state is built field by field by applyAction(); an exported one
 * is whatever order it was serialized in — plain `JSON.stringify` calls those
 * two different, which would make every fixture look unreconstructable. Array
 * order is left alone: it is meaningful everywhere it appears here (turn
 * order, action history, a player's cards).
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Two states compared as the same *game*, not as the same bytes.
 *
 * `adminModeActive` is documented as "absent means false" (see its doc
 * comment in src/engine/types.ts). A state parsed from an export written
 * before that field existed has no key at all; one the engine just built
 * always has it. Reading the two as equal is honouring the documented
 * equivalence, not hiding a difference.
 *
 * `declineSourceZoneByCardId` is compared only while a decline phase is
 * actually open, which is the only window anything reads it: it exists so
 * RETRACT_DECLINE can put a card back where it came from, and RETRACT_DECLINE
 * is legal only during that phase. Its own doc comment is explicit that it is
 * "live scratch state for what to do right now, not part of the replayable
 * action log" — and a real game bears that out: three-player-red-runaway's
 * exported state carries only the last player's two entries from its final
 * decline phase, where a replay against today's engine derives all six.
 * Nothing in that game depends on the difference (the phase closed long
 * before it ended), and every field that does describe the game matches
 * exactly.
 */
export function normalizeStateForComparison(state: GameState): GameState {
  const declinePhaseOpen = state.status === 'active' && state.roundPhase === 'decline'
  return {
    ...stripTimestamps(state),
    adminModeActive: Boolean(state.adminModeActive),
    declineSourceZoneByCardId: declinePhaseOpen ? (state.declineSourceZoneByCardId ?? {}) : {},
  }
}

/** Which top-level GameState fields two states disagree on — the useful half of a "this fixture doesn't reconstruct" message. */
function divergentFields(left: GameState, right: GameState): string[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof GameState>
  return [...keys].filter((key) => stableStringify(left[key]) !== stableStringify(right[key]))
}

/** The terrain layout with every unit cleared off it — a preset-board game's genesis board, recovered from its final board (only PLACE_TILE ever changes terrain). */
function boardWithoutUnits(board: Board): Board {
  return {
    shape: board.shape,
    tiles: Object.fromEntries(Object.entries(board.tiles).map(([key, tile]) => [key, { ...tile, occupantIds: [] }])),
  }
}

/**
 * Recovers the `games` row a game must have had.
 *
 * Most of it is carried on the state itself (`gameId`, `playMode`,
 * `activeTaleIds`, `gameLength`). The map settings aren't, but the history
 * gives them away:
 *
 * - No PLACE_TILE at all means the game started from a preset board, so the
 *   final board's terrain *is* the genesis board (nothing but PLACE_TILE ever
 *   changes terrain) — recovered here as `mapPoolBoard`, which
 *   buildGenesisState feeds to startGameWithPresetBoard exactly as a map
 *   template would.
 * - PLACE_TILE entries that all name the same player mean "build alone"
 *   (GameSettings.soloBuildMap); the starting-unit rotation that follows
 *   spells out the genesis `turnOrder` directly, since unit placement always
 *   walks turnOrder in order. Both are pinned explicitly rather than left to
 *   be re-resolved, which is what the 'random' options are for.
 * - Otherwise it's an ordinary "build together" game: seat order is turn
 *   order, and genesis needs nothing else.
 *
 * `ruleEnforcementEnabled` is forced on. A production game may well have been
 * played client-trusted, but replaying it through the Edge Functions is the
 * entire point of these tests — a game that only ever wrote `game_state`
 * directly wouldn't exercise a single line of enforcement.
 */
function reconstructRoom(finalState: GameState, overrides: RoomOverrides): { game: GameRow; players: PlayerRow[] } {
  const effective = resolveHistory(finalState.actionHistory).effective
  // PLACE_TILE/PLACE_UNIT always name a seat (only the pointer-move and
  // admin-mode actions have a nullable, narration-only playerId), but the
  // union type doesn't say so — hence the filter.
  const placerIdsFor = (type: 'PLACE_TILE' | 'PLACE_UNIT'): string[] => [
    ...new Set(effective.filter((entry) => entry.action.type === type).map((entry) => entry.action.playerId).filter((id): id is string => id !== null)),
  ]
  const tilePlacers = placerIdsFor('PLACE_TILE')
  const unitPlacementOrder = placerIdsFor('PLACE_UNIT')

  const seatOrder = finalState.players
  const ownerUserId =
    overrides.createdBy ?? overrides.userIdByPlayerId?.[seatOrder[0].id] ?? seatOrder[0].authUserId ?? `synthetic-user-${seatOrder[0].id}`

  const players: PlayerRow[] = seatOrder.map((player, index) => ({
    id: player.id,
    game_id: finalState.gameId,
    user_id: overrides.userIdByPlayerId?.[player.id] ?? player.authUserId ?? ownerUserId,
    display_name: player.displayName,
    avatar_url: null,
    seat_index: index,
    color: player.color,
    is_active: true,
    ready_for_version: 1,
    joined_at: new Date(0).toISOString(),
  }) as PlayerRow)

  let mapSettings: Partial<GameSettings>
  if (tilePlacers.length === 0) {
    mapSettings = { mapPoolBoard: boardWithoutUnits(finalState.board), mapPoolMapId: 'reconstructed-from-export' }
  } else if (tilePlacers.length === 1 && seatOrder.length > 1) {
    mapSettings = {
      soloBuildMap: true,
      soloBuilderSelection: 'random',
      soloBuilderId: tilePlacers[0],
      soloBuilderUnitOrder: 'random',
      soloBuilderTurnOrder: unitPlacementOrder.length === seatOrder.length ? unitPlacementOrder : seatOrder.map((player) => player.id),
    }
  } else {
    mapSettings = {}
  }

  const settings: GameSettings = {
    mapTemplateId: null,
    mapPoolBoard: null,
    mapPoolMapId: null,
    mapPoolRandomAtStart: false,
    soloBuildMap: false,
    soloBuilderSelection: 'owner',
    soloBuilderId: null,
    soloBuilderUnitOrder: 'last',
    soloBuilderTurnOrder: null,
    skipHotseatPassGate: false,
    ruleEnforcementEnabled: true,
    activeTaleIds: finalState.activeTaleIds,
    gameLength: finalState.gameLength,
    ...mapSettings,
    ...overrides.settings,
  }

  const game: GameRow = {
    id: finalState.gameId,
    room_code: overrides.roomCode ?? 'PRODX',
    name: overrides.name ?? 'Replayed production game',
    play_mode: finalState.playMode,
    // Never 'lobby': the game has started, and 0021_remove_observers.sql's
    // read policy keys off exactly that (see database.ts).
    status: 'active',
    min_players: seatOrder.length,
    max_players: seatOrder.length,
    created_by: ownerUserId,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    settings,
    config_version: 1,
    visibility: overrides.visibility ?? 'private',
  }

  return { game, players }
}

/** Builds (and self-verifies) a fixture from one export file's text. Exported so a test can build a fixture from a string rather than the directory. */
export function buildFixture(name: string, envelope: { exportedAt: string; gameState: GameState }, overrides: RoomOverrides = {}): ProductionGameFixture {
  const finalState = envelope.gameState
  const { game, players } = reconstructRoom(finalState, overrides)
  const genesis = buildGenesisState(game, players)
  const content = resolveGameContent(finalState, players.length)

  const replayed = replayActions(
    genesis,
    finalState.actionHistory,
    content.unitContent,
    content.achievementContent,
    content.boardGenerationContent,
    content.taleContent,
  )
  const diverged = divergentFields(normalizeStateForComparison(replayed), normalizeStateForComparison(finalState))
  if (diverged.length > 0) {
    throw new Error(
      `Fixture "${name}" could not be reconstructed: replaying its action history from the rebuilt genesis produced a different state than the export ` +
        `(disagrees on ${diverged.join(', ')}). The room settings were inferred from the history (see reconstructRoom) — add a ${name}.room.json ` +
        `sidecar with the game's real \`settings\` to fix this.`,
    )
  }

  const userIdByPlayerId = new Map(players.map((player) => [player.id, player.user_id]))

  /** Resolves a sidecar's player reference — a display name or a player id — to exactly one seat. */
  const resolvePlayerId = (reference: string): string => {
    const byId = finalState.players.filter((player) => player.id === reference)
    const byName = finalState.players.filter((player) => player.displayName === reference)
    const matches = byId.length > 0 ? byId : byName
    if (matches.length === 0) {
      throw new Error(`Fixture "${name}" declares a result for "${reference}", which is neither a player id nor a display name in this game.`)
    }
    if (matches.length > 1) {
      throw new Error(`Fixture "${name}" declares a result for "${reference}", but ${matches.length} players share that display name — use their player ids instead.`)
    }
    return matches[0].id
  }

  const expectedScores = overrides.expected?.finalScores
  const expectedWinners = overrides.expected?.winners

  return {
    name,
    exportedAt: envelope.exportedAt,
    game,
    players,
    genesis,
    finalState,
    content,
    userIdForPlayer: (playerId) => {
      const userId = userIdByPlayerId.get(playerId)
      if (!userId) throw new Error(`Fixture "${name}" has no seat for player ${playerId}.`)
      return userId
    },
    expected: {
      finalScoreByPlayerId: expectedScores && Object.fromEntries(Object.entries(expectedScores).map(([reference, score]) => [resolvePlayerId(reference), score])),
      winnerPlayerIds: expectedWinners?.map(resolvePlayerId),
    },
    finalScores: (state) => {
      const breakdown = calculateVPBreakdown(state, content.achievementContent, content.taleContent)
      return Object.fromEntries(state.players.map((player) => [player.id, breakdown[player.id]?.total ?? 0]))
    },
    describePlayer: (playerId) => {
      const player = finalState.players.find((candidate) => candidate.id === playerId)
      return player ? `${player.displayName} (${player.color})` : playerId
    },
  }
}

/**
 * Every export file in this directory, loaded and verified. Drop a `.json`
 * export in and it shows up here (and so in the tests) with no other change.
 */
export async function loadProductionGameFixtures(): Promise<ProductionGameFixture[]> {
  const files = import.meta.glob('./*.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

  const overridesByName: Record<string, RoomOverrides> = {}
  const exportsByName: Record<string, string> = {}
  for (const [path, text] of Object.entries(files)) {
    const fileName = path.replace(/^\.\//, '')
    if (fileName.endsWith('.room.json')) {
      overridesByName[fileName.slice(0, -'.room.json'.length)] = JSON.parse(text) as RoomOverrides
    } else {
      exportsByName[fileName.slice(0, -'.json'.length)] = text
    }
  }

  const fixtures: ProductionGameFixture[] = []
  for (const name of Object.keys(exportsByName).sort()) {
    const envelope = await decodeGameStateExport(exportsByName[name])
    fixtures.push(buildFixture(name, envelope, overridesByName[name] ?? {}))
  }
  return fixtures
}
