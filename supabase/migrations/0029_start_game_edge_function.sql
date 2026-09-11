-- Closes the one gap 0026_rule_enforcement_flag.sql's INSERT comment
-- deliberately left open, and issue #519's back-and-forth eventually settled
-- on fixing rather than living with: for a ruleEnforcementEnabled game,
-- genesis itself (the game_state INSERT, and the games.status flip to
-- 'active' that follows it) was still built and written entirely by
-- whichever client clicked Start, with no server check at all — unlike every
-- action after it. supabase/functions/start-game/index.ts now does that
-- server-side, mirroring apply-action/undo-action/redo-action's shape; this
-- migration blocks the matching direct client writes for an enforced game,
-- the same way 0026 already did for game_state's UPDATE.
--
-- Non-enforced games are completely untouched by both changes below —
-- gameApi.ts's startGameFromLobby() still writes them directly, exactly as
-- before.

-- ---------------------------------------------------------------------------
-- 1. game_state INSERT: same shape as 0026's UPDATE policy, just for the one
--    other write this table allows authenticated users to make.
-- ---------------------------------------------------------------------------
drop policy if exists "seated players can insert game state" on public.game_state;

create policy "seated players can insert game state when enforcement is off"
  on public.game_state for insert
  to authenticated
  with check (
    exists (
      select 1 from public.players
      where players.game_id = game_state.game_id
        and players.user_id = auth.uid()
    )
    and not coalesce(
      (select (games.settings ->> 'ruleEnforcementEnabled')::boolean from public.games where games.id = game_state.game_id),
      false
    )
  );

-- ---------------------------------------------------------------------------
-- 2. games.status 'lobby' -> 'active': the one transition that isn't safe to
--    gate with a plain RLS policy, because the rule we want ("a *direct*
--    client write may not make this specific old->new transition") depends
--    on both the row's old and new value in the same expression — a WITH
--    CHECK clause only ever sees the new row, and the owner-update policy
--    (0008_room_lifecycle.sql) still needs to keep allowing this same owner
--    to make plenty of other updates (e.g. toggling visibility) whose new
--    row also has status = 'active', just unchanged from before. The
--    transition trigger already has both old and new, so the restriction
--    lives there instead, exactly like the transition-legality check it's
--    added next to. `current_setting('role')` reads as 'service_role' only
--    for the Edge Functions' service-role client (Supabase's standard role
--    switch for that key) and 'authenticated' for an ordinary signed-in
--    user's PostgREST session, so this leaves every non-enforced game's
--    lobby -> active untouched, and never fires for start-game/index.ts
--    itself.
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

  if old.status = 'lobby' and new.status = 'active'
     and coalesce((new.settings ->> 'ruleEnforcementEnabled')::boolean, false)
     and current_setting('role') <> 'service_role' then
    raise exception 'An enforced game can only be started via the start-game Edge Function.';
  end if;

  return new;
end;
$$;
