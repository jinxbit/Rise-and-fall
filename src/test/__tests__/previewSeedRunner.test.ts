// @vitest-environment node
//
// Runs the preview seeder (../previewSeed/seedFinishedGame.ts) against the
// in-process stack instead of a real project, for the same reason
// ./productionSmokeRunner.test.ts does the equivalent for the smoke runner:
// the seeder is aimed at a live pre-production project, where a mistake in it
// costs a broken or half-played room that nobody tears down — by design, since
// not tearing down is the entire point.
//
// The two properties worth pinning here are exactly the two that differ from
// a smoke run, because they are the ones a future edit could quietly undo:
// the room is public, and a successful seed leaves everything in place.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProductionGameFixtures } from '../fixtures/productionGames/loadFixtures.ts'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'
import { seedFinishedGame } from '../previewSeed/seedFinishedGame.ts'

const fixtures = await loadProductionGameFixtures()
const enforced = fixtures.filter((fixture) => fixture.game.settings.ruleEnforcementEnabled)

describe('preview seed runner', () => {
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

  it('leaves a finished, public game behind', async () => {
    const fixture = enforced[0]
    const seeded = await seedFinishedGame(config(), fixture)

    expect(seeded.roomCode).toMatch(/^S[A-Z0-9]{6}$/)
    expect(seeded.version).toBeGreaterThan(0)
    expect(Object.values(seeded.finalScores).some((score) => score > 0)).toBe(true)

    // Still there — the whole point. A teardown creeping back in would make
    // this seeder useless while every other assertion still passed.
    const service = { role: 'service_role' as const, userId: null }
    const [game] = stack.db.select(service, 'games', (row) => row.id === seeded.gameId)
    expect(game, 'the seeded room was deleted').toBeDefined()
    expect(game.visibility, 'a private room cannot be found on the Public Rooms screen').toBe('public')
    expect(String(game.name)).toContain('[seed]')
    expect(game.play_mode, 'anything but live can fire a turn notification').toBe('live')

    // The accounts that played it must outlive the run: players.user_id
    // references auth.users with no cascade, so deleting them would strand
    // the room this test just proved is still there.
    const players = stack.db.select(service, 'players', (row) => row.game_id === seeded.gameId)
    expect(players.length).toBe(fixture.finalState.players.length)

    // And the game it left is finished, not abandoned mid-replay — read as a
    // seated player, the way the app would.
    const state = await stack.readGameState(String(players[0].user_id), seeded.gameId)
    expect(state?.state.status).toBe('completed')
  }, 180_000)
})
