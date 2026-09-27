// @vitest-environment node
//
// Security regression test for issue #712: `profiles.is_admin` gates
// admin-only reads/deletes (0017_admin_delete_any_game.sql,
// 0024_admin_read_all_game_state.sql), but 0005_discord_webhooks.sql's
// "users can update their own profile" policy never limited which columns
// an authenticated user could change on their own row, so any signed-in
// user could set `is_admin = true` on themselves through the ordinary
// anon-key client. 0036_lock_down_profiles_is_admin.sql adds a trigger to
// close that; this exercises it against the production-simulating stack
// (src/test/supabaseStack/), same style as chatSenderDisplayNames.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createProductionStack, type ProductionStack } from '../supabaseStack/index.ts'

const ALICE = 'auth-user-alice'

describe('profiles.is_admin lockdown (issue #712)', () => {
  let stack: ProductionStack

  beforeEach(async () => {
    stack = await createProductionStack()
    stack.addUser(ALICE)
  })

  afterEach(() => {
    stack.dispose()
  })

  it('rejects an authenticated insert that sets is_admin true on its own row', async () => {
    // addUser() already seeded a profiles row for ALICE; clear it RLS-free
    // (there's no client-reachable delete policy on profiles, same as
    // production — see 0005_discord_webhooks.sql) to exercise the INSERT
    // path rather than UPDATE.
    stack.db.deleteProfileFor(ALICE)

    const { error } = await stack.clientFor(ALICE).from('profiles').insert({ user_id: ALICE, is_admin: true })
    expect(error).not.toBeNull()
    expect(stack.db.table('profiles').find((row) => row.user_id === ALICE)).toBeUndefined()
  })

  it('rejects an authenticated update that changes is_admin on its own row', async () => {
    const { error } = await stack.clientFor(ALICE).from('profiles').update({ is_admin: true }).eq('user_id', ALICE)
    expect(error).not.toBeNull()
    expect(stack.db.table('profiles').find((row) => row.user_id === ALICE)?.is_admin).toBe(false)
  })

  it('still lets an authenticated user update its other profile columns', async () => {
    const { error } = await stack.clientFor(ALICE).from('profiles').update({ display_name: 'Alice the Bold' }).eq('user_id', ALICE)
    expect(error).toBeNull()
    expect(stack.db.table('profiles').find((row) => row.user_id === ALICE)?.display_name).toBe('Alice the Bold')
  })

  it('lets the service role set is_admin', async () => {
    const serviceClient = createClient(stack.url, stack.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { error } = await serviceClient.from('profiles').update({ is_admin: true }).eq('user_id', ALICE)
    expect(error).toBeNull()
    expect(stack.db.table('profiles').find((row) => row.user_id === ALICE)?.is_admin).toBe(true)
  })
})
