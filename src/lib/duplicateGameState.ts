// "Duplicate as hot seat" (issue #414): the new room's players rows get
// brand-new ids (players.id is a globally-unique PK, not scoped per game —
// see 0001_init_schema.sql), so every reference to a source-game player id
// inside its GameState/GameSettings has to be rewritten onto the new
// roster before the state can be seeded into the new room. Kept here as a
// small, DB-free module (mirrors gameGenesis.ts) so it can be unit-tested
// without a live Supabase project — gameApi.ts's duplicateGameAsHotseat is
// the only caller.

import type { Board, GameState } from '../engine/types'
import type { GameSettings } from './dbTypes'

/**
 * Rewrites every player-id reference inside a GameState onto a new roster —
 * players[].id, activePlayerId, pendingPlayerIds, chosenCardIdByPlayerId
 * keys, turnOrder, winnerPlayerIds, claimedByAchievementId values,
 * boardSetup.unitsRemainingByPlayerId keys, boardSetup.builderId, every
 * Unit/Card ownerId, and every actionHistory entry's playerId. Deliberately
 * done as one global string substitution over the whole serialized state,
 * rather than a per-field structural walk, so a future field that also
 * happens to carry a player id is remapped for free — safe because player
 * ids are random UUIDs, so an old id can't turn up as a substring of
 * anything else in the state by chance. Every player's `authUserId` is
 * overwritten to `hostUserId` (not looked up in `playerIdMap`, since it's a
 * different id space — the original seat's real auth identity, not its
 * player-row id), matching how the new room's `players.user_id` is the same
 * host account for every seat (see gameApi.ts's addLocalPlayer).
 */
export function remapGameStatePlayerIds(
  state: GameState,
  params: { newGameId: string; playerIdMap: Record<string, string>; hostUserId: string },
): GameState {
  let json = JSON.stringify(state)
  for (const [oldId, newId] of Object.entries(params.playerIdMap)) {
    json = json.split(oldId).join(newId)
  }
  const remapped = JSON.parse(json) as GameState
  remapped.gameId = params.newGameId
  remapped.players = remapped.players.map((p) => ({ ...p, authUserId: params.hostUserId }))
  return remapped
}

/**
 * Same remap for GameSettings' own two player-id fields — soloBuilderId and
 * soloBuilderTurnOrder — so a duplicated game still under `boardSetup`
 * status stays consistent with its own settings if anything ever rebuilds
 * genesis from them (see buildGenesisState in gameGenesis.ts, used by
 * GamePage.tsx's undo feature). Ids missing from the map (shouldn't happen —
 * every source player is always remapped) are left as-is rather than
 * dropped.
 */
export function remapGameSettingsPlayerIds(settings: GameSettings, playerIdMap: Record<string, string>): GameSettings {
  return {
    ...settings,
    soloBuilderId: settings.soloBuilderId ? (playerIdMap[settings.soloBuilderId] ?? settings.soloBuilderId) : settings.soloBuilderId,
    soloBuilderTurnOrder: settings.soloBuilderTurnOrder ? settings.soloBuilderTurnOrder.map((id) => playerIdMap[id] ?? id) : settings.soloBuilderTurnOrder,
  }
}

/**
 * Reconstructs the one piece of GameSettings that importGameExportAsHotseat
 * (gameApi.ts, issue #676) needs to get right for a game that started from a
 * preset board (a map template or a saved map_pool board) — everything else
 * it seeds with harmless defaults, but the map source isn't harmless: it's
 * what buildGenesisState (gameGenesis.ts) uses to rebuild the exact genesis
 * the export's `actionHistory` was recorded against.
 *
 * An export carries no GameSettings at all (see GameStateExportEnvelope), so
 * this infers the source from the GameState alone. A board built the normal
 * interactive way always logs at least one PLACE_TILE action before it's
 * done (or, if genuinely still mid-placement with none logged yet, still has
 * a non-empty `boardSetup.tileTierQueue`) — and beginBoardSetup's tile
 * generation is a deterministic function of turnOrder length + content, so
 * replaying those logged choices against a freshly-generated interactive
 * genesis reproduces the same board. A preset board never logs a PLACE_TILE
 * action at all (beginBoardSetupWithPresetBoard skips straight to unit
 * placement) — so seeding "no map source" there made buildGenesisState
 * rebuild an interactive genesis instead, which expects tile placement
 * before anything else. Replaying the real history's first action (a
 * PLACE_UNIT, or later) against that wrong-shaped genesis then failed
 * immediately, leaving turn review/undo empty even though the final state
 * itself (read straight from storage, no replay involved) displayed fine
 * (issue #680).
 *
 * Returns the preset board to seed as `GameSettings.mapPoolBoard`, or null
 * if the source game built its board interactively. The preset board is
 * derived from the *current* board, with every tile's `occupantIds` cleared
 * back to `[]` — terrain never changes after board setup, only occupancy
 * does, so that's exactly how the board looked at genesis, before any
 * PLACE_UNIT/etc. action touched it.
 */
export function reconstructMapPoolBoardForImport(state: GameState): Board | null {
  const builtInteractively =
    state.actionHistory.some((entry) => entry.action.type === 'PLACE_TILE') ||
    (state.boardSetup !== null && state.boardSetup.tileTierQueue.length > 0)
  if (builtInteractively) return null

  return {
    shape: state.board.shape,
    tiles: Object.fromEntries(Object.entries(state.board.tiles).map(([key, tile]) => [key, { ...tile, occupantIds: [] }])),
  }
}
