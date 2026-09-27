-- Issue #719: let the site admin (profiles.is_admin, 0017_admin_delete_any_game.sql)
-- read and post in every game's chat, not just games they're seated in or
-- that are visibility = 'public'. Mirrors 0024_admin_read_all_game_state.sql's
-- reasoning exactly: an admin can already read any game's `games` row and
-- `game_state` (0024), so a private game's chat was the one surface of a room
-- an admin couldn't see or take part in.
--
-- Additive to (not a replacement for) 0031_chat_messages.sql's "read game
-- chat"/"post chat" policies — Postgres OR's together multiple permissive
-- policies for the same command, same technique 0017/0024 use, so this only
-- widens who may read/post rather than touching the existing seated-player or
-- public-visitor rules.
create policy "admins can read any game chat"
  on public.chat_messages for select
  to authenticated
  using (
    game_id is not null
    and public.chat_enabled()
    and exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.is_admin
    )
  );

create policy "admins can post any chat"
  on public.chat_messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and public.chat_enabled()
    and exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.is_admin
    )
  );
