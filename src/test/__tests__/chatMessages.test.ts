// @vitest-environment node
//
// RLS + kill-switch coverage for chat_messages/app_config
// (0031_chat_messages.sql, CHAT_PLAN.md §3-§4, issue #563 phase 1). No
// chatApi.ts or UI exists yet (phases 2/3) — this exercises the data layer
// directly against the production-simulating stack (src/test/supabaseStack/),
// the same style getGameState.test.ts/writePathRedaction.test.ts use for the
// game tables (see supabaseStack.test.ts's own doc comment for what
// "production-simulating" means here).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GameRow, GameSettings, PlayerRow } from '../../lib/dbTypes.ts'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'

const PRIVATE_GAME_ID = '3f1c2d4e-0000-4000-8000-0000000000c1'
const PUBLIC_GAME_ID = '3f1c2d4e-0000-4000-8000-0000000000c2'
const ALICE = 'auth-user-alice' // seated in both games
const BOB = 'auth-user-bob' // seated in the private game only
const CAROL = 'auth-user-carol' // never seated anywhere

function settingsFor(): GameSettings {
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
    gameLength: 3,
  }
}

function gameRow(id: string, roomCode: string, visibility: GameRow['visibility']): GameRow {
  return {
    id,
    room_code: roomCode,
    name: 'chat RLS self-test',
    play_mode: 'live',
    status: 'active',
    min_players: 2,
    max_players: 2,
    created_by: ALICE,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    settings: settingsFor(),
    config_version: 1,
    visibility,
  }
}

function playerRow(id: string, gameId: string, userId: string, seatIndex: number): PlayerRow {
  return { id, game_id: gameId, user_id: userId, display_name: userId, avatar_url: null, seat_index: seatIndex, color: '#e11', is_active: true, joined_at: new Date(0).toISOString() } as PlayerRow
}

