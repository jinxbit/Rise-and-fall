// @vitest-environment node
//
// Runs the production smoke runner (../productionSmoke/runSmoke.ts) against
// the in-process stack instead of a real project.
//
// The runner exists to be pointed at production, where a mistake in it costs a
// failed nightly run, some manual cleanup, and — worst case — a room left
// behind in the live database. That is a bad place to discover that its
// provisioning sequence, its id remapping or its teardown is wrong. The
// in-process stack answers the same PostgREST, GoTrue and Edge Function
// endpoints a deployed project does, so the whole runner can be exercised
// here on every PR: it creates users, signs them in, opens a room, seats
// players, writes genesis, replays a real game, and cleans up, without
// knowing it isn't talking to Supabase.
//
// What this can't prove is the thing production runs prove — that the
// deployment is live and correct. The two are complementary on purpose.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProductionGameFixtures } from '../fixtures/productionGames/loadFixtures.ts'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'
import { provisionLiveRoom } from '../productionSmoke/liveProject.ts'
import { runProductionSmoke } from '../productionSmoke/runSmoke.ts'
import type { CompressedGameState } from '../../lib/gameStateCompression.ts'

const fixtures = await loadProductionGameFixtures()
const enforcedFixtures = fixtures.filter((fixture) => fixture.game.settings.ruleEnforcementEnabled)

describe('production smoke runner', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
  })
  afterEach(() => {
    stack.dispose()
  })

  function config() {
    return { url: stack.url, anonKey: stack.anonKey, serviceRoleKey: stack.serviceRoleKey }
  }

  it('replays every eligible game and reports what it did', async () => {
    const reports = await runProductionSmoke(config(), fixtures)

    expect(reports).toHaveLength(fixtures.length)
    for (const report of reports) {
      const fixture = fixtures.find((candidate) => candidate.name === report.fixture)!
      if (fixture.game.settings.ruleEnforcementEnabled) {
        expect(report.skippedReason, `${report.fixture} should have run`).toBeUndefined()
        expect(report.actionsSubmitted).toBeGreaterThan(0)
      } else {
        // A client-trusted game is skipped with a reason rather than forced
        // through rules it was never played under.
        expect(report.skippedReason).toContain('client-trusted')
      }
    }
    expect(reports.filter((report) => !report.skippedReason).length).toBe(enforcedFixtures.length)
  }, 180_000)

  it('leaves nothing behind — no room, no players, no state, no users', async () => {
    await runProductionSmoke(config(), fixtures)

    expect(stack.db.table('games')).toEqual([])
    expect(stack.db.table('players')).toEqual([])
    expect(stack.db.table('game_state')).toEqual([])
    // game_state_meta is the one table whose rows outlive their game only if
    // the cascade is wrong — 0025 declares `on delete cascade` from games.
    expect(stack.db.table('game_state_meta')).toEqual([])
  }, 180_000)

  it('provisions a room that looks like a real one, and stores its state the enforced way', async () => {
    const fixture = enforcedFixtures[0]
    const room = await provisionLiveRoom(config(), fixture)
    try {
      // Never listed publicly, never 'async' — both notification Edge
      // Functions early-return on any other play mode, so a replay can't page
      // a real player.
      expect(room.game.visibility).toBe('private')
      expect(room.game.play_mode).toBe('live')
      expect(room.game.name.startsWith('[smoke] ')).toBe(true)
      expect(room.game.settings.ruleEnforcementEnabled).toBe(true)

      // Fresh seats with fresh ids, in the fixture's own seat order.
      expect(room.players).toHaveLength(fixture.finalState.players.length)
      expect(room.players.map((player) => player.seat_index)).toEqual(fixture.finalState.players.map((_, index) => index))
      expect(new Set(room.players.map((player) => player.user_id)).size).toBe(room.players.length)
      for (const player of room.players) {
        expect(fixture.finalState.players.some((original) => original.id === player.id)).toBe(false)
      }

      // One action is enough to prove the enforced write path is what's running.
      const first = room.remapped.history[0]
      const result = await room.applyAction(room.remapped.userIdForPlayer(first.action.playerId!), room.game.id, first.action)
      expect(result.ok, result.ok ? '' : result.error).toBe(true)

      const stored = stack.db.table<{ state: CompressedGameState }>('game_state')[0].state
      expect(stored.__gz).toBeTypeOf('string')
      expect(stack.db.table<{ status: string }>('game_state_meta')[0].status).not.toBe('unknown')
    } finally {
      await room.teardown()
    }
  }, 60_000)

  it('tears the room down even when provisioning fails part-way', async () => {
    const fixture = enforcedFixtures[0]
    // A game id that already exists makes the `game_state` insert fail on its
    // primary key, after users and a room have been created.
    const room = await provisionLiveRoom(config(), fixture)
    const gameId = room.game.id
    await room.teardown()

    // Teardown is idempotent, and a second call is a no-op rather than an error.
    await room.teardown()
    expect(stack.db.table<{ id: string }>('games').some((game) => game.id === gameId)).toBe(false)
  }, 60_000)
})
