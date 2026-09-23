-- issue #648: a small rolling buffer of recent per-game GameStates, so
-- get-game-state can answer a base-version-behind read with a structural
-- patch of `stateWithoutHistory` instead of sending the whole thing again —
-- the constant-size remainder issue #647's actionHistory-only delta didn't
-- touch. See src/engine/redaction.ts's `buildRedactedGameStateDelta`/
-- `applyRedactedGameStateDelta` and supabase/functions/_shared/
-- gameEnforcement.ts's `writeGameStateCAS`/`loadBufferedGameState`.
--
-- This does NOT revive HIDDEN_INFORMATION_PLAN.md §5.3's dropped reveal
-- high-water mark: redactStateForPlayer is still called against a
-- materialised GameState, same as it always was for a live read — this table
-- just gives that call an *older* materialised GameState to also call it
-- against, so a diff can be computed. No replay anywhere on this path.
--
-- A surrogate `id` primary key (matching 0031_chat_messages.sql's
-- convention), not a composite (game_id, version) one — an
-- always-identity `id` lets the application code use a plain insert/select
-- without special-casing a multi-column key, and `unique (game_id, version)`
-- below is exactly as strong a guarantee for this table's actual access
-- pattern (look up one game's one version).
--
-- Service-role only, same posture as `game_state` itself once a game is
-- ruleEnforcementEnabled (0026_rule_enforcement_flag.sql): a row here can
-- carry another player's still-secret pick exactly like `game_state` can, and
-- no client ever has a legitimate reason to read this table directly — only
-- the Edge Functions (get-game-state, apply-action, undo-action, redo-action,
-- start-game), which run as service_role and so bypass RLS entirely. RLS is
-- enabled with no policies at all, so an ordinary `authenticated` or `anon`
-- request is denied outright, same as a table with RLS on and nothing
-- granted.
create table public.game_state_snapshots (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games(id) on delete cascade,
  version int not null,
  state jsonb not null,
  created_at timestamptz not null default now(),
  unique (game_id, version)
);

alter table public.game_state_snapshots enable row level security;

comment on table public.game_state_snapshots is
  'Rolling buffer (capped per game — see writeGameStateCAS) of recent GameStates, keyed by version, so get-game-state can diff a caller''s base version against a materialised earlier state instead of replaying (issue #648). Service-role only; no RLS policy grants any client access.';