describe('chat_messages / app_config RLS + kill switch (issue #563)', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
    stack.addUser(ALICE)
    stack.addUser(BOB)
    stack.addUser(CAROL)
    stack.db.seed('games', gameRow(PRIVATE_GAME_ID, 'CHATP1', 'private') as unknown as Record<string, unknown>)
    stack.db.seed('games', gameRow(PUBLIC_GAME_ID, 'CHATP2', 'public') as unknown as Record<string, unknown>)
    stack.db.seed('players', playerRow('seat-alice-private', PRIVATE_GAME_ID, ALICE, 0) as unknown as Record<string, unknown>)
    stack.db.seed('players', playerRow('seat-bob-private', PRIVATE_GAME_ID, BOB, 1) as unknown as Record<string, unknown>)
    stack.db.seed('players', playerRow('seat-alice-public', PUBLIC_GAME_ID, ALICE, 0) as unknown as Record<string, unknown>)
  })

  afterEach(() => {
    stack.dispose()
  })

  function enableChat(): void {
    stack.db.replaceRow('app_config', { id: true, chat_enabled: true })
  }

  // Fixture rows are seeded directly (RLS-free) with ids well above the
  // auto-increment counter API inserts start from, so a test that both seeds
  // a fixture row and attempts an API insert never collides on `id`.
  let nextFixtureId = 900
  function seedMessage(gameId: string | null, senderId: string, body: string): void {
    stack.db.seed('chat_messages', { id: nextFixtureId++, game_id: gameId, sender_id: senderId, body, created_at: new Date(0).toISOString() })
  }

  describe('kill switch off (the default)', () => {
    it('rejects reading and posting site-wide chat', async () => {
      seedMessage(null, ALICE, 'hi')
      const { data, error: readError } = await stack.clientFor(ALICE).from('chat_messages').select('*').is('game_id', null)
      expect(readError).toBeNull()
      expect(data).toEqual([])

      const { error: insertError } = await stack.clientFor(ALICE).from('chat_messages').insert({ game_id: null, sender_id: ALICE, body: 'hi' })
      expect(insertError?.code).toBe('42501')
    })

    it('rejects reading and posting in-game chat, even for a seated player', async () => {
      seedMessage(PRIVATE_GAME_ID, ALICE, 'hi')
      const { data, error: readError } = await stack.clientFor(ALICE).from('chat_messages').select('*').eq('game_id', PRIVATE_GAME_ID)
      expect(readError).toBeNull()
      expect(data).toEqual([])

      const { error: insertError } = await stack.clientFor(ALICE).from('chat_messages').insert({ game_id: PRIVATE_GAME_ID, sender_id: ALICE, body: 'hi' })
      expect(insertError?.code).toBe('42501')
    })
  })

  describe('kill switch on', () => {
    beforeEach(() => enableChat())

    it('lets any authenticated user read and post site-wide chat', async () => {
      const { error: insertError } = await stack.clientFor(CAROL).from('chat_messages').insert({ game_id: null, sender_id: CAROL, body: 'hello everyone' })
      expect(insertError).toBeNull()

      const { data, error: readError } = await stack.clientFor(BOB).from('chat_messages').select('*').is('game_id', null)
      expect(readError).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].body).toBe('hello everyone')
    })

    it('lets a seated player read and post in-game chat', async () => {
      const { error: insertError } = await stack.clientFor(BOB).from('chat_messages').insert({ game_id: PRIVATE_GAME_ID, sender_id: BOB, body: 'gg' })
      expect(insertError).toBeNull()

      const { data, error: readError } = await stack.clientFor(ALICE).from('chat_messages').select('*').eq('game_id', PRIVATE_GAME_ID)
      expect(readError).toBeNull()
      expect(data).toHaveLength(1)
    })

    it("lets a signed-in non-seated visitor read a public room's chat, but rejects them posting to it (§10.1, resolved)", async () => {
      seedMessage(PUBLIC_GAME_ID, ALICE, 'welcome spectators')

      const { data, error: readError } = await stack.clientFor(CAROL).from('chat_messages').select('*').eq('game_id', PUBLIC_GAME_ID)
      expect(readError).toBeNull()
      expect(data).toHaveLength(1)

      const { error: insertError } = await stack.clientFor(CAROL).from('chat_messages').insert({ game_id: PUBLIC_GAME_ID, sender_id: CAROL, body: 'let me in' })
      expect(insertError?.code).toBe('42501')
    })

    it("rejects a non-seated visitor from reading a private room's chat", async () => {
      seedMessage(PRIVATE_GAME_ID, ALICE, 'secret strategy')

      const { data, error: readError } = await stack.clientFor(CAROL).from('chat_messages').select('*').eq('game_id', PRIVATE_GAME_ID)
      expect(readError).toBeNull()
      expect(data).toEqual([])
    })

    it('rejects posting on someone else’s behalf', async () => {
      const { error } = await stack.clientFor(ALICE).from('chat_messages').insert({ game_id: null, sender_id: BOB, body: 'pretending to be bob' })
      expect(error?.code).toBe('42501')
    })

    it('rejects an empty or over-long body', async () => {
      const { error: emptyError } = await stack.clientFor(ALICE).from('chat_messages').insert({ game_id: null, sender_id: ALICE, body: '' })
      expect(emptyError).not.toBeNull()

      const { error: tooLongError } = await stack.clientFor(ALICE).from('chat_messages').insert({ game_id: null, sender_id: ALICE, body: 'x'.repeat(2001) })
      expect(tooLongError).not.toBeNull()
    })
  })

  it('no client can update or delete app_config, even a matching row (its flag is not flippable through the API)', async () => {
    const { error: updateError, data: updateData } = await stack.clientFor(ALICE).from('app_config').update({ chat_enabled: true }).eq('id', true).select()
    expect(updateError).toBeNull()
    expect(updateData).toEqual([])
    expect(stack.db.table('app_config')[0]).toMatchObject({ chat_enabled: false })

    const { error: deleteError, data: deleteData } = await stack.clientFor(ALICE).from('app_config').delete().eq('id', true).select()
    expect(deleteError).toBeNull()
    expect(deleteData).toEqual([])
  })
})
