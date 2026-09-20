-- Site-wide chat name lookup (issue #684, CHAT_PLAN.md §10.5, decided):
-- in-game chat resolves a sender's name from their seat (issue #682,
-- `players.display_name`, readable by any signed-in user), but site-wide
-- chat has no seats to fall back to, so a viewer who had never shared a game
-- with the sender saw the generic 'Player' label instead of their custom
-- name — `profiles.display_name` has been readable only by its own owner
-- since 0013_discord_notify_backend.sql dropped the co-player carve-out.
--
-- Decision (issue #684): a custom display name may be visible to any
-- signed-in user; `discord_webhook_url` must not be. A plain RLS relaxation
-- can't express that split (RLS is row-, not column-scoped, so widening
-- `profiles`' select policy would expose the webhook column too), so this
-- adds a `security definer` function — mirroring `chat_enabled()`'s own
-- pattern (0031_chat_messages.sql) — that only ever returns
-- `(user_id, display_name)`, never the row itself, so it can't leak the
-- webhook column no matter what a caller passes in.
create or replace function public.chat_sender_display_names(sender_ids uuid[])
returns table (user_id uuid, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  select profiles.user_id, profiles.display_name
  from public.profiles
  where profiles.user_id = any(sender_ids)
    and profiles.display_name is not null
$$;

comment on function public.chat_sender_display_names(uuid[]) is
  'Site-wide chat name lookup (issue #684, CHAT_PLAN.md §10.5): exposes only (user_id, display_name) to any signed-in caller, deliberately narrower than the profiles row so discord_webhook_url stays owner-only. Mirrors chat_enabled()''s security definer pattern.';

-- Postgres grants EXECUTE on a new function to PUBLIC (which includes the
-- anon role) by default — revoke that and grant only to authenticated,
-- matching every other chat surface (site-wide chat itself requires a
-- session; see 0031_chat_messages.sql's "read site-wide chat" policy).
revoke all on function public.chat_sender_display_names(uuid[]) from public;
grant execute on function public.chat_sender_display_names(uuid[]) to authenticated;
