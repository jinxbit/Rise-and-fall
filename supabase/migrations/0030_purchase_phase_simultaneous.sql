-- Issue #553: the purchase phase (round step 4, buying a card back from
-- decline) becomes simultaneous, like selectCards/decline, instead of turn
-- order — src/engine/round.ts/applyAction.ts already changed in the same
-- commit (beginPurchasePhase leaves activePlayerId null and every pending
-- player may act in any order; skipEmptyDeclinePurchasers now filters the
-- whole pendingPlayerIds list instead of only its front). This migration is
-- the DB-side mirror: game_state_meta.pending_player_ids
-- (0027_game_state_meta_pending_players.sql, refined by
-- 0028_hidden_information_rls_lockdown.sql) denormalizes "who's still owed a
-- turn right now" for listing screens (gameCardView.ts's
-- pendingActorIdsFor) without downloading the full game_state blob — it
-- needs to start reporting the purchase phase's whole pendingPlayerIds list
-- the same way it already does for selectCards/decline, not just leave
-- turn-highlighting to active_player_id (which is now always null during
-- purchase, same as decline).
--
-- No RLS change: pending_player_ids never carries hidden information either
-- way (HIDDEN_INFORMATION_PLAN.md never scopes purchase in — buying back
-- from one's own decline was never masked, turn order or not), so the
-- existing game_state_meta policies are untouched.
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
  elsif v_status = 'active' and (v_round_phase = 'selectCards' or v_round_phase = 'decline' or v_round_phase = 'purchase') then
    -- Simultaneous phases: everyone still owed a turn at once, not just one "active" player.
    v_pending := coalesce(new.state -> 'pendingPlayerIds', '[]'::jsonb);
  else
    -- The turn-order actions phase already has active_player_id; lobby/completed have nobody pending.
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

comment on column public.game_state_meta.pending_player_ids is
  'Player ids still owed a turn right now: state.pendingPlayerIds during selectCards/decline/purchase (everyone pending at once, issue #553), the derived boardSetup tile/unit placer during boardSetup (0-or-1 id), or [] otherwise (the turn-order actions phase uses active_player_id instead; lobby/completed have nobody pending). Kept in sync by game_state_sync_meta.';

comment on column public.game_state_meta.active_player_id is
  'Mirrors game_state.active_player_id (whose turn-order turn it is; not meaningful during boardSetup or the simultaneous selectCards/decline/purchase phases, issue #553 — see pending_player_ids for those). Never hidden information. Kept in sync by game_state_sync_meta.';

-- Backfill existing rows the same way the trigger would compute them, by
-- re-running it once per existing game_state row (an unconditional row-level
-- trigger fires on this no-op update same as any other) — same technique
-- 0027_game_state_meta_pending_players.sql/0028_hidden_information_rls_lockdown.sql used.
update public.game_state set version = version;
