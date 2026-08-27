-- Per-account preferences that don't warrant their own column (issue #346
-- follow-up) — a single JSONB blob, mirroring games.settings
-- (0007_game_settings.sql/GameSettings), so a future simple profile
-- preference doesn't need its own migration + column.
--
-- Currently holds:
--   unitReserveDisplay: 'remaining' | 'placed' | 'both' | absent — how
--     PlayersStrip's per-kind unit badge (RoundView.tsx) reports a player's
--     unit supply. Absent means "use the default" (remaining), matching the
--     game's original, non-configurable behaviour — see
--     src/lib/unitReserveDisplay.ts and gameApi.ts's getProfilePreferences/
--     saveProfilePreferences.

alter table public.profiles add column if not exists preferences jsonb not null default '{}'::jsonb;
