-- Admin override for room deletion (issue #177): lets a designated admin
-- delete *any* game, regardless of who created it or what state it's in —
-- unlike 0008_room_lifecycle.sql's owner-only policy, which only lets the
-- creator delete their own room, and only while it's 'lobby' or 'canceled'.
--
-- There's no roles system in this app (see 0001_init_schema.sql/
-- 0005_discord_webhooks.sql — profiles is just per-account preferences), so
-- this adds the smallest possible one: a boolean flag on `profiles`, unset
-- by default, that nothing in the UI can set — an admin grants themselves
-- the flag directly via SQL (Supabase dashboard -> SQL Editor), using their
-- own auth.users.id (Authentication -> Users -> copy the UUID next to your
-- account), e.g.:
--
--   insert into public.profiles (user_id, is_admin)
--   values ('<your-auth-user-id>', true)
--   on conflict (user_id) do update set is_admin = true;

alter table public.profiles add column if not exists is_admin boolean not null default false;

-- Additive to (not a replacement for) the owner policy from
-- 0008_room_lifecycle.sql — Postgres OR's together multiple permissive
-- policies for the same command, so a room stays deletable by its owner
-- (within the normal lobby/canceled states) *or* by an admin (any state).
create policy "admins can delete any game"
  on public.games for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.is_admin
    )
  );
