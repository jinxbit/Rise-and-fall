// @vitest-environment node
//
// RLS coverage for the `chat_sender_display_names` RPC
// (0035_chat_sender_display_names.sql, issue #684, CHAT_PLAN.md §10.5):
// site-wide chat has no seats to fall back to for a sender's display name
// (unlike in-game chat since issue #682), and `profiles` itself has been
// readable only by its own owner since 0013_discord_notify_backend.sql. This
// RPC is the decided fix — any signed-in user may look up another user's
// `display_name` this way, but never their `discord_webhook_url`, which
// stays owner-only. Same style as chatMessages.test.ts: exercised directly
// against the production-simulating stack (src/test/supabaseStack/), no UI.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'

const ALICE = 'auth-user-alice'
const BOB = 'auth-user-bob' // never shares a game with Alice

describe('chat_sender_display_names RPC (issue #684)', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
    stack.addUser(ALICE, { displayName: 'Alice the Bold' })
    stack.addUser(BOB)
    // A row an ordinary select could never touch, seeded RLS-free — proves
    // the RPC's own query is narrower than "select * from profiles", not
    // just that RLS on a client select happens to hide it.
    stack.db.replaceRow('profiles', { user_id: ALICE, display_name: 'Alice the Bold', is_admin: false, discord_webhook_url: 'https://discord.com/api/webhooks/secret' })
  })

  afterEach(() => {
    stack.dispose()
  })

  it("lets a user who has never shared a game with the sender resolve the sender's custom display name", async () => {
    const { data, error } = await stack.clientFor(BOB).rpc('chat_sender_display_names', { sender_ids: [ALICE] })
    expect(error).toBeNull()
    expect(data).toEqual([{ user_id: ALICE, display_name: 'Alice the Bold' }])
  })

  it('never returns discord_webhook_url, no matter what the caller asks for', async () => {
    const { data, error } = await stack.clientFor(BOB).rpc('chat_sender_display_names', { sender_ids: [ALICE] })
    expect(error).toBeNull()
    expect(data![0]).not.toHaveProperty('discord_webhook_url')
    // The direct table read stays exactly as restrictive as before this
    // issue — BOB still cannot read ALICE's profiles row at all.
    const direct = await stack.clientFor(BOB).from('profiles').select('*').eq('user_id', ALICE)
    expect(direct.data).toEqual([])
  })

  it('omits an id with no custom display name set', async () => {
    const { data, error } = await stack.clientFor(BOB).rpc('chat_sender_display_names', { sender_ids: [ALICE, BOB] })
    expect(error).toBeNull()
    expect(data).toEqual([{ user_id: ALICE, display_name: 'Alice the Bold' }])
  })

  it('rejects a signed-out caller', async () => {
    const { error } = await stack.anonClient().rpc('chat_sender_display_names', { sender_ids: [ALICE] })
    expect(error).not.toBeNull()
  })
})
