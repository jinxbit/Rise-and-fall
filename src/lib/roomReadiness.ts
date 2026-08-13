// Pure readiness logic for the room lifecycle spec's configuration
// versioning (issue #40, section 9). Split out from LobbyPage.tsx so it can
// be unit tested without a real Supabase project, same reason as
// myGamesView.ts/seatIndex.ts.

import type { GameRow, PlayerRow } from './dbTypes'

/**
 * The Owner is exempt from readiness (issue section 9): they always see
 * their own pending config changes, so there's nothing to acknowledge.
 * Everyone else is ready iff their ready_for_version matches the room's
 * current config_version — set automatically on join (0009_config_versioning.sql)
 * and only stale once the Owner edits settings afterward.
 */
export function isPlayerReady(game: GameRow, player: PlayerRow): boolean {
  if (player.user_id === game.created_by) return true
  return player.ready_for_version === game.config_version
}

/** True once every non-Owner seated player has acknowledged the current config version. */
export function allPlayersReady(game: GameRow, players: PlayerRow[]): boolean {
  return players.every((p) => isPlayerReady(game, p))
}

/**
 * Start Game's full gate (issue section 10): lobby, player count within
 * bounds, and everyone ready. Ownership itself is checked by the caller
 * (LobbyPage.tsx already knows `isCreator`) since that's not derivable from
 * game/players alone without a userId.
 */
export function canStartGame(game: GameRow, players: PlayerRow[]): boolean {
  return (
    game.status === 'lobby' &&
    players.length >= game.min_players &&
    players.length <= game.max_players &&
    allPlayersReady(game, players)
  )
}
