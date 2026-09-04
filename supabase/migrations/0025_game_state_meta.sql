-- BACKEND_ENFORCEMENT_SPEC.md phase 4 (issue #37 / #418): the slim public
-- projection of game_state, §5.2/§6. Once redaction (§5) ships, the
-- authoritative game_state row will stop being safe to broadcast over
-- Realtime as-is (row-granularity broadcast can't redact a still-secret
-- selectCards/decline pick out of the payload) — game_state_meta is the
-- replacement "something changed, refetch your redacted view" signal:
-- phase/status/turn/version only, nothing a phase's in-progress
-- CHOOSE_CARD/MOVE_TO_DECLINE entries ever touch.
--
-- Landed ahead of the RLS lockdown/get_game_state RPC/apply-action Edge
-- Functions that will actually consume it (same "safe to land early"
-- reasoning §7's deploy workflow used) — clients still read/write
-- game_state directly today (gameApi.ts), so this table is inert until
-- phase 8 rewires them. It's purely additive: no existing behavior
-- changes.
create table if not exists public.game_state_meta (
  game_id uuid primary key references public.games (id) on delete cascade,
  status text not null,
  round_phase text,
  turn int not null default 0,
  version int not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.game_state_meta is 'Slim public projection of game_state (status/roundPhase/turn/version only) — see BACKEND_ENFORCEMENT_SPEC.md §5.2/§6. Kept in sync by game_state_sync_meta trigger; never written directly.';

-- ---------------------------------------------------------------------------
-- Kept in sync with game_state on every write. security definer because the
-- writing client's role (`authenticated`, via game_state's own RLS) has no
-- direct insert/update grant on game_state_meta — only this trigger does.
-- ---------------------------------------------------------------------------
create or replace function public.game_state_sync_meta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.game_state_meta (game_id, status, round_phase, turn, version, updated_at)
  values (
    new.game_id,
    new.state ->> 'status',
    new.state ->> 'roundPhase',
    coalesce((new.state ->> 'turn')::int, 0),
    new.version,
    now()
  )
  on conflict (game_id) do update set
    status = excluded.status,
    round_phase = excluded.round_phase,
    turn = excluded.turn,
    version = excluded.version,
    updated_at = excluded.updated_at;
  return new;
end;
$$;

drop trigger if exists game_state_sync_meta on public.game_state;
create trigger game_state_sync_meta
  after insert or update on public.game_state
  for each row execute function public.game_state_sync_meta();

-- Backfill existing rows so games created before this migration get a
-- game_state_meta row too, without waiting on their next write.
insert into public.game_state_meta (game_id, status, round_phase, turn, version, updated_at)
select game_id, state ->> 'status', state ->> 'roundPhase', coalesce((state ->> 'turn')::int, 0), version, now()
from public.game_state
on conflict (game_id) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security — same audience as game_state's current read policies
-- (0021_remove_observers.sql, 0024_admin_read_all_game_state.sql): seated
-- players, any signed-in user for a non-lobby game, or an admin. No
-- insert/update/delete policy for `authenticated` — only the security
-- definer trigger above writes this table.
-- ---------------------------------------------------------------------------
alter table public.game_state_meta enable row level security;

create policy "seated players and any signed-in user can read non-lobby game state meta"
  on public.game_state_meta for select
  to authenticated
  using (
    exists (
      select 1 from public.players
      where players.game_id = game_state_meta.game_id
        and players.user_id = auth.uid()
    )
    or exists (
      select 1 from public.games
      where games.id = game_state_meta.game_id
        and games.status <> 'lobby'
    )
  );

create policy "admins can read any game state meta"
  on public.game_state_meta for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.is_admin
    )
  );

-- ---------------------------------------------------------------------------
-- Realtime (guarded so re-running this migration doesn't error on
-- "relation is already member of publication" — same pattern as
-- 0001_init_schema.sql)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_state_meta'
  ) then
    alter publication supabase_realtime add table public.game_state_meta;
  end if;
end $$;
