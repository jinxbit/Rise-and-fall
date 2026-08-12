-- Configurable game length: how many achievements (across all players,
-- total) end the game once claimed — see content/achievements.json's
-- gameLength (default/min/max) and src/engine/round.ts's finishRound.
-- A per-game, creation-time choice (see HomePage.tsx's GameLengthSelector),
-- same shape as 0002_map_template.sql's map_template_id.

alter table public.games
  add column if not exists game_length integer not null default 4 check (game_length between 1 and 6);

comment on column public.games.game_length is
  'Total achievements claimed (across all players) that ends the game — content/achievements.json''s gameLength.min/max bounds it (1-6). Set at creation (HomePage.tsx); read by GamePage.tsx via resolveAchievementContent(game.game_length).';
