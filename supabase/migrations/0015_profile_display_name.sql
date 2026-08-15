-- Custom display name (issue #56) — lets a player override the name that's
-- otherwise derived from their Discord account (full_name/name) wherever a
-- display name is shown or copied into a `players`/`observers` row. Stored
-- per-account like the Discord webhook URL (0005_discord_webhooks.sql),
-- editable any time from the home page. Null means "use the Discord name" —
-- see src/lib/displayName.ts for the fallback chain.

alter table public.profiles add column if not exists display_name text;

alter table public.profiles
  add constraint profiles_display_name_length check (display_name is null or char_length(btrim(display_name)) between 1 and 40);
