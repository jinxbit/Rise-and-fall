-- Discord webhook notifications — each player supplies their own webhook
-- URL (no bot install, no central Discord app needed beyond the OAuth one
-- already used for sign-in). Stored per-account (not per-game) since it's
-- a personal notification preference that should carry across every game
-- someone plays.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  discord_webhook_url text,
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Per-account settings not tied to any one game. Currently just a player''s own Discord webhook URL for async "your turn" notifications.';

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

-- Everyone can read and manage their own row.
create policy "users can read their own profile"
  on public.profiles for select
  to authenticated
  using (user_id = auth.uid());

create policy "users can insert their own profile"
  on public.profiles for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "users can update their own profile"
  on public.profiles for update
  to authenticated
  using (user_id = auth.uid());

-- This app has no backend beyond Supabase (see README) — there's no server
-- to fan out "it's your turn" pings, so whichever player's browser just
-- ended their turn is the one that posts to the *next* player's webhook
-- directly. That client needs to read the next player's webhook URL, so
-- co-players (anyone seated in a game with you) can read your row too —
-- scoped to co-players only, not every signed-in user, since a webhook URL
-- lets whoever holds it post messages into that player's Discord channel.
create policy "co-players can read each other's webhook url"
  on public.profiles for select
  to authenticated
  using (
    exists (
      select 1
      from public.players mine
      join public.players theirs on theirs.game_id = mine.game_id
      where mine.user_id = auth.uid()
        and theirs.user_id = profiles.user_id
    )
  );
