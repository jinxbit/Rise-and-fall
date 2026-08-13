-- Room names — see the "Online Game Room Specification" issue (#40) follow-up:
-- rooms should have a name, chosen by the Owner at creation, and immutable
-- afterward.
--
-- Existing rows predate this column, so they're backfilled from room_code
-- (the only identifier they had) before the not-null/length constraint goes
-- on. New rows always supply a real name via createGame (gameApi.ts).

alter table public.games
  add column if not exists name text;

update public.games set name = 'Room ' || room_code where name is null;

alter table public.games
  alter column name set not null;

alter table public.games
  add constraint games_name_length check (char_length(btrim(name)) between 1 and 60);

comment on column public.games.name is
  'Owner-chosen at creation, immutable afterward (games_enforce_name_immutable trigger below).';

-- ---------------------------------------------------------------------------
-- Immutable once set: the Owner cannot rename a room after creation.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_game_name_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Room name cannot be changed after creation';
end;
$$;

drop trigger if exists games_enforce_name_immutable on public.games;
create trigger games_enforce_name_immutable
  before update on public.games
  for each row
  when (old.name is distinct from new.name)
  execute function public.enforce_game_name_immutable();
