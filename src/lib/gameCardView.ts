// Shared view logic for game overview cards, used by every screen that lists
// games (MyGamesPage.tsx, HomePage.tsx, PublicRoomsPage.tsx) — turn
// highlighting and "time ago" labels live here so each screen computes them
// the same way. myGamesView.ts and publicRoomsView.ts wrap these with their
// own entry types.

import { listMapTemplates, listTales, resolveAchievementContent, resolveTaleContent } from '../content/resolveContent'
import { pendingActorIds as pendingActorIdsForState } from '../engine/turnOrder'
import { calculateVPBreakdown } from '../engine/victoryPoints'
import type { GameState as EngineGameState, RoundPhase } from '../engine/types'
import type { GameRow, GameSettings, PlayerRow } from './dbTypes'

/** The seated players who must act next, or `[]` if nobody's turn is pending (lobby/completed). */
export function pendingActorIdsFor(gameState: EngineGameState | null): string[] {
  return gameState ? pendingActorIdsForState(gameState) : []
}

/** True if any of `myPlayerIds` is one of the players pendingActorIdsFor() says must act next. */
export function isMyTurnFor(gameState: EngineGameState | null, myPlayerIds: string[]): boolean {
  const pending = pendingActorIdsFor(gameState)
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
  return `Finished at ${new Date(isoTimestamp).toLocaleString()}`
}

/**
 * The real "last activity" timestamp for a game: `games.updated_at` only
 * changes for lobby-era edits (settings, status, visibility — see
 * 0001_init_schema.sql's `games_set_updated_at` trigger), never for
 * gameplay actions, which only touch the separate `game_state` row (its own
 * `game_state_set_updated_at` trigger). Once a game_state row exists, its
 * `updated_at` is almost always the more recent of the two — this just
 * guards against the rare edge case (e.g. a settings edit right after
 * insertGameState) where `games.updated_at` is actually newer.
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
 * #293 section 4. Everything this reads (gameState.status/roundPhase) is
 * already fetched for turn/finished classification, so no DB change is
 * needed to break "active" apart into its actual round phase.
 */
export function describeGamePhase(game: GameRow, gameState: EngineGameState | null): string {
  if (game.status === 'canceled') return 'Canceled'
  if (!gameState) return 'Waiting in lobby'
  if (gameState.status === 'boardSetup') return 'Setting up board'
  if (gameState.status === 'completed') return 'Finished'
  return ROUND_PHASE_LABEL[gameState.roundPhase]
}

export interface GameCardScore {
  playerId: string
  name: string
  color: string
  score: number
}

/**
 * Everything GameOverviewCard.tsx shows beyond name/players/phase — issue
 * #204. `playerRange`/`mapBuildStyle` are only meaningful pre-game (see
 * dbTypes.ts's GameSettings comment: settings stop being read once a
 * game_state row exists), so both are null once `gameState` is non-null.
 * `scores`/`roundNumber` are the reverse — null until there's a GameState to
 * read them from. `winnerNames` is only ever non-empty once the game has
 * actually finished (GameState.winnerPlayerIds).
 */
export interface GameCardSummary {
  playerRange: string | null
  mapBuildStyle: string | null
  /** Active Tale names ("modules" in the issue) — content/tales.json, empty when the Tales variant is off. */
  moduleNames: string[]
  roundNumber: number | null
  scores: GameCardScore[] | null
  winnerNames: string[]
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
 * which fields end up non-null depends entirely on `gameState` (see
 * GameCardSummary's doc comment), so callers don't need their own
 * phase-classification logic just to fill this in.
 */
export function buildGameCardSummary(game: GameRow, gameState: EngineGameState | null, players: PlayerRow[]): GameCardSummary {
  const moduleNames = game.settings.activeTaleIds.map((id) => listTales().find((t) => t.id === id)?.name ?? id)

  let scores: GameCardScore[] | null = null
  const winnerNames: string[] = []

  if (gameState) {
    const achievementContent = resolveAchievementContent(gameState.gameLength)
    const taleContent = resolveTaleContent(gameState.activeTaleIds, gameState.players.length)
    const breakdown = calculateVPBreakdown(gameState, achievementContent, taleContent)
    const winnerIds = new Set(gameState.winnerPlayerIds)

    scores = gameState.players.map((player) => ({
      playerId: player.id,
      name: players.find((row) => row.id === player.id)?.display_name ?? player.displayName,
      color: players.find((row) => row.id === player.id)?.color ?? player.color,
      score: breakdown[player.id]?.total ?? 0,
    }))

    for (const player of gameState.players) {
      if (winnerIds.has(player.id)) {
        winnerNames.push(players.find((row) => row.id === player.id)?.display_name ?? player.displayName)
      }
    }
  }

  return {
    playerRange: gameState ? null : `${game.min_players}–${game.max_players} players`,
    mapBuildStyle: gameState ? null : mapBuildStyleLabel(game.settings),
    moduleNames,
    roundNumber: gameState ? gameState.turn : null,
    scores,
    winnerNames,
  }
}
