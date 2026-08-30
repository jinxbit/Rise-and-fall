-- The Tales variant: which Tale ids (src/content/tales.json) are active for
-- a game, chosen at creation time (see HomePage.tsx's TaleSelector) — a
-- per-game, immutable-once-created setting, same shape as
-- 0002_map_template.sql's map_template_id. Read by GamePage.tsx to merge
-- each active Tale's content onto the base UnitContent (see
-- src/engine/tales.ts's applyTaleModifiers) before resolving any action.
-- An empty array (the default) means no Tales are active — ordinary base
-- game rules, unaffected.

alter table public.games
  add column if not exists active_tale_ids text[] not null default '{}'::text[];

comment on column public.games.active_tale_ids is
  'Content ids of active Tales (src/content/tales.json) for this game. Empty = Tales variant off. Set at game creation (HomePage.tsx); merged into the effective UnitContent by GamePage.tsx via src/engine/tales.ts''s applyTaleModifiers.';
