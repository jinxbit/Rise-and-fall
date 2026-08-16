-- Adds a "map pool": DB-backed saved maps players build in Map Builder
-- mode (src/pages/MapBuilderPage.tsx) and save for reuse, categorized by
-- the player count they were built for (issue #23). See
-- src/lib/mapPoolApi.ts for reads/writes and src/lib/gameGenesis.ts /
-- GameSettings.mapPoolBoard for how a saved map is later used to skip the
-- interactive board-setup tile-placement phase — the same mechanism
-- 0002_map_template.sql's static pre-made templates use, just sourced from
-- here instead of content/mapTemplates.json.

create table if not exists public.map_pool (
  id uuid primary key default gen_random_uuid(),
  player_count int not null check (player_count between 2 and 8),
  board jsonb not null,
  -- Canonical signature of `board`'s tiles (canonicalizeBoard in
  -- src/engine/board.ts) — saving the same terrain layout twice for the
  -- same player count collides on this and is rejected by the unique
  -- constraint below, per issue #23's "the same map should not be allowed
  -- to be saved more than once".
  board_key text not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (player_count, board_key)
);

comment on table public.map_pool is 'Player-saved maps (src/pages/MapBuilderPage.tsx), categorized by player count, for "random saved map" at game creation instead of interactive board setup.';

alter table public.map_pool enable row level security;

-- Any signed-in user can browse the pool (needed both to pick a random map
-- at game creation and to show how many maps already exist for a given
-- player count).
create policy "map pool is readable by any signed-in user"
  on public.map_pool for select
  to authenticated
  using (true);

create policy "signed-in users can save a map to the pool"
  on public.map_pool for insert
  to authenticated
  with check (created_by = auth.uid());
