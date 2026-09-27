-- Security fix (issue #712): 0005_discord_webhooks.sql's "users can update
-- their own profile" policy lets an authenticated user change any column on
-- their own `profiles` row, with no column-level limit — and
-- 0017_admin_delete_any_game.sql later added `is_admin` to that same table.
-- Combined, any signed-in user could set `is_admin = true` on themselves
-- through the ordinary anon-key client (no SQL access needed), which then
-- lets them delete any game (0017) and read any game's state, including
-- hidden information (0024/0025).
--
-- RLS can't express "this column may not change" — a WITH CHECK clause only
-- sees the new row, not whether the value actually moved — so this uses a
-- trigger instead, the same reason 0029_start_game_edge_function.sql's
-- `enforce_game_status_transition` isn't a plain policy. Role detection
-- mirrors that trigger: `current_setting('role')` reads as 'service_role' for
-- the Edge Functions' and any dashboard/SQL-editor (`postgres`) session, and
-- 'authenticated'/'anon' for an ordinary PostgREST session — so this only
-- ever fires for a direct client write, never for a trusted server-side one.
create or replace function public.enforce_profiles_is_admin_unchanged()
returns trigger
language plpgsql
as $$
begin
  if current_setting('role') in ('authenticated', 'anon') then
    if tg_op = 'INSERT' and coalesce(new.is_admin, false) then
      raise exception 'is_admin cannot be set by a client session';
    elsif tg_op = 'UPDATE' and new.is_admin is distinct from old.is_admin then
      raise exception 'is_admin cannot be changed by a client session';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_profiles_is_admin_unchanged on public.profiles;
create trigger enforce_profiles_is_admin_unchanged
  before insert or update on public.profiles
  for each row execute function public.enforce_profiles_is_admin_unchanged();
