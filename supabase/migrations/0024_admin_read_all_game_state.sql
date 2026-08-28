-- Admin "all rooms" screen (issue #361): AdminRoomsPage.tsx lists every
-- room, public or private, via listAllRooms() (gameApi.ts). The games row
-- itself is already readable by any signed-in user (0001_init_schema.sql),
-- so no change is needed there. But a private room's game_state is only
-- readable by its seated players/observers (0010_observers.sql) — without
-- this, listAllRooms() would get gameState: null for every private room an
-- admin isn't in, and publicRoomBucket() (publicRoomsView.ts) would
-- misclassify a finished private room as still "in progress" (the same bug
-- 0019_public_game_state_visible.sql fixed for public rooms). Extend the
-- same OR-policy pattern to admins, reusing 0017_admin_delete_any_game.sql's
-- profiles.is_admin flag.
drop policy if exists "seated players, observers, and public room visitors can read game state" on public.game_state;

create policy "seated players, observers, public room visitors, and admins can read game state"
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
    or exists (
      select 1 from public.games
      where games.id = game_state.game_id
        and games.visibility = 'public'
    )
    or exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.is_admin
    )
  );
