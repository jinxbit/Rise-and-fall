-- Chat unread indicator (issue #579, CHAT_PLAN.md §11 follow-on — see that
-- file's new §13 for the design this migration implements). Adds one table,
-- `chat_read_status`, tracking how far each signed-in user has read one
-- game's chat. Unread tracking is scoped to in-game chat only — the
-- site-wide chat on HomePage.tsx has no read cursor and never will (see
-- CHAT_PLAN.md §13's note on why), so unlike `chat_messages`
-- (0031_chat_messages.sql), `game_id` here is never null.
--
-- `last_read_id` is a cursor into `chat_messages.id` (a `generated always as
-- identity` bigint, i.e. strictly increasing and gap-tolerant), not a
-- timestamp — comparing ids sidesteps clock skew entirely and survives a
-- deleted message in the middle of the range without recounting anything.
--
-- One row per (user, game), enforced by the plain unique index below.
create table if not exists public.chat_read_status (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  last_read_id bigint not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.chat_read_status is
  'How far each user has read one game''s chat (CHAT_PLAN.md §13) — in-game chat only, never the site-wide channel. last_read_id is a cursor into chat_messages.id, not a timestamp. One row per (user, game).';

create unique index if not exists chat_read_status_game_uidx
  on public.chat_read_status (user_id, game_id);

alter table public.chat_read_status enable row level security;

-- A user may only ever see, create or advance their own read cursor, and
-- only for a game they could read that game's chat on in the first place
-- (mirrors 0031_chat_messages.sql's "read game chat" policy) — gated
-- end-to-end by chat_enabled() too, the same "not just hidden in the UI"
-- stance that migration's table comment documents.
create policy "read own chat read status"
  on public.chat_read_status for select
  to authenticated
  using (user_id = auth.uid());

create policy "insert own chat read status"
  on public.chat_read_status for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.chat_enabled()
    and exists (
      select 1 from public.games
      where games.id = chat_read_status.game_id
        and (
          games.visibility = 'public'
          or exists (
            select 1 from public.players
            where players.game_id = games.id and players.user_id = auth.uid()
          )
        )
    )
  );

create policy "update own chat read status"
  on public.chat_read_status for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No delete policy: a stale read-status row for a deleted game is cleaned up
-- by the `on delete cascade` above, and there is otherwise no reason to
-- remove one — same append-mostly posture as chat_messages itself.
