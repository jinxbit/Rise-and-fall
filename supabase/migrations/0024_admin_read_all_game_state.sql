-- Admin "all rooms" screen (issue #361): AdminRoomsPage.tsx lists every
-- room, public or private, via listAllRooms() (gameApi.ts). The games row
-- itself is already readable by any signed-in user (0001_init_schema.sql),
-- so no change is needed there. But a private, lobby-status room's
-- game_state isn't covered by 0021_remove_observers.sql's "seated players
-- and any signed-in user can read non-lobby game state" policy — without
-- this, listAllRooms() would get gameState: null for those, and
-- publicRoomBucket() (publicRoomsView.ts) would misclassify them (the same
-- bug 0019_public_game_state_visible.sql fixed for public rooms).
--
-- Additive to (not a replacement for) 0021's policy — Postgres OR's
-- together multiple permissive policies for the same command, same
-- technique 0017_admin_delete_any_game.sql uses — reusing its
-- profiles.is_admin flag. Written standalone rather than as a drop+recreate
-- of 0021's policy so it doesn't need to know that policy's exact wording.
create policy "admins can read any game state"
  on public.game_state for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.is_admin
    )
  );
