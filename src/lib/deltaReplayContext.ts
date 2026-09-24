/**
 * Rebuilds everything the delta read path needs to replay actions locally,
 * from a cached `GameState` alone — no network, no waiting for the roster.
 *
 * WHY THIS EXISTS (todo.md #147): `GamePage.tsx`'s mount effect fetches the
 * game state and the players roster together, so at the moment the state
 * request goes out `players` is still empty, `genesis` is therefore null, and
 * the request cannot ask for a protocol-2 delta. A cold open — which for this
 * app's async usage is *most* opens — fell back to the pre-#648 contract and
 * still shipped the whole `stateWithoutHistory`, cached base or not. The
 * symptom was an `x-state-reason: protocol-1` on every refresh.
 *
 * The way out is that none of it actually needs the table. `buildGenesisState`
 * reads exactly four player columns (`GenesisPlayerInput`), and a cached
 * `GameState`'s own `players` carry all four. So genesis is reconstructable
 * from the cache plus the `games` row, which the mount effect already has in
 * hand before it runs.
 *
 * CONTENT COMES FROM THE STATE, NOT THE ROSTER, and that is not incidental:
 * `GameState.players` is fixed at genesis and never shrinks (elimination flags
 * a player rather than removing them), while the live `players` table can
 * disagree. Resolving content against the table is what gave a 2-player game
 * the 3-player board-generation pool in issue #519 — see GamePage.tsx's
 * `contentPlayerCount` comment. `activeTaleIds` is read off the state for the
 * same self-contained reason.
 *
 * A stale cache is not a hazard here. If the roster changed since it was
 * written, the reconstructed genesis differs, the replay lands somewhere the
 * server disagrees with, the hash check fails, and the client pays for one
 * full fetch — the same fallback every other mismatch takes.
 */
import { applyTaleModifiers, applyTaleAchievementModifiers } from '../engine/tales'
import { resolveAchievementContent, resolveBoardGenerationContent, resolveTaleContent, resolveUnitContent } from '../content/resolveContent'
import { buildGenesisState } from './gameGenesis'
import type { GameRow } from './dbTypes'
import type { GameState } from '../engine/types'
import type { AchievementContent } from '../engine/achievementContent'
import type { BoardGenerationContent } from '../engine/boardGenerationContent'
import type { TaleContent } from '../engine/taleContent'
import type { UnitContent } from '../engine/unitContent'

/**
 * Everything `getGameStateRedacted` needs to rebuild a state from actions
 * rather than be handed one. Lives here rather than in gameApi.ts so it can be
 * built and tested without importing the Supabase client, which throws at
 * import time when the app's env vars are absent.
 */
export interface DeltaReplayContext {
  genesis: GameState
  unitContent: UnitContent
  achievementContent: AchievementContent
  boardGenerationContent: BoardGenerationContent
  taleContent: TaleContent
}

/**
 * `null` when genesis cannot be rebuilt — a state with no players, or a
 * `games` row whose settings no longer describe a game this engine can
 * construct. Both mean "ask for a full state", never an error.
 */
export function buildDeltaReplayContextFromState(game: GameRow, state: GameState): DeltaReplayContext | null {
  if (state.players.length === 0) return null
  try {
    const genesis = buildGenesisState(
      game,
      state.players.map((player) => ({
        id: player.id,
        user_id: player.authUserId,
        display_name: player.displayName,
        color: player.color,
      })),
    )
    const playerCount = state.players.length
    const taleContent = resolveTaleContent(state.activeTaleIds ?? [], playerCount)
    return {
      genesis,
      taleContent,
      boardGenerationContent: resolveBoardGenerationContent(playerCount),
      unitContent: applyTaleModifiers(resolveUnitContent(playerCount), taleContent),
      achievementContent: applyTaleAchievementModifiers(resolveAchievementContent(state.gameLength), taleContent),
    }
  } catch {
    return null
  }
}
