-- issue #441 follow-up: game_state_meta (0025_game_state_meta.sql) already
-- lets listing screens skip the full game_state.state blob, but
-- gameCardView.ts's pendingActorIdsFor() had to go silent (report "nobody
-- pending") during boardSetup and the simultaneous selectCards/decline
-- phases, since who's specifically still owed a turn in those windows isn't
-- `game_state.active_player_id` — it either lives in `state.pendingPlayerIds`
-- (selectCards/decline: everyone still owed a turn, not just one "active"
-- player — see engine/turnOrder.ts) or has to be derived from
-- `state.boardSetup`/`state.turnOrder` (see engine/boardSetup.ts's
-- currentTilePlacerId/currentUnitPlacerId). This column denormalizes that
-- into a plain scalar array so listing screens can restore accurate turn
-- highlighting without ever reading `state` itself. Never reveals hidden
-- information (HIDDEN_INFORMATION_PLAN.md): it's only ever player ids who
-- haven't acted yet, never what they chose.
alter table public.game_state_meta
  add column if not exists pending_player_ids jsonb not null default '[]'::jsonb;

comment on column public.game_state_meta.pending_player_ids is
  'Player ids still owed a turn right now: state.pendingPlayerIds during selectCards/decline (everyone pending at once), the derived boardSetup tile/unit placer during boardSetup (0-or-1 id), or [] otherwise (turn-order phases use active_player_id instead; lobby/completed have nobody pending). Kept in sync by game_state_sync_meta.';

-- ---------------------------------------------------------------------------
-- Replaces game_state_sync_meta (0025_game_state_meta.sql) to also compute
-- pending_player_ids on every game_state write.
-- ---------------------------------------------------------------------------
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

  insert into public.game_state_meta (game_id, status, round_phase, turn, version, pending_player_ids, updated_at)
  values (
    new.game_id,
    v_status,
    v_round_phase,
    coalesce((new.state ->> 'turn')::int, 0),
    new.version,
    v_pending,
    now()
  )
  on conflict (game_id) do update set
    status = excluded.status,
    round_phase = excluded.round_phase,
    turn = excluded.turn,
    version = excluded.version,
    pending_player_ids = excluded.pending_player_ids,
    updated_at = excluded.updated_at;
  return new;
end;
$$;

-- Backfill existing rows the same way the trigger would compute them, by
-- re-running it once per existing game_state row (an unconditional row-level
-- trigger fires on this no-op update same as any other).
update public.game_state set version = version;
