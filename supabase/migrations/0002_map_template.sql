-- Adds the ability to start a game from a pre-made map, skipping the
-- interactive tile-placement step of board setup (starting-unit placement
-- still happens normally). See src/content/mapTemplates.json for the
-- template catalog and src/engine/boardSetup.ts's
-- beginBoardSetupWithPresetBoard for how a chosen template is applied.

alter table public.games
  add column if not exists map_template_id text;

comment on column public.games.map_template_id is
  'Content id of a pre-made map template (src/content/mapTemplates.json) to start the game from, skipping interactive tile placement. Null = build the map interactively as usual.';
