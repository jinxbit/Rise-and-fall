-- Discord "your turn" notifications now send from the backend
-- (supabase/functions/notify-discord-turn) instead of a co-player's
-- browser (see 0005_discord_webhooks.sql and README.md's "Discord turn
-- notifications" section for the old design and why it moved). The Edge
-- Function uses the service-role key, which bypasses RLS entirely, so
-- browsers no longer need to read a co-player's webhook URL to notify
-- them — drop that policy and go back to strictly own-row access.

drop policy if exists "co-players can read each other's webhook url" on public.profiles;
