-- Fix: a public room's Finished status silently reverted to "In Progress" on
-- the Public Rooms screen until someone individually visited it (issue
-- reported by jinxbit). listPublicRooms() (gameApi.ts) reads every public
-- room's game_state row so publicRoomBucket() (publicRoomsView.ts) can check
-- gameState.status === 'completed' (games.status itself never reaches
-- 'completed' — see dbTypes.ts's GameRow comment). But 0010_observers.sql's
-- game_state SELECT policy only allows seated players and observers to read
-- it, so a browsing user who was neither got `gameState: null` back for
-- every game they hadn't opened, and publicRoomBucket() falls back to
-- 'inProgress' for a null gameState. Opening the room auto-joined them as an
-- observer (GamePage.tsx), which satisfied the policy from then on — masking
-- the bug as "works after visiting once".
--
-- Every other part of a public room (the games row itself, its players) is
-- already readable by any signed-in user (0001_init_schema.sql, see
-- listPublicRooms's comment) — visibility='public' means exactly that.
-- game_state was the one piece still gated behind participation. Extend the
-- policy so a public room's game_state is readable the same way.
drop policy if exists "seated players and observers can read game state" on public.game_state;

create policy "seated players, observers, and public room visitors can read game state"
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
  );
