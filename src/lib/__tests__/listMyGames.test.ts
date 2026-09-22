// @vitest-environment node
//
// Regression coverage for issue #687: listMyGames used to fetch every game
// the user had ever been seated in, in full, on every app open — with no
// ceiling, that grows for the life of an account. This exercises the fix
// directly against the production-simulating stack (src/test/supabaseStack/)
// rather than hand-copying the query, the same pattern
// startGameFromLobby.test.ts uses: the mocked `supabase` singleton is
// swapped to whichever user is "querying," so gameApi.ts's real listMyGames
// runs against real RLS.
//
// Completed games are seeded directly via `stack.db.seed` (games/players/
// game_state_meta rows) rather than played to completion through
// apply-action — cheap enough to seed dozens of them, which is the point:
// this is exactly the shape a long-lived account accumulates.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GameRow, GameSettings, PlayerRow } from '../dbTypes.ts'

let currentClient: SupabaseClient
vi.mock('../supabase', () => ({
  get supabase() {
    return currentClient
  },
}))

const { listMyGames, FINISHED_GAMES_LIMIT } = await import('../gameApi.ts')
const { createProductionStack } = await import('../../test/supabaseStack/index.ts')
type ProductionStack = Awaited<ReturnType<typeof createProductionStack>>

const USER = 'alice-user-id'
const OTHER = 'bob-user-id'

function settings(overrides: Partial<GameSettings> = {}): GameSettings {
  return {
    mapTemplateId: 'classic',
    mapPoolBoard: null,
    mapPoolMapId: null,
    mapPoolRandomAtStart: false,
    soloBuildMap: false,
    soloBuilderSelection: 'owner',
    soloBuilderId: null,
    soloBuilderUnitOrder: 'last',
    soloBuilderTurnOrder: null,
    skipHotseatPassGate: false,
    ruleEnforcementEnabled: false,
    hiddenInformationEnabled: false,
    lockRevealedInformationEnabled: false,
    activeTaleIds: [],
    gameLength: 4,
    ...overrides,
  }
}

function seedGame(
  stack: ProductionStack,
  id: string,
  status: GameRow['status'],
  updatedAt: string,
): GameRow {
  const game: GameRow = {
    id,
    room_code: id.slice(0, 6).toUpperCase(),
    name: `Game ${id}`,
    play_mode: 'live',
    status,
    min_players: 2,
    max_players: 2,
    created_by: USER,
    created_at: updatedAt,
    updated_at: updatedAt,
    settings: settings(),
    config_version: 1,
    visibility: 'private',
  }
  stack.db.seed('games', game as unknown as Record<string, unknown>)
  return game
}

function seedPlayer(stack: ProductionStack, id: string, gameId: string, userId: string, seatIndex: number): void {
  const player: PlayerRow = {
    id,
    game_id: gameId,
    user_id: userId,
    display_name: userId,
    avatar_url: null,
    seat_index: seatIndex,
    color: '#e11',
    is_active: true,
    joined_at: new Date(0).toISOString(),
    ready_for_version: 1,
  }
  stack.db.seed('players', player as unknown as Record<string, unknown>)
}

function seedMeta(stack: ProductionStack, gameId: string, status: 'active' | 'completed', updatedAt: string): void {
  stack.db.seed('game_state_meta', {
    game_id: gameId,
    status,
    round_phase: status === 'completed' ? null : 'actions',
    turn: 1,
    version: 1,
    pending_player_ids: [],
    active_player_id: null,
    updated_at: updatedAt,
  })
}

describe('listMyGames (issue #687)', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
    stack.addUser(USER, { displayName: 'Alice' })
    stack.addUser(OTHER, { displayName: 'Bob' })
    currentClient = stack.clientFor(USER)
  })

  afterEach(() => {
    stack.dispose()
  })

  it('caps completed games at FINISHED_GAMES_LIMIT, keeping the most recently updated', async () => {
    const totalCompleted = FINISHED_GAMES_LIMIT + 5
    for (let i = 0; i < totalCompleted; i++) {
      const gameId = `completed-${String(i).padStart(3, '0')}`
      const updatedAt = new Date(i * 1000).toISOString()
      seedGame(stack, gameId, 'active', updatedAt)
      seedPlayer(stack, `${gameId}-seat`, gameId, USER, 0)
      seedMeta(stack, gameId, 'completed', updatedAt)
    }

    const entries = await listMyGames(USER)
    expect(entries).toHaveLength(FINISHED_GAMES_LIMIT)

    const includedIds = new Set(entries.map((e) => e.game.id))
    // The most recently updated FINISHED_GAMES_LIMIT games (highest indices,
    // since updatedAt increases with i) must all have made the cut.
    for (let i = totalCompleted - FINISHED_GAMES_LIMIT; i < totalCompleted; i++) {
      expect(includedIds.has(`completed-${String(i).padStart(3, '0')}`)).toBe(true)
    }
    // The oldest ones must not have.
    expect(includedIds.has('completed-000')).toBe(false)
  })

  it('never bounds active, lobby, or canceled games — only the completed bucket', async () => {
    seedGame(stack, 'active-1', 'active', new Date(1000).toISOString())
    seedPlayer(stack, 'active-1-seat', 'active-1', USER, 0)
    seedMeta(stack, 'active-1', 'active', new Date(1000).toISOString())

    seedGame(stack, 'lobby-1', 'lobby', new Date(2000).toISOString())
    seedPlayer(stack, 'lobby-1-seat', 'lobby-1', USER, 0)
    // No game_state_meta row — a lobby game has none yet.

    seedGame(stack, 'canceled-1', 'canceled', new Date(3000).toISOString())
    seedPlayer(stack, 'canceled-1-seat', 'canceled-1', USER, 0)

    const entries = await listMyGames(USER)
    const ids = entries.map((e) => e.game.id).sort()
    expect(ids).toEqual(['active-1', 'canceled-1', 'lobby-1'])

    const active = entries.find((e) => e.game.id === 'active-1')!
    expect(active.stateSummary?.status).toBe('active')
    expect(active.stateSummary?.roundPhase).toBe('actions')
    const lobby = entries.find((e) => e.game.id === 'lobby-1')!
    expect(lobby.stateSummary).toBeNull()
    const canceled = entries.find((e) => e.game.id === 'canceled-1')!
    expect(canceled.game.status).toBe('canceled')
  })

  it('still honors excludeGameId', async () => {
    seedGame(stack, 'active-1', 'active', new Date(1000).toISOString())
    seedPlayer(stack, 'active-1-seat', 'active-1', USER, 0)
    seedMeta(stack, 'active-1', 'active', new Date(1000).toISOString())

    seedGame(stack, 'active-2', 'active', new Date(2000).toISOString())
    seedPlayer(stack, 'active-2-seat', 'active-2', USER, 0)
    seedMeta(stack, 'active-2', 'active', new Date(2000).toISOString())

    const entries = await listMyGames(USER, 'active-1')
    expect(entries.map((e) => e.game.id)).toEqual(['active-2'])
  })

  it('only carries the trimmed player columns the listing views render', async () => {
    seedGame(stack, 'active-1', 'active', new Date(1000).toISOString())
    seedPlayer(stack, 'active-1-seat', 'active-1', USER, 0)
    seedMeta(stack, 'active-1', 'active', new Date(1000).toISOString())

    const entries = await listMyGames(USER)
    expect(Object.keys(entries[0]!.players[0]!).sort()).toEqual(['display_name', 'game_id', 'id', 'seat_index', 'user_id'].sort())
  })
})
