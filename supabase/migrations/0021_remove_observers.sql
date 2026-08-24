-- Remove observer tracking (issue #274): the "Stop observing" button and the
-- per-user `observers` rows it managed are gone from the client. Without a
-- way to leave, every visitor who ever opened a room would stay tracked as
-- observing it forever, so this drops the whole join/leave/list mechanism
-- rather than just the button.
--
-- The `observers` table's only other job was gating `game_state` SELECT for
-- a non-seated visitor of a private room. That gate was never a real privacy
-- boundary: 0010_observers.sql's own insert policy let any signed-in user
-- self-join as an observer of any active game with no visibility check, and
-- `games`/`players` rows are already readable by any signed-in user
-- (0001_init_schema.sql) regardless of `visibility`. So replacing it with a
-- blanket "any signed-in user may read a non-lobby game's state" policy
-- removes the pointless join step without changing what was actually
-- reachable before.
drop policy if exists "seated players, observers, and public room visitors can read game state" on public.game_state;

create policy "seated players and any signed-in user can read non-lobby game state"
  on public.game_state for select
  to authenticated
  using (
    exists (
      select 1 from public.players
      where players.game_id = game_state.game_id
        and players.user_id = auth.uid()
    )
    or exists (
      select 1 from public.games
      where games.id = game_state.game_id
        and games.status <> 'lobby'
    )
  );

drop table if exists public.observers;
