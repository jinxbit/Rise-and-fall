-- Consolidates the growing set of per-game, creation-time settings
-- (0002_map_template.sql's map_template_id, 0004_hotseat_skip_pass_gate.
-- sql's skip_hotseat_pass_gate, 0005_tales_variant.sql's active_tale_ids,
-- 0006_game_length.sql's game_length) into a single JSONB column, so a new
-- pregame configuration knob no longer needs its own migration — see
-- src/lib/dbTypes.ts's GameSettings for the shape this column now holds.

alter table public.games
  add column if not exists settings jsonb not null default '{}'::jsonb;

update public.games
set settings = jsonb_build_object(
  'mapTemplateId', map_template_id,
  'skipHotseatPassGate', skip_hotseat_pass_gate,
  'activeTaleIds', to_jsonb(active_tale_ids),
  'gameLength', game_length
);

alter table public.games
  drop column if exists map_template_id,
  drop column if exists skip_hotseat_pass_gate,
  drop column if exists active_tale_ids,
  drop column if exists game_length;

comment on column public.games.settings is
  'Per-game, creation-time configuration as a single JSONB blob (mapTemplateId, skipHotseatPassGate, activeTaleIds, gameLength — see src/lib/dbTypes.ts''s GameSettings), replacing one column per setting. Set at creation (HomePage.tsx) and read pre-game-start by LobbyPage.tsx/buildGenesisState; once a game is running, GamePage.tsx reads the equivalent fields off GameState instead (see GameState.activeTaleIds/gameLength''s doc comments), not this column. Add new keys here instead of a new column/migration.';
