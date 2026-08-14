-- Fix: a seated player must not be able to also join as an observer of the
-- same game (issue #109). 0010_observers.sql's insert policy only checked
-- that the room is active, not that the joining user isn't already in
-- public.players for that game — GamePage.tsx's `canObserve` client-side
-- gate already excludes seated players, but the RLS policy is the last line
-- of defense against a direct insert (devtools, another client, a future
-- caller that forgets the client-side gate).
drop policy if exists "users can start observing an active game" on public.observers;

create policy "users can start observing an active game they are not seated in"
  on public.observers for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.games
      where games.id = observers.game_id
        and games.status = 'active'
    )
    and not exists (
      select 1 from public.players
      where players.game_id = observers.game_id
        and players.user_id = auth.uid()
    )
  );
