-- RULE_ENFORCEMENT_PLAN.md §6/§8 phase 8 (per-game opt-in, decided
-- 2026-09-05): rather than a global cutover, direct client writes to
-- game_state are only blocked for games that explicitly opt in via
-- games.settings.ruleEnforcementEnabled (src/lib/dbTypes.ts's GameSettings,
-- set at creation by CreateGamePage.tsx, defaulting to false). Every game
-- that existed before this key was added has no such key in its settings
-- jsonb, so coalesce(...,false) reads it as off — completely unaffected,
-- same as every default new game. Only a flagged game's game_state becomes
-- service-role-write-only, i.e. only writable via the apply-action/
-- undo-action/redo-action Edge Functions (0001_init_schema.sql's original
-- policies let any seated player write directly; the service role bypasses
-- RLS regardless of these policies either way, per Supabase's usual
-- behavior, so those functions are unaffected by this migration).
--
-- INSERT is deliberately left alone (still any seated player, unconditional,
-- exactly as 0001_init_schema.sql already has it): the one insert into
-- game_state per game is LobbyPage.tsx's handleStart -> insertGameState,
-- writing the deterministic genesis state (buildGenesisState) before any
-- action has been submitted — it isn't an "action against existing state" in
-- §4's sense (apply-action's own loadGameContext requires a game_state row
-- to already exist), so it's out of this document's scope the same way
-- HIDDEN_INFORMATION_PLAN.md's concerns are; only UPDATE (every write after
-- that first one) is what §4.1's enforcement model is actually about.
--
-- Replaces (rather than adds to) 0001_init_schema.sql's update policy, since
-- Postgres OR's together multiple permissive policies for the same command —
-- an additional policy could only ever grant more access, never restrict it.
drop policy if exists "seated players can update game state" on public.game_state;

create policy "seated players can update game state when enforcement is off"
  on public.game_state for update
  to authenticated
  using (
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
