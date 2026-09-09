-- Issue #488 (HIDDEN_INFORMATION_PLAN.md §5.2/(a), RULE_ENFORCEMENT_PLAN.md
-- §6 "still outstanding" notes): closes the RLS gap where `game_state`'s
-- SELECT policy let any signed-in user read the full unredacted row of any
-- non-lobby game. 0021_remove_observers.sql's "any signed-in user can read
-- non-lobby game state" clause never references auth.uid() at all — it
-- expresses "the game has started", not "you are seated" — so a single
-- `GET /rest/v1/game_state?game_id=eq.<id>` with nothing but the anon key
-- returned real `chosenCardIdByPlayerId`/`actionHistory` picks, bypassing
-- everything get-game-state (HIDDEN_INFORMATION_PLAN.md §5) and the
-- apply-action/undo-action/redo-action responses (§8 phase 8) go to trouble
-- to mask.
--
-- Scoped exactly the way 0026_rule_enforcement_flag.sql scoped the
-- write-side lockdown: only a game with GameSettings.hiddenInformationEnabled
-- set loses direct SELECT access; every other game (the default, and every
-- game that predates this flag) reads exactly as it always has. Unlike 0026,
-- this blocks the *seated* player's direct read too, not just a stranger's —
-- RLS is row-granular and this row holds every seat's state at once, so
-- there is no USING clause that hands a seated player their own pick without
-- also handing them everyone else's still-secret one (the same
-- can't-filter-within-a-row limitation RULE_ENFORCEMENT_PLAN.md §6 and
-- HIDDEN_INFORMATION_PLAN.md §5.2 already note for Realtime). That's safe
-- because hiddenInformationEnabled is only ever set alongside
-- ruleEnforcementEnabled (CreateGamePage.tsx's hiddenInformationAvailable),
-- so get-game-state — a service-role Edge Function, unaffected by this
-- policy either way — is always the replacement read path for every such
-- game, seated or not.
--
-- 0024_admin_read_all_game_state.sql's admin policy is untouched: it's a
-- separate additive permissive policy (Postgres OR's them together), so an
-- admin keeps full, unredacted access regardless of what this one says.
drop policy if exists "seated players and any signed-in user can read non-lobby game state" on public.game_state;

create policy "seated players and any signed-in user can read non-lobby game state when hidden information is off"
  on public.game_state for select
  to authenticated
  using (
    not coalesce(
      (select (games.settings ->> 'hiddenInformationEnabled')::boolean from public.games where games.id = game_state.game_id),
      false
    )
    and (
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
    )
  );

-- ---------------------------------------------------------------------------
-- game_state_meta gains active_player_id, so listing screens keep working.
--
-- fetchGameStateSummaries (gameApi.ts) reads `game_state.active_player_id`
-- directly today for listMyGames/listPublicRooms/listAllRooms — including,
-- for the latter two, a game the viewer isn't seated in — which the SELECT
-- lockdown above would otherwise silently turn into "nobody's turn" for any
-- hiddenInformationEnabled room in a public/admin listing. Whose turn it is
-- isn't hidden information (HIDDEN_INFORMATION_PLAN.md never scopes it in —
-- only in-progress selectCards/decline picks are), so this follows
-- 0027_game_state_meta_pending_players.sql's exact precedent: denormalize
-- the column onto game_state_meta, whose own RLS (0025_game_state_meta.sql)
-- is deliberately left alone by this migration, and repoint gameApi.ts at it
-- instead of the now-locked-down game_state row.
-- ---------------------------------------------------------------------------
alter table public.game_state_meta
  add column if not exists active_player_id uuid references public.players (id);

comment on column public.game_state_meta.active_player_id is
  'Mirrors game_state.active_player_id (whose turn-order turn it is; not meaningful during boardSetup or the simultaneous selectCards/decline phases — see pending_player_ids for those). Never hidden information. Kept in sync by game_state_sync_meta.';

create or replace function public.game_state_sync_meta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_round_phase text;
  v_turn_order jsonb;
  v_turn_order_len int;
  v_board_setup jsonb;
  v_builder_id text;
  v_tile_placer_idx int;
  v_unit_placer_idx int;
  v_pending jsonb;
begin
  v_status := coalesce(new.state ->> 'status', 'unknown');
  v_round_phase := new.state ->> 'roundPhase';
  v_turn_order := coalesce(new.state -> 'turnOrder', '[]'::jsonb);
  v_turn_order_len := jsonb_array_length(v_turn_order);

  if v_status = 'boardSetup' then
    v_board_setup := new.state -> 'boardSetup';
    if v_board_setup is not null and jsonb_array_length(coalesce(v_board_setup -> 'tileTierQueue', '[]'::jsonb)) > 0 then
      -- currentTilePlacerId: the sole "build alone" builder if set, else turnOrder rotated by tilePlacerIndex.
      v_builder_id := v_board_setup ->> 'builderId';
      if v_builder_id is not null then
        v_pending := jsonb_build_array(v_builder_id);
      elsif v_turn_order_len > 0 then
        v_tile_placer_idx := coalesce((v_board_setup ->> 'tilePlacerIndex')::int, 0) % v_turn_order_len;
        v_pending := jsonb_build_array(v_turn_order -> v_tile_placer_idx);
      else
        v_pending := '[]'::jsonb;
      end if;
    elsif v_board_setup is not null and jsonb_typeof(v_board_setup -> 'unitsRemainingByPlayerId') = 'object'
          and (select count(*) from jsonb_object_keys(v_board_setup -> 'unitsRemainingByPlayerId')) > 0 then
      -- currentUnitPlacerId: turnOrder rotated by unitPlacerIndex.
      if v_turn_order_len > 0 then
        v_unit_placer_idx := coalesce((v_board_setup ->> 'unitPlacerIndex')::int, 0) % v_turn_order_len;
        v_pending := jsonb_build_array(v_turn_order -> v_unit_placer_idx);
      else
        v_pending := '[]'::jsonb;
      end if;
    else
      v_pending := '[]'::jsonb;
    end if;
  elsif v_status = 'active' and (v_round_phase = 'selectCards' or v_round_phase = 'decline') then
    -- Simultaneous phases: everyone still owed a turn at once, not just one "active" player.
    v_pending := coalesce(new.state -> 'pendingPlayerIds', '[]'::jsonb);
  else
    -- Turn-order phases (actions/purchase) already have active_player_id; lobby/completed have nobody pending.
    v_pending := '[]'::jsonb;
  end if;

  insert into public.game_state_meta (game_id, status, round_phase, turn, version, pending_player_ids, active_player_id, updated_at)
  values (
    new.game_id,
    v_status,
    v_round_phase,
    coalesce((new.state ->> 'turn')::int, 0),
    new.version,
    v_pending,
    new.active_player_id,
    now()
  )
  on conflict (game_id) do update set
    status = excluded.status,
    round_phase = excluded.round_phase,
    turn = excluded.turn,
    version = excluded.version,
    pending_player_ids = excluded.pending_player_ids,
    active_player_id = excluded.active_player_id,
    updated_at = excluded.updated_at;
  return new;
end;
$$;

-- Backfill existing rows the same way the trigger would compute them, by
-- re-running it once per existing game_state row (an unconditional row-level
-- trigger fires on this no-op update same as any other) — same technique
-- 0027_game_state_meta_pending_players.sql used.
update public.game_state set version = version;
