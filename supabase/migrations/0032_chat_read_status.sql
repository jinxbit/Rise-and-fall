-- Chat unread indicator (issue #579, CHAT_PLAN.md §11 follow-on — see that
-- file's new §13 for the design this migration implements). Adds one table,
-- `chat_read_status`, tracking how far each signed-in user has read each
-- chat surface (site-wide, `game_id` null; or one game's chat, `game_id`
-- set) — the same site-wide/per-game split `chat_messages` already uses
-- (0031_chat_messages.sql), so a single table and a single client component
-- keep serving both surfaces.
--
-- `last_read_id` is a cursor into `chat_messages.id` (a `generated always as
-- identity` bigint, i.e. strictly increasing and gap-tolerant), not a
-- timestamp — comparing ids sidesteps clock skew entirely and survives a
-- deleted message in the middle of the range without recounting anything.
--
-- One row per (user, channel). `game_id` being nullable for the site-wide
-- channel means a plain `unique (user_id, game_id)` constraint would not do
-- what it looks like it does: Postgres treats two NULLs as distinct for
-- uniqueness purposes, so a plain unique constraint would let a user
-- accumulate multiple site-wide rows instead of updating one. Two partial
-- unique indexes below give each surface its own real uniqueness guarantee.
create table if not exists public.chat_read_status (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id uuid references public.games (id) on delete cascade,
  last_read_id bigint not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.chat_read_status is
  'How far each user has read each chat surface (CHAT_PLAN.md §13). last_read_id is a cursor into chat_messages.id, not a timestamp. One row per (user, channel); see the two partial unique indexes below for why game_id being nullable rules out a plain unique(user_id, game_id) constraint.';

create unique index if not exists chat_read_status_site_wide_uidx
  on public.chat_read_status (user_id)
  where game_id is null;

create unique index if not exists chat_read_status_game_uidx
  on public.chat_read_status (user_id, game_id)
  where game_id is not null;

alter table public.chat_read_status enable row level security;

-- A user may only ever see, create or advance their own read cursor, and
-- only for a channel they could read chat_messages on in the first place
-- (mirrors 0031_chat_messages.sql's "read site-wide chat"/"read game chat"
-- policies) — gated end-to-end by chat_enabled() too, the same "not just
-- hidden in the UI" stance that migration's table comment documents.
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
    and (
      game_id is null
      or exists (
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
