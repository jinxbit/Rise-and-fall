-- Rise & Fall — initial schema
--
-- Run this in the Supabase SQL editor (or via `supabase db push` if you set
-- up the CLI). Sets up the three core tables: games (lobby/session
-- metadata), players (one row per seated player, tied to their Discord
-- identity via auth.users), and game_state (single JSON source of truth per
-- game, written only by validated rules-engine output).

-- ---------------------------------------------------------------------------
-- games
-- ---------------------------------------------------------------------------
create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  play_mode text not null check (play_mode in ('live', 'async', 'hotseat')),
  status text not null default 'lobby' check (status in ('lobby', 'active', 'completed')),
  min_players int not null default 2,
  max_players int not null default 4,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.games is 'One row per game/lobby. room_code is the short code players use to join.';

-- ---------------------------------------------------------------------------
-- players
-- ---------------------------------------------------------------------------
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references auth.users (id),
  display_name text not null,
  avatar_url text,
  seat_index int not null,
  color text not null,
  is_active boolean not null default true,
  joined_at timestamptz not null default now(),
  unique (game_id, seat_index),
  unique (game_id, user_id)
);

comment on table public.players is 'One row per seated player. Identity comes from Discord OAuth via auth.users, shared across live/async/hotseat modes.';

-- ---------------------------------------------------------------------------
-- game_state
-- ---------------------------------------------------------------------------
create table if not exists public.game_state (
  game_id uuid primary key references public.games (id) on delete cascade,
  state jsonb not null,
  turn int not null default 0,
  active_player_id uuid references public.players (id),
  -- Incremented on every write; use as an optimistic-concurrency check
  -- (read version, write with `where version = <expected>`) to avoid two
  -- clients clobbering each other's action in live mode.
  version int not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.game_state is 'Single source of truth for a game''s full GameState JSON. Written only after the rules engine validates an action.';

-- ---------------------------------------------------------------------------
-- updated_at bookkeeping
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists games_set_updated_at on public.games;
create trigger games_set_updated_at
  before update on public.games
  for each row execute function public.set_updated_at();

drop trigger if exists game_state_set_updated_at on public.game_state;
create trigger game_state_set_updated_at
  before update on public.game_state
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.games enable row level security;
alter table public.players enable row level security;
alter table public.game_state enable row level security;

-- Any signed-in player can look up a game by room code to join it.
create policy "games are readable by any signed-in user"
  on public.games for select
  to authenticated
  using (true);

create policy "signed-in users can create a game"
  on public.games for insert
  to authenticated
  with check (created_by = auth.uid());

-- Only seated players can update game metadata (e.g. status transitions).
create policy "seated players can update their game"
  on public.games for update
  to authenticated
  using (
    exists (
      select 1 from public.players
      where players.game_id = games.id
        and players.user_id = auth.uid()
    )
  );

-- Player rows are visible to anyone signed in (needed to show the lobby
-- roster before you've joined) but only self-editable.
create policy "players are readable by any signed-in user"
  on public.players for select
  to authenticated
  using (true);

create policy "users can seat themselves"
  on public.players for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "users can update their own player row"
  on public.players for update
  to authenticated
  using (user_id = auth.uid());

-- game_state is only visible/writable to seated players of that game.
create policy "seated players can read game state"
  on public.game_state for select
  to authenticated
  using (
    exists (
      select 1 from public.players
      where players.game_id = game_state.game_id
        and players.user_id = auth.uid()
    )
  );

create policy "seated players can insert game state"
  on public.game_state for insert
  to authenticated
  with check (
    exists (
      select 1 from public.players
      where players.game_id = game_state.game_id
        and players.user_id = auth.uid()
    )
  );

create policy "seated players can update game state"
  on public.game_state for update
  to authenticated
  using (
    exists (
      select 1 from public.players
      where players.game_id = game_state.game_id
        and players.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Realtime (guarded so re-running this migration doesn't error on
-- "relation is already member of publication")
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_state'
  ) then
    alter publication supabase_realtime add table public.game_state;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players'
  ) then
    alter publication supabase_realtime add table public.players;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games'
  ) then
    alter publication supabase_realtime add table public.games;
  end if;
end $$;
