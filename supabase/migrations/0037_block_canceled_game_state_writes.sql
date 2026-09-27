-- Issue #713: 0008_room_lifecycle.sql's "seated players can update game
-- state" policy blocked writes once games.status = 'canceled' (section 4 of
-- that migration). 0026_rule_enforcement_flag.sql replaced that policy
-- wholesale to add the ruleEnforcementEnabled check — Postgres OR's
-- permissive policies together, so replacing rather than adding a second one
-- is the only way to *restrict* access — and dropped the canceled check in
-- the process, leaving a canceled room's client-trusted game_state directly
-- writable again by any of its seated players.
--
-- Recreate the policy with both conditions: 0008's original
-- `games.status <> 'canceled'`, alongside 0026's enforcement check.
drop policy if exists "seated players can update game state when enforcement is off" on public.game_state;

create policy "seated players can update game state when enforcement is off"
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
    and not coalesce(
      (select (games.settings ->> 'ruleEnforcementEnabled')::boolean from public.games where games.id = game_state.game_id),
      false
    )
  );

-- The rule-enforced write path (apply-action/undo-action/redo-action) has the
-- same gap — those functions write via the service role, which bypasses RLS
-- entirely, so no policy here reaches them. Closed instead in
-- supabase/functions/_shared/gameEnforcement.ts (loadGameContext's callers
-- now reject a canceled game up front) — see that file for the by-hand check
-- this migration can't express.
--
-- `completed` needs no equivalent guard, on either path: games.status never
-- actually reaches 'completed' — enforce_game_status_transition (also
-- 0008_room_lifecycle.sql) only allows lobby->active, lobby->canceled and
-- active->canceled, so a finished game's `games` row stays 'active' forever;
-- "finished" lives only in game_state.state.status (dbTypes.ts's GameRow doc
-- comment, todo.md #98). Gating this policy on games.status = 'completed'
-- would therefore be dead code.
