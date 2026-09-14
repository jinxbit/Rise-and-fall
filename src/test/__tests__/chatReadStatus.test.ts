// @vitest-environment node
//
// RLS coverage for chat_read_status (0032_chat_read_status.sql,
// CHAT_PLAN.md §13, issue #579) against the production-simulating stack
// (src/test/supabaseStack/) — same style chatMessages.test.ts already uses
// for chat_messages/app_config's RLS. chatApi.ts's own update-then-insert
// logic (markChatRead) is covered at the component level in
// ChatPanel.test.tsx instead, since it's ordinary client-side query
// building rather than a server-side rule.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GameRow, GameSettings, PlayerRow } from '../../lib/dbTypes.ts'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'

const PRIVATE_GAME_ID = '3f1c2d4e-0000-4000-8000-0000000000d1'
const PUBLIC_GAME_ID = '3f1c2d4e-0000-4000-8000-0000000000d2'
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
    name: 'chat read status RLS self-test',
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

describe('chat_read_status RLS (issue #579)', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
    stack.addUser(ALICE)
    stack.addUser(BOB)
    stack.addUser(CAROL)
    stack.db.seed('games', gameRow(PRIVATE_GAME_ID, 'READP1', 'private') as unknown as Record<string, unknown>)
    stack.db.seed('games', gameRow(PUBLIC_GAME_ID, 'READP2', 'public') as unknown as Record<string, unknown>)
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

  describe('kill switch off (the default)', () => {
    it('rejects creating a read cursor even for a channel the user could otherwise read', async () => {
      const { error } = await stack.clientFor(ALICE).from('chat_read_status').insert({ user_id: ALICE, game_id: null, last_read_id: 0 })
      expect(error?.code).toBe('42501')
    })
  })

  describe('kill switch on', () => {
    beforeEach(() => enableChat())

    it('lets a user create and read their own site-wide cursor', async () => {
      const { error: insertError } = await stack.clientFor(ALICE).from('chat_read_status').insert({ user_id: ALICE, game_id: null, last_read_id: 5 })
      expect(insertError).toBeNull()

      const { data, error: readError } = await stack.clientFor(ALICE).from('chat_read_status').select('*').eq('user_id', ALICE).is('game_id', null)
      expect(readError).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0].last_read_id).toBe(5)
    })

    it('lets a seated player create a cursor for that game, but rejects a non-seated visitor to a private game', async () => {
      const { error: aliceError } = await stack.clientFor(ALICE).from('chat_read_status').insert({ user_id: ALICE, game_id: PRIVATE_GAME_ID, last_read_id: 0 })
      expect(aliceError).toBeNull()

      const { error: carolError } = await stack.clientFor(CAROL).from('chat_read_status').insert({ user_id: CAROL, game_id: PRIVATE_GAME_ID, last_read_id: 0 })
      expect(carolError?.code).toBe('42501')
    })

    it("lets a signed-in non-seated visitor to a public game create a cursor for it", async () => {
      const { error } = await stack.clientFor(CAROL).from('chat_read_status').insert({ user_id: CAROL, game_id: PUBLIC_GAME_ID, last_read_id: 0 })
      expect(error).toBeNull()
    })

    it('rejects creating a cursor on someone else’s behalf', async () => {
      const { error } = await stack.clientFor(ALICE).from('chat_read_status').insert({ user_id: BOB, game_id: null, last_read_id: 0 })
      expect(error?.code).toBe('42501')
    })

    it('lets a user update their own cursor, and hides it from another user entirely', async () => {
      stack.db.seed('chat_read_status', { id: 'cursor-alice-site', user_id: ALICE, game_id: null, last_read_id: 1, updated_at: new Date(0).toISOString() })

      const { error: updateError } = await stack.clientFor(ALICE).from('chat_read_status').update({ last_read_id: 9 }).eq('user_id', ALICE).is('game_id', null)
      expect(updateError).toBeNull()
      expect(stack.db.table('chat_read_status')[0]).toMatchObject({ last_read_id: 9 })

      const { data: bobRead, error: bobReadError } = await stack.clientFor(BOB).from('chat_read_status').select('*').eq('user_id', ALICE)
      expect(bobReadError).toBeNull()
      expect(bobRead).toEqual([])

      const { data: bobUpdate, error: bobUpdateError } = await stack.clientFor(BOB).from('chat_read_status').update({ last_read_id: 0 }).eq('user_id', ALICE).select()
      expect(bobUpdateError).toBeNull()
      expect(bobUpdate).toEqual([])
      expect(stack.db.table('chat_read_status')[0]).toMatchObject({ last_read_id: 9 })
    })

    it('rejects a second row for the same (user, site-wide channel) pair', async () => {
      const { error: firstError } = await stack.clientFor(ALICE).from('chat_read_status').insert({ user_id: ALICE, game_id: null, last_read_id: 0 })
      expect(firstError).toBeNull()

      const { error: secondError } = await stack.clientFor(ALICE).from('chat_read_status').insert({ user_id: ALICE, game_id: null, last_read_id: 3 })
      expect(secondError?.code).toBe('23505')
    })
  })

  it('a deleted game cascades its players’ read cursors for it', async () => {
    enableChat()
    stack.db.seed('chat_read_status', { id: 'cursor-alice-private', user_id: ALICE, game_id: PRIVATE_GAME_ID, last_read_id: 2, updated_at: new Date(0).toISOString() })
    stack.db.seed('chat_read_status', { id: 'cursor-alice-site', user_id: ALICE, game_id: null, last_read_id: 2, updated_at: new Date(0).toISOString() })

    const { error } = await stack.clientFor(ALICE).from('games').delete().eq('id', PRIVATE_GAME_ID)
    expect(error).toBeNull()

    const remaining = stack.db.table('chat_read_status')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ game_id: null })
  })
})
