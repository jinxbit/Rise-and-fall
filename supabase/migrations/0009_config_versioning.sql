-- Room lifecycle Phase 2: configuration versioning + player readiness — see
-- the "Online Game Room Specification" issue (#40), sections 8 (Configuration
-- Before Room Creation) and 9 (Configuration Changes and Player Readiness).
--
-- games.config_version bumps every time the Owner edits games.settings.
-- players.ready_for_version tracks the config_version each player has last
-- confirmed Ready for. A player is "ready" iff ready_for_version =
-- games.config_version. The Owner is exempt from readiness (enforced
-- client-side in LobbyPage.tsx/roomReadiness.ts — RLS still lets the Owner's
-- own player row carry a stale ready_for_version, same as it always could).

-- ---------------------------------------------------------------------------
-- 1. New columns.
-- ---------------------------------------------------------------------------
alter table public.games
  add column if not exists config_version int not null default 0;

alter table public.players
  add column if not exists ready_for_version int not null default 0;

comment on column public.games.config_version is
  'Bumped by games_bump_config_version whenever settings changes. A player is ready iff their ready_for_version matches this.';
comment on column public.players.ready_for_version is
  'The games.config_version this player has last confirmed Ready for (see markReady in gameApi.ts). Set automatically on insert to the game''s current config_version — new players are implicitly ready for the config as it stood when they joined (issue section 9).';

-- ---------------------------------------------------------------------------
-- 2. Editing settings or the player-count bounds bumps config_version, and
--    is only allowed pre-start (issue section 3: configuration is locked
--    once In Progress; section 7 counts Player Count as configuration too).
-- ---------------------------------------------------------------------------
create or replace function public.bump_config_version_on_settings_change()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'lobby' then
    raise exception 'Configuration can only change while the room is Active - Not Started';
  end if;
  new.config_version = old.config_version + 1;

  return new;
end;
$$;

drop trigger if exists games_bump_config_version on public.games;
create trigger games_bump_config_version
  before update on public.games
  for each row
  when (
    old.settings is distinct from new.settings
    or old.min_players is distinct from new.min_players
    or old.max_players is distinct from new.max_players
  )
  execute function public.bump_config_version_on_settings_change();

-- ---------------------------------------------------------------------------
-- 3. New players are implicitly ready for the config as it stood when they
--    joined, regardless of what the client sends (issue section 9, "New
--    players after changes").
-- ---------------------------------------------------------------------------
create or replace function public.set_initial_ready_for_version()
returns trigger
language plpgsql
as $$
begin
  select config_version into new.ready_for_version
  from public.games
  where id = new.game_id;

  return new;
end;
$$;

drop trigger if exists players_set_initial_ready_for_version on public.players;
create trigger players_set_initial_ready_for_version
  before insert on public.players
  for each row
  execute function public.set_initial_ready_for_version();

-- ---------------------------------------------------------------------------
-- 4. A player can only mark themselves ready for the room's *current*
--    config version, not some arbitrary past or future one (issue section
--    9, "Ready (version N) -> config changes -> Not Ready (version N+1)").
-- ---------------------------------------------------------------------------
create or replace function public.enforce_ready_for_version()
returns trigger
language plpgsql
as $$
declare
  current_version int;
begin
  select config_version into current_version
  from public.games
  where id = new.game_id;

  if new.ready_for_version <> current_version then
    raise exception 'ready_for_version must match the room''s current config_version (%), got %', current_version, new.ready_for_version;
  end if;

  return new;
end;
$$;

drop trigger if exists players_enforce_ready_for_version on public.players;
create trigger players_enforce_ready_for_version
  before update on public.players
  for each row
  when (old.ready_for_version is distinct from new.ready_for_version)
  execute function public.enforce_ready_for_version();
