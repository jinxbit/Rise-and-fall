// Chat, phase 2 (issue #564): the typed data layer for CHAT_PLAN.md §6,
// mirroring gameApi.ts's shape. Parameterized by `gameId: string | null`
// throughout (null = site-wide) so phase 3 (#565, in-game chat) reuses this
// file unchanged with a real game id — nothing here is HomePage-specific.
// Never touches src/engine/: chat is not a game rule (CHAT_PLAN.md §1).

import { supabase } from './supabase'
import type { ChatMessageRow } from './dbTypes'

/** No older-history paging yet — CHAT_PLAN.md doesn't ask for it. This is "enough to see the recent conversation on load." */
const CHAT_PAGE_SIZE = 50

let chatEnabledCache: Promise<boolean> | null = null

/**
 * The chat kill switch (0031_chat_messages.sql, CHAT_PLAN.md §4). Reads
 * `app_config.chat_enabled` directly rather than through a `chat_enabled()`
 * RPC call — CHAT_PLAN.md §4 explicitly allows either ("a cheap RPC call, or
 * folded into whatever the client already fetches on load"), and a plain
 * table read matches every other query in this file/gameApi.ts (no
 * `supabase.rpc()` call exists anywhere else in the client) and is directly
 * exercisable by the RLS coverage `src/test/__tests__/chatMessages.test.ts`
 * already added in phase 1. `app_config`'s own "anyone can read" policy is
 * what makes this safe to call before checking session. Cached for the page
 * load's lifetime since both chat surfaces need it and it only changes when
 * jinxbit hand-flips it in the Supabase SQL editor.
 */
async function fetchChatEnabled(): Promise<boolean> {
  const { data, error } = await supabase.from('app_config').select('chat_enabled').maybeSingle()
  if (error) throw error
  return data?.chat_enabled ?? false
}

export function isChatEnabled(): Promise<boolean> {
  if (!chatEnabledCache) {
    chatEnabledCache = fetchChatEnabled().catch((err: unknown) => {
      chatEnabledCache = null
      throw err
    })
  }
  return chatEnabledCache
}

/**
 * Most recent messages for one surface — site-wide (`gameId: null`) or one
 * game's chat — oldest first, capped to CHAT_PAGE_SIZE. RLS
 * (0031_chat_messages.sql) already scopes the result to what this caller may
 * see; a signed-out caller or a disabled kill switch just gets `[]`.
 */
export async function listChatMessages(gameId: string | null): Promise<ChatMessageRow[]> {
  let query = supabase.from('chat_messages').select('*').order('created_at', { ascending: false }).limit(CHAT_PAGE_SIZE)
  query = gameId === null ? query.is('game_id', null) : query.eq('game_id', gameId)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []).slice().reverse()
}

/** Posts one message. RLS enforces `sender_id = auth.uid()` and (for a game's chat) that the sender is seated — see the "post chat" policy. */
export async function postChatMessage(gameId: string | null, senderId: string, body: string): Promise<void> {
  const { error } = await supabase.from('chat_messages').insert({ game_id: gameId, sender_id: senderId, body })
  if (error) throw error
}

/**
 * Appends new rows straight from the Realtime payload (CHAT_PLAN.md §5) — a
 * chat row is a few hundred bytes, so unlike game_state_meta's slim-
 * broadcast-then-fetch shape (subscribeToGameState, gameApi.ts) there is no
 * bandwidth reason to split "something changed" from "go fetch it."
 */
export function subscribeToChatMessages(gameId: string | null, onInsert: (message: ChatMessageRow) => void): () => void {
  const filter = gameId === null ? 'game_id=is.null' : `game_id=eq.${gameId}`
  const channel = supabase
    .channel(`chat_messages:${gameId ?? 'site-wide'}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter }, (payload) => {
      onInsert(payload.new as ChatMessageRow)
    })
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}

/**
 * Best-effort display names for a batch of sender ids, keyed by `user_id`.
 * Backed by `profiles.display_name` (0015_profile_display_name.sql) — the
 * "existing profiles/useDisplayName path" CHAT_PLAN.md §3 calls for. That
 * table's RLS (0013_discord_notify_backend.sql) only exposes a row to its
 * own owner or a co-player sharing a game, so a site-wide message from
 * someone the caller has never shared a game with resolves to no entry here
 * at all — there is no server-side way to read a stranger's Discord-derived
 * fallback name (`user_metadata` lives in `auth.users`, never exposed to
 * other clients) without a new RLS-relaxing migration or RPC, which is out
 * of this issue's scope. Callers fall back to a generic label for any id
 * missing from the result, the same way resolveDisplayName falls back to
 * `'Player'`. Widening this is a follow-up decision, not guessed at here.
 */
export async function getChatDisplayNames(userIds: string[]): Promise<Record<string, string>> {
  const distinctIds = [...new Set(userIds)]
  if (distinctIds.length === 0) return {}
  const { data, error } = await supabase.from('profiles').select('user_id, display_name').in('user_id', distinctIds)
  if (error) throw error
  const names: Record<string, string> = {}
  for (const row of (data ?? []) as { user_id: string; display_name: string | null }[]) {
    if (row.display_name) names[row.user_id] = row.display_name
  }
  return names
}
