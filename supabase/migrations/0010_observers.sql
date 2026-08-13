-- Room lifecycle Phase 3: Observers — see the "Online Game Room
-- Specification" issue (#40), section 6 (Participants > Observer).
--
-- An Observer can view the current game state but cannot perform gameplay
-- actions. Observers are their own table, not a `players` row: they don't
-- occupy a seat, aren't counted toward min/max player limits, and aren't
-- part of readiness (roomReadiness.ts only ever looks at `players`). Per the
-- spec they "may join while the game is Active and In Progress" — this repo
-- can't distinguish In Progress/Finished on `games.status` (both read
-- 'active', see dbTypes.ts's GameRow comment), so this uses the same
-- 'active' gate as everywhere else that quirk already applies. Observing a
-- 'lobby' or 'canceled' room is not allowed (there's nothing to watch yet,
-- or play has stopped).

-- ---------------------------------------------------------------------------
-- 1. Table.
-- ---------------------------------------------------------------------------
create table if not exists public.observers (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references auth.users (id),
  display_name text not null,
  avatar_url text,
  joined_at timestamptz not null default now(),
  unique (game_id, user_id)
);

comment on table public.observers is 'One row per user observing a game — view-only, does not occupy a player seat (see issue #40 section 6).';

-- ---------------------------------------------------------------------------
-- 2. Row Level Security.
-- ---------------------------------------------------------------------------
alter table public.observers enable row level security;

create policy "observers are readable by any signed-in user"
  on public.observers for select
  to authenticated
  using (true);

create policy "users can start observing an active game"
  on public.observers for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.games
      where games.id = observers.game_id
        and games.status = 'active'
    )
  );

create policy "users can stop observing"
  on public.observers for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. Observers can read game_state too, not just seated players (the actual
--    gap this phase fixes — previously a non-seated visitor couldn't load
--    any game state at all, even though RoundView.tsx already renders
--    read-only for a null myPlayerId).
-- ---------------------------------------------------------------------------
drop policy if exists "seated players can read game state" on public.game_state;

create policy "seated players and observers can read game state"
  on public.game_state for select
  to authenticated
  using (
    exists (
      select 1 from public.players
      where players.game_id = game_state.game_id
        and players.user_id = auth.uid()
    )
    or exists (
      select 1 from public.observers
      where observers.game_id = game_state.game_id
        and observers.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Realtime, so the observer list/count updates live (same pattern as
--    0001_init_schema.sql's guarded publication adds).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'observers'
  ) then
    alter publication supabase_realtime add table public.observers;
  end if;
end $$;
