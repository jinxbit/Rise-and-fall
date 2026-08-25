-- Unit plate colour settings (issue #311 follow-up) — lets a player
-- customize the map's unit-plate fill for each of the 3 card-zone states
-- (hand / selected-to-play / discard), overriding the defaults in
-- src/lib/unitColors.ts. Stored per-account like display_name
-- (0015_profile_display_name.sql); null means "use the default" for that
-- state. Reusing profiles' existing RLS (0005_discord_webhooks.sql) — same
-- "own row, or a co-player's row" read policy applies to these columns too.

alter table public.profiles add column if not exists unit_color_hand text;
alter table public.profiles add column if not exists unit_color_selected text;
alter table public.profiles add column if not exists unit_color_discard text;

alter table public.profiles
  add constraint profiles_unit_color_hand_format check (unit_color_hand is null or unit_color_hand ~* '^#[0-9a-f]{6}$');
alter table public.profiles
  add constraint profiles_unit_color_selected_format check (unit_color_selected is null or unit_color_selected ~* '^#[0-9a-f]{6}$');
alter table public.profiles
  add constraint profiles_unit_color_discard_format check (unit_color_discard is null or unit_color_discard ~* '^#[0-9a-f]{6}$');
