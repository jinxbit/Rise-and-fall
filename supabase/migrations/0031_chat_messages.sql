-- Chat, phase 1 (issue #563): the data layer + kill switch for
-- CHAT_PLAN.md §3-§5 and §11.1. No UI reads or writes any of this yet
-- (phases 2/3, issues to follow) — this migration only has to be safe to
-- have landed early.
--
-- Two tables:
--   - public.app_config: a one-row singleton holding chat_enabled, the kill
--     switch (§4).
--   - public.chat_messages: one row per message, site-wide (game_id null) or
--     per-game (game_id set) — see §3 for why one table serves both.
--
-- Why the kill switch is a DB row and not a `VITE_CHAT_ENABLED` build-time
-- var (the pattern VITE_ALLOW_GUEST_AUTH/VITE_VAPID_PUBLIC_KEY already use):
-- RLS runs inside Postgres and cannot see a Vite/Vercel env var, so a
-- build-time flag could hide the UI but could never stop a modified client
-- from reading or posting chat directly through the REST API — it would only
-- be "a UX guarantee, not a security one" (HIDDEN_INFORMATION_PLAN.md §5.4's
-- phrase for exactly this class of client-side-only gate). A row that
-- `chat_enabled()` reads is visible to RLS, needs no redeploy to flip, and
-- (Preview and production being separate Supabase projects) lets each
-- project's app_config diverge with no extra plumbing. See CHAT_PLAN.md §4.
--
-- Decision, 2026-09-12 (CHAT_PLAN.md §4): chat is enabled in pre-production
-- only, automatically, by a step in deploy-supabase.yml — never in
-- production by any code path. Production is turned on by exactly one
-- hand-run `update public.app_config set chat_enabled = true;` in the
-- Supabase SQL editor. This migration only seeds the row `false`; it does
-- not know which project it's running against.

-- ---------------------------------------------------------------------------
-- app_config: the kill switch
-- ---------------------------------------------------------------------------
create table if not exists public.app_config (
  id boolean primary key default true check (id),
  chat_enabled boolean not null default false
);

comment on table public.app_config is
  'Site-wide config, one row (id is always true — a singleton, not a real key). chat_enabled is the chat kill switch (CHAT_PLAN.md §4): no insert/update/delete policy exists, so nothing in the app can flip it — only a hand-run SQL statement, or (pre-production only) the deploy-supabase.yml step that sets it automatically. Defaults false, which is what keeps a fresh or reset project chat-off until something explicitly turns it on.';

insert into public.app_config (id, chat_enabled)
values (true, false)
on conflict (id) do nothing;

-- `security definer` so a policy that calls this (chat_messages' policies,
-- below) doesn't need its own "and exists (select 1 from app_config ...)"
-- clause re-evaluated under the caller's (read-only-anyway) RLS — same shape
-- as this repo's other RLS helper functions.
create or replace function public.chat_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select chat_enabled from public.app_config limit 1
$$;

alter table public.app_config enable row level security;

-- Read-only: any signed-in user can check whether chat is on (the client
-- needs this to decide whether to render either chat surface at all).
-- Deliberately no insert/update/delete policy on this table at all — see the
-- table comment above.
create policy "anyone can read app_config"
  on public.app_config for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------------------------
create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  game_id uuid references public.games (id) on delete cascade,
  sender_id uuid not null references auth.users (id),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

comment on table public.chat_messages is
  'One row per chat message. game_id null = site-wide (HomePage.tsx); set = that game''s chat (GamePage.tsx). Append-only: no updated_at, no soft-delete column yet — moderation gets its own migration later (CHAT_PLAN.md §8). Gated end-to-end by chat_enabled() below, not just hidden in the UI.';

create index if not exists chat_messages_game_id_created_at_idx
  on public.chat_messages (game_id, created_at);

alter table public.chat_messages enable row level security;

-- Site-wide (game_id is null): any signed-in user may read.
create policy "read site-wide chat"
  on public.chat_messages for select
  to authenticated
  using (game_id is null and public.chat_enabled());

-- In-game: the same audience game_state/game_state_meta already grant today
-- (0019_public_game_state_visible.sql) — seated players always, plus any
-- other signed-in visitor for a `visibility = 'public'` room.
create policy "read game chat"
  on public.chat_messages for select
  to authenticated
  using (
    game_id is not null
    and public.chat_enabled()
    and exists (
      select 1 from public.games
      where games.id = chat_messages.game_id
        and (
          games.visibility = 'public'
          or exists (
            select 1 from public.players
            where players.game_id = games.id and players.user_id = auth.uid()
          )
        )
    )
  );

-- Post: site-wide needs only a session; in-game needs a seat. This is
-- CHAT_PLAN.md open question §10.1, resolved: a public room's non-seated
-- visitor can read that game's chat (policy above) but not post to it — the
-- `exists (... from public.players ...)` clause below is what enforces
-- read-only-for-visitors, deliberately, not an oversight.
create policy "post chat"
  on public.chat_messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and public.chat_enabled()
    and (
      game_id is null
      or exists (
        select 1 from public.players
        where players.game_id = chat_messages.game_id and players.user_id = auth.uid()
      )
    )
  );

-- No update/delete policy: chat_messages does not need one until
-- reporting/moderation (CHAT_PLAN.md §8).

-- ---------------------------------------------------------------------------
-- Realtime (guarded so re-running this migration doesn't error on
-- "relation is already member of publication" — same pattern
-- 0001_init_schema.sql and 0025_game_state_meta.sql already use).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;
