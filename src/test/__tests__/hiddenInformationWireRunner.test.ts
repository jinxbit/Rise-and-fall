// @vitest-environment node
//
// Runs the hidden-information wire check (../productionSmoke/
// hiddenInformationWire.ts, HIDDEN_INFORMATION_PLAN.md §8 phase 9) against
// the in-process stack instead of a real project — same reasoning as
// productionSmokeRunner.test.ts: a mistake in the check's own provisioning
// or assertions is better caught here, on every PR, than at 3am against
// Preview.
//
// Realtime is left off (`includeRealtime: false`): the in-process stack
// (../supabaseStack/) patches only `fetch`, not WebSocket, so there is no
// double for a Realtime subscription to connect to here. That half only
// ever runs against a live project — see
// ../productionSmoke/hiddenInformationWire.smoke.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'
import { checkHiddenInformationWire } from '../productionSmoke/hiddenInformationWire.ts'

describe('hidden-information wire check runner', () => {
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

  it.each(['selectCards', 'decline'] as const)('proves no secret crosses the wire during a %s phase, and that it is revealed once resolved', async (phase) => {
    const report = await checkHiddenInformationWire(config(), phase, { includeRealtime: false })
    expect(report.phase).toBe(phase)
    expect(report.gameId).toBeTruthy()
    expect(report.realtimeChecked).toBe(false)
  }, 60_000)

  it('leaves nothing behind', async () => {
    await checkHiddenInformationWire(config(), 'selectCards', { includeRealtime: false })
    expect(stack.db.table('games')).toEqual([])
    expect(stack.db.table('players')).toEqual([])
    expect(stack.db.table('game_state')).toEqual([])
    expect(stack.db.table('game_state_meta')).toEqual([])
  }, 60_000)
})
