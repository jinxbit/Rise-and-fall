// @vitest-environment node
//
// Regression coverage for issue #676: a site admin pastes a game state
// export (GamePage.tsx's "Copy game export", often attached to a bug
// report) and gets a brand-new hot seat room they own, without touching the
// game the export came from. Runs against the production-simulating stack
// (src/test/supabaseStack/) so this exercises the real games/players RLS
// policies gameApi.ts's importGameExportAsHotseat relies on, not a
// hand-rolled fixture.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

let currentClient: SupabaseClient
vi.mock('../supabase', () => ({
  get supabase() {
    return currentClient
  },
}))

const { createGame, joinGame, markReady, startGameFromLobby, getGameState, importGameExportAsHotseat } = await import('../gameApi.ts')
const { encodeGameStateExport } = await import('../gameStateExport.ts')
const { createProductionStack } = await import('../../test/supabaseStack/index.ts')
type ProductionStack = Awaited<ReturnType<typeof createProductionStack>>

const ALICE = 'alice-user-id'
const BOB = 'bob-user-id'
const ADMIN = 'admin-user-id'

describe('importGameExportAsHotseat', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
    stack.addUser(ALICE, { displayName: 'Alice' })
    stack.addUser(BOB, { displayName: 'Bob' })
    stack.addUser(ADMIN, { displayName: 'Admin', isAdmin: true })
  })

  afterEach(() => {
    stack.dispose()
  })

  it('creates a new hot seat room from the export, owned entirely by the importing admin', async () => {
    currentClient = stack.clientFor(ALICE)
    const { game: sourceGame } = await createGame({
      name: 'Source room',
      playMode: 'live',
      userId: ALICE,
      displayName: 'Alice',
      avatarUrl: null,
      minPlayers: 2,
      maxPlayers: 2,
    })

    currentClient = stack.clientFor(BOB)
    const bobSeat = await joinGame({ game: sourceGame, userId: BOB, displayName: 'Bob', avatarUrl: null })
    await markReady(bobSeat.id, sourceGame.config_version)

    currentClient = stack.clientFor(ALICE)
    await startGameFromLobby(sourceGame)
    const sourceSnapshot = await getGameState(sourceGame.id)
    if (!sourceSnapshot) throw new Error('expected source game state to exist')

    const exportText = await encodeGameStateExport(sourceSnapshot.state)

    currentClient = stack.clientFor(ADMIN)
    const importedGame = await importGameExportAsHotseat({ exportText, hostUserId: ADMIN })

    expect(importedGame.play_mode).toBe('hotseat')
    expect(importedGame.status).toBe('active')
    expect(importedGame.created_by).toBe(ADMIN)
    expect(importedGame.settings.ruleEnforcementEnabled).toBe(false)
    expect(importedGame.settings.hiddenInformationEnabled).toBe(false)

    const importedPlayers = stack.db
      .table<{ id: string; game_id: string; user_id: string }>('players')
      .filter((row) => row.game_id === importedGame.id)
    expect(importedPlayers).toHaveLength(2)
    expect(importedPlayers.every((p) => p.user_id === ADMIN)).toBe(true)
    // Fresh ids for the new room, not reused from the source game's roster.
    for (const p of importedPlayers) {
      expect(sourceSnapshot.state.players.map((sp) => sp.id)).not.toContain(p.id)
    }

    const importedSnapshot = await getGameState(importedGame.id)
    if (!importedSnapshot) throw new Error('expected imported game state to exist')
    expect(importedSnapshot.state.gameId).toBe(importedGame.id)
    expect(importedSnapshot.state.players).toHaveLength(2)
    expect(importedSnapshot.state.players.every((p) => p.authUserId === ADMIN)).toBe(true)

    // The source game is completely untouched.
    const sourceStillThere = await getGameState(sourceGame.id)
    expect(sourceStillThere?.state.players.map((p) => p.id)).toEqual(sourceSnapshot.state.players.map((p) => p.id))
  })

  it('rejects a file that is not a recognized game state export', async () => {
    currentClient = stack.clientFor(ADMIN)
    await expect(importGameExportAsHotseat({ exportText: '{"not": "an export"}', hostUserId: ADMIN })).rejects.toThrow(
      /Unrecognized game state export schema/,
    )
  })
})
