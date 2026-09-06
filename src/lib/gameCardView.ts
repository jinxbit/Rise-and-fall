// Shared view logic for game overview cards, used by every screen that lists
// games (MyGamesPage.tsx, HomePage.tsx, PublicRoomsPage.tsx) — turn
// highlighting and "time ago" labels live here so each screen computes them
// the same way. myGamesView.ts and publicRoomsView.ts wrap these with their
// own entry types.

import { listMapTemplates, listTales } from '../content/resolveContent'
import type { GameStatus, RoundPhase } from '../engine/types'
import type { GameRow, GameSettings } from './dbTypes'

/**
 * Lightweight, cheap-to-query summary of a game's `game_state` row for
 * listing screens (issue #441): `status`/`roundPhase`/`turn` come from the
 * pre-existing `game_state_meta` projection (`0025_game_state_meta.sql`,
 * kept in sync by a DB trigger on every `game_state` write), and
 * `activePlayerId` from `game_state.active_player_id` — both plain scalar
 * columns, never the compressed `game_state.state` blob that used to be
 * downloaded and decompressed for every listed game (the actual cause of
 * issue #441's repeated multi-MB bandwidth). `null` means no `game_state`
 * row exists yet (the game is still in the lobby), same meaning `gameState`
 * used to carry.
 *
 * This intentionally can't answer everything the full `GameState` could:
 * - `activePlayerId` is only meaningful outside the simultaneous
 *   `selectCards`/`decline` round phases (see engine/types.ts's
 *   `GameState.activePlayerId`) — during those, and during `boardSetup`,
 *   `pendingActorIdsFor` below can't recover who's actually pending (that's
 *   `state.pendingPlayerIds`/the board-setup placer, neither of which is
 *   denormalized anywhere) and deliberately reports "nobody" rather than
 *   guessing, so a card's turn highlighting degrades to silence in those
 *   windows, never a false positive.
 * - Per-player scores/VP breakdown (issue #204) needed the full
 *   `GameState.players` plus achievement/tale content to compute — there's
 *   no cheap projection of that, so it's no longer available on listing
 *   cards at all; open the game itself to see current scores.
 */
export interface GameStateSummary {
  status: GameStatus
  roundPhase: RoundPhase | null
  turn: number
  activePlayerId: string | null
}

/**
 * The seated players who must act next, or `[]` if nobody's turn is pending
 * (lobby/completed/boardSetup/a simultaneous selectCards-decline phase — see
 * GameStateSummary's doc comment for why the latter two can't be answered
 * from this summary alone).
 */
export function pendingActorIdsFor(summary: GameStateSummary | null): string[] {
  if (!summary || summary.status !== 'active') return []
  if (summary.roundPhase === 'selectCards' || summary.roundPhase === 'decline') return []
  return summary.activePlayerId ? [summary.activePlayerId] : []
}

/** True if any of `myPlayerIds` is one of the players pendingActorIdsFor() says must act next. */
export function isMyTurnFor(summary: GameStateSummary | null, myPlayerIds: string[]): boolean {
  const pending = pendingActorIdsFor(summary)
  return myPlayerIds.some((id) => pending.includes(id))
}

/**
 * Short "time ago" label for a game's games.updated_at. `now` is injectable
 * for tests; defaults to the real current time.
 */
export function formatUpdatedAt(isoTimestamp: string, now: Date = new Date()): string {
  const updated = new Date(isoTimestamp)
  const diffMinutes = Math.round((now.getTime() - updated.getTime()) / 60_000)

  if (diffMinutes < 1) return 'Updated just now'
  if (diffMinutes < 60) return `Updated ${diffMinutes}m ago`
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `Updated ${diffHours}h ago`
  const diffDays = Math.round(diffHours / 24)
  if (diffDays < 7) return `Updated ${diffDays}d ago`
  return `Updated ${updated.toLocaleDateString()}`
}

/**
 * Absolute "Finished at" label for a completed game (issue #364) — shown
 * instead of the phase + relative "Updated ... ago" pair once a game is
 * done, since neither "Finished" nor a relative time is useful once nothing
 * more will happen. There's no dedicated `finished_at` column (see
 * dbTypes.ts's GameStateRow); the game_state row's `updated_at` is the
 * closest proxy, since no further writes happen to it once a game completes.
 */
