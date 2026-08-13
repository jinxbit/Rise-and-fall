-- Room lifecycle: a Canceled state, plus Owner-gated lifecycle transitions
-- and deletion — see the "Online Game Room Specification" issue (#40),
-- sections 2 (Ownership), 3 (Lifecycle Model) and 12 (Deleting a Room).
--
-- games.status stays the coarse lifecycle column it already was
-- (0001_init_schema.sql/dbTypes.ts's GameRow comment: 'boardSetup' and
-- 'completed' live only in game_state.state.status), now with 'canceled'
-- added. "Finished" isn't a distinct games.status value — a finished game
-- still reads 'active' here, same pre-existing quirk myGamesView.ts already
-- documents — so the delete/cancel rules below are phrased in terms of the
-- states games.status *can* distinguish (lobby/active/canceled).

-- ---------------------------------------------------------------------------
-- 1. Allow the new status value.
-- ---------------------------------------------------------------------------
alter table public.games
  drop constraint if exists games_status_check;

alter table public.games
  add constraint games_status_check check (status in ('lobby', 'active', 'completed', 'canceled'));

-- ---------------------------------------------------------------------------
-- 2. Enforce the lifecycle's valid transitions server-side, regardless of
--    which client/policy is doing the writing (issue section 3).
-- ---------------------------------------------------------------------------
create or replace function public.enforce_game_status_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('lobby', 'active'),
    ('lobby', 'canceled'),
    ('active', 'canceled')
  ) then
    raise exception 'Invalid room status transition: % -> %', old.status, new.status;
  end if;

  return new;
end;
$$;

drop trigger if exists games_enforce_status_transition on public.games;
create trigger games_enforce_status_transition
  before update on public.games
  for each row
  when (old.status is distinct from new.status)
  execute function public.enforce_game_status_transition();

-- ---------------------------------------------------------------------------
-- 3. Owner-gated updates/deletes on `games` (issue section 2: only the Owner
--    may start/cancel/delete). Previously *any* seated player could update
--    the games row (needed only for the lobby -> active "start game" flip) —
--    tighten to the Owner.
-- ---------------------------------------------------------------------------
drop policy if exists "seated players can update their game" on public.games;

create policy "room owner can update their game"
  on public.games for update
  to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

-- Deletable states only (issue section 12): Active-Not-Started ('lobby') or
-- Canceled. 'active' covers both In-Progress and Finished (games.status
-- can't tell them apart — see the header comment) and both are
-- non-deletable per the spec, so excluding 'active' here is exactly right.
create policy "room owner can delete their room in a deletable state"
  on public.games for delete
  to authenticated
  using (created_by = auth.uid() and status in ('lobby', 'canceled'));

-- ---------------------------------------------------------------------------
-- 4. Canceling a room disables further gameplay writes (issue section 11).
-- ---------------------------------------------------------------------------
drop policy if exists "seated players can update game state" on public.game_state;

create policy "seated players can update game state"
  on public.game_state for update
  to authenticated
  using (
    exists (
      select 1 from public.players
      where players.game_id = game_state.game_id
        and players.user_id = auth.uid()
    )
    and exists (
      select 1 from public.games
      where games.id = game_state.game_id
        and games.status <> 'canceled'
    )
  );
