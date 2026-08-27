-- Unit reserve display preference (issue #346) — lets a player choose
-- whether PlayersStrip's per-kind unit badge (RoundView.tsx) shows their
-- remaining supply, units already placed, or both. Stored per-account like
-- unit_color_* (0022_unit_plate_colors.sql); null means "use the default"
-- (remaining), matching the game's original, non-configurable behaviour.

alter table public.profiles add column if not exists unit_reserve_display text;

alter table public.profiles
  add constraint profiles_unit_reserve_display_values check (unit_reserve_display is null or unit_reserve_display in ('remaining', 'placed', 'both'));