export function formatFinishedAt(isoTimestamp: string): string {
  return `Finished at ${new Date(isoTimestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
}

/**
 * The real "last activity" timestamp for a game: `games.updated_at` only
 * changes for lobby-era edits (settings, status, visibility — see
 * 0001_init_schema.sql's `games_set_updated_at` trigger), never for
 * gameplay actions, which only touch the separate `game_state` row (its own
 * `game_state_set_updated_at` trigger, mirrored onto `game_state_meta` by
 * `game_state_sync_meta`). Once a game_state row exists, its `updated_at` is
 * almost always the more recent of the two — this just guards against the
 * rare edge case (e.g. a settings edit right after insertGameState) where
 * `games.updated_at` is actually newer.
 */
export function latestUpdatedAt(game: GameRow, gameStateUpdatedAt: string | null): string {
  if (!gameStateUpdatedAt) return game.updated_at
  return new Date(gameStateUpdatedAt).getTime() > new Date(game.updated_at).getTime() ? gameStateUpdatedAt : game.updated_at
}

const ROUND_PHASE_LABEL: Record<RoundPhase, string> = {
  selectCards: 'Choosing cards',
  actions: 'Resolving actions',
  decline: 'Declining cards',
  purchase: 'Purchasing',
}

/**
 * What a game card should show in place of a blanket "In progress" — issue
 * #293 section 4. Reads only `summary.status`/`roundPhase`, both already
 * covered by the cheap `game_state_meta` projection (see GameStateSummary),
 * so no full `game_state` read is needed to break "active" apart into its
 * actual round phase.
 */
export function describeGamePhase(game: GameRow, summary: GameStateSummary | null): string {
  if (game.status === 'canceled') return 'Canceled'
  if (!summary) return 'Waiting in lobby'
  if (summary.status === 'boardSetup') return 'Setting up board'
  if (summary.status === 'completed') return 'Finished'
  return ROUND_PHASE_LABEL[summary.roundPhase as RoundPhase]
}

/**
 * Everything GameOverviewCard.tsx shows beyond name/players/phase, minus the
 * per-player score breakdown issue #204 originally added there — that needed
 * the full `GameState.players` plus achievement/tale content to compute a VP
 * breakdown, which isn't available from the cheap GameStateSummary (issue
 * #441), so listing cards no longer show it at all; open the game itself to
 * see current scores. `playerRange`/`mapBuildStyle` are only meaningful
 * pre-game (see dbTypes.ts's GameSettings comment: settings stop being read
 * once a game_state row exists), so both are null once `summary` is
 * non-null. `roundNumber` is the reverse — null until there's a summary to
 * read it from.
 */
export interface GameCardSummary {
  playerRange: string | null
  mapBuildStyle: string | null
  /** Active Tale names ("modules" in the issue) — content/tales.json, empty when the Tales variant is off. */
  moduleNames: string[]
  roundNumber: number | null
}

function mapBuildStyleLabel(settings: GameSettings): string {
  if (settings.mapTemplateId) {
    return listMapTemplates().find((t) => t.id === settings.mapTemplateId)?.name ?? settings.mapTemplateId
  }
  if (settings.mapPoolBoard) return 'Random saved map'
  if (settings.mapPoolRandomAtStart) return 'Random saved map (picked at start)'
  if (settings.soloBuildMap) {
    return `Interactive (built alone by ${settings.soloBuilderSelection === 'random' ? 'a random player' : 'the host'})`
  }
  return 'Interactive (built together)'
}

/**
 * Builds the config summary a game card shows on top of its player list —
 * which fields end up non-null depends entirely on `summary` (see
 * GameCardSummary's doc comment), so callers don't need their own
 * phase-classification logic just to fill this in.
 */
export function buildGameCardSummary(game: GameRow, summary: GameStateSummary | null): GameCardSummary {
  const moduleNames = game.settings.activeTaleIds.map((id) => listTales().find((t) => t.id === id)?.name ?? id)

  return {
    playerRange: summary ? null : `${game.min_players}–${game.max_players} players`,
    mapBuildStyle: summary ? null : mapBuildStyleLabel(game.settings),
    moduleNames,
    roundNumber: summary ? summary.turn : null,
  }
}
