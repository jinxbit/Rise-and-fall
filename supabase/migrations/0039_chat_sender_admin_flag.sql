-- Admin tag on chat messages (issue #729, CHAT_PLAN.md §22): since issue
-- #719 (0038_chat_admin_access.sql) let the site admin read and post in
-- every game's chat, a message they post in a game they aren't seated in is
-- indistinguishable from an ordinary player's — there was no way to tell it
-- came through that admin-only carve-out.
--
-- Widens `chat_sender_display_names` (0035_chat_sender_display_names.sql) to
-- also return `is_admin`, so `ChatPanel.tsx` can render an "Admin" tag next
-- to the sender's name regardless of which surface resolved it (seat lookup
-- or this RPC). The row filter widens from "display_name is not null" to
-- "display_name is not null or is_admin" so an admin who has never set a
-- custom display name is still returned (with `display_name` null) rather
-- than omitted entirely, which would have hidden the flag along with the
-- name. The return type changes, so this drops and recreates the function
-- rather than `create or replace` (Postgres rejects changing the OUT columns
-- of an existing function that way).
drop function if exists public.chat_sender_display_names(uuid[]);

create function public.chat_sender_display_names(sender_ids uuid[])
returns table (user_id uuid, display_name text, is_admin boolean)
language sql
stable
security definer
set search_path = public
as $$
  select profiles.user_id, profiles.display_name, profiles.is_admin
  from public.profiles
  where profiles.user_id = any(sender_ids)
    and (profiles.display_name is not null or profiles.is_admin)
$$;

comment on function public.chat_sender_display_names(uuid[]) is
  'Site-wide chat name + admin-tag lookup (issue #729, extending issue #684''s CHAT_PLAN.md §10.5): exposes only (user_id, display_name, is_admin) to any signed-in caller, deliberately narrower than the profiles row so discord_webhook_url stays owner-only.';

-- Postgres grants EXECUTE on a new function to PUBLIC by default — revoke
-- that and grant only to authenticated, matching the function it replaces.
revoke all on function public.chat_sender_display_names(uuid[]) from public;
grant execute on function public.chat_sender_display_names(uuid[]) to authenticated;
