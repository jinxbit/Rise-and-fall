# CLAUDE.md

Guidance for working in this repo. Read this before making changes.

## What this is

**Rise & Fall** — a private, non-commercial web app for playing an original
turn-based strategy board game (hex map, tile-laying setup, unit-kind cards,
achievements, VP scoring) remotely (live/async) or on one shared device
(hotseat). Vite + React 19 + TypeScript + Tailwind v4 on the frontend,
Supabase (Postgres + RLS + Realtime + Auth + Edge Functions) on the backend,
Vercel for hosting.

All code, UI, and copy are original. Do not add third-party rulebook text,
card text, or artwork.

## Commands

```bash
npm install          # or npm ci
npm run dev          # Vite dev server on :5173
npm run test         # vitest run — 62 files / ~1130 tests, ~35s
npm run test:watch   # vitest watch
npm run test:production  # smoke-test the LIVE Supabase project (needs SMOKE_* secrets)
npm run lint         # oxlint (not eslint) — sub-second
npm run build        # tsc -b (3 projects) + vite build — ~10s
```

CI (`.github/workflows/ci.yml`) runs `lint`, `test`, `build` in that order on
every PR. Run all three before pushing; they are fast enough that there is no
excuse to skip them.

Copy `.env.example` to `.env.local` for local dev. Without
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` the app throws a
"Configuration error" at startup by design (`src/lib/supabase.ts`). Tests and
build need no env vars.

## Architecture — the layering rules that matter

```
src/engine/    pure rules engine — no React, no Supabase, no I/O, no JSON imports
src/content/   hand-authored game data (JSON + schemas) + resolveContent.ts
src/lib/       Supabase client, typed queries (gameApi.ts), storage encoding
src/hooks/     React hooks (auth, admin, display name, preferences)
src/pages/     routed screens (see src/App.tsx)
src/components/ UI, incl. HexBoard / RoundView / BoardSetupView
supabase/      migrations + Edge Functions (rule enforcement, notifications)
src/test/      vitest setup, an in-process production-like Supabase stack, fixtures
```

Four invariants hold across the whole codebase. Breaking any of them will
break replay, the Edge Functions, or both:

1. **`applyAction()` (`src/engine/applyAction.ts`) is the only place game
   rules run.** UI and network layers treat `GameState` as opaque and mutate
   it exclusively by dispatching an `Action` (`src/engine/actions.ts`). Never
   hand-edit a `GameState` outside the engine.
2. **The engine never imports content JSON.** Callers resolve
   `src/content/*.json` into content-agnostic bundles (`UnitContent`,
   `AchievementContent`, `BoardGenerationContent`, `TaleContent`) via
   `src/content/resolveContent.ts` and pass them in as explicit params. Every
   one defaults to an `EMPTY_*` constant so callers that don't need content
   aren't forced to supply it. Keep this pattern for any new content.
3. **Event sourcing.** `GameState.actionHistory` is append-only and never
   pruned or reordered. Current state = genesis (`buildGenesisState`,
   `src/lib/gameGenesis.ts`, a deterministic function of the `games` row +
   seated `players`) replayed through `replayActions`
   (`src/engine/replay.ts`). Undo/redo are themselves logged actions folded
   in by `resolveHistory` (`src/engine/historyFold.ts`) — not a client-local
   stack. Anything that makes replay non-deterministic (randomness, clock
   reads, ambient state) is a bug.
4. **One submitted action → exactly one `actionHistory` entry.** `applyAction`
   internally converges any *forced* single-option follow-up (a one-card
   hand's `CHOOSE_CARD`, a forced tile placement, an owed decline that
   exactly matches hand+discard) to a fixed point inside the same dispatch,
   folded into the same log entry. Don't reintroduce per-step entries or an
   "automatic" flag — see `RULE_ENFORCEMENT_PLAN.md` §4.2/§4.3 for the full
   history of why.

`GameState` is `src/engine/types.ts`; DB row shapes are
`src/lib/dbTypes.ts` — deliberately separate types, don't merge them.

## The two write paths

Per-game flag `games.settings.ruleEnforcementEnabled` selects which one a
game uses. It reads as `false` for any game predating it (`createGame()`
defaults it to `false` when omitted), but `CreateGamePage.tsx` ships the
checkbox **checked**, so games created through the UI are enforced unless
the creator opts out (issue #432; `RULE_ENFORCEMENT_PLAN.md` §10).
`GamePage.tsx`'s `submitAction` branches on it:

- **Client-trusted (every older game, and any game whose creator unticked
  the box):** the client runs
  `applyAction()` itself and writes `game_state` directly, with an
  optimistic-concurrency retry loop against the `version` column
  (`writeWithRetry`). State is stored as a plain JSON `GameState`.
- **Rule-enforced:** the client posts the raw `Action` to the
  `apply-action` / `undo-action` / `redo-action` Edge Functions. The server
  resolves the caller's seat from their JWT, rejects any action whose
  `playerId` isn't theirs, re-derives the state, and does its own
  compare-and-swap write. RLS forbids direct client writes for these games.
  State is stored gzip+base64 under `__gz`, with
  `status`/`roundPhase`/`turn`/`pendingPlayerIds`/`turnOrder`/`boardSetup`
  duplicated in plaintext so the `game_state_sync_meta` trigger can still
  project `game_state_meta` (`src/lib/gameStateCompression.ts`).

Read paths handle both encodings per-row via `decompressGameStateFromStorage`,
so no coordinated rollout is needed. Any change touching submission, undo, or
storage must work on **both** paths.

## Supabase / Edge Function gotchas

- **Edge Functions import `src/engine/`, `src/content/`, and `src/lib/`
  directly and unmodified** (`supabase/functions/_shared/gameEnforcement.ts`).
  There is no rule-logic duplication between client and server, and there
  must not be.
- **The Edge Runtime does not honor `sloppy-imports`.** Every relative import
  in the graph reachable from `supabase/functions/` must carry an explicit
  `.ts` extension, and JSON imports need `with { type: 'json' }`. Engine
  files in that graph (`applyAction.ts`, `undoRedo.ts`, `replay.ts`,
  `tales.ts`, …) use extensions; UI-only ones (`gameLog.ts`, `turnReview.ts`,
  `redaction.ts`, `unitValue.ts`, `index.ts`) don't. **If you add an import to
  a server-reachable file, use the `.ts` extension** — a missing one only
  fails at deploy time, not in CI.
- **`.github/workflows/deploy-supabase.yml` auto-deploys on push to `main`**
  when `supabase/migrations/**`, `supabase/functions/**`, or **`src/lib/**`**
  changes — it runs `supabase db push` and `supabase functions deploy`. A
  `src/lib` change is a backend change. A migration that would cut off the
  live app must not land alone.
- Migrations are numbered `NNNN_name.sql` and applied in lexicographic order
  (note `00051_` sorts between `0005_` and `0006_`). Migration history on the
  live project has drifted before; `audit-and-fix-migrations.yml` verifies
  each migration's actual effect against a real schema dump. Read its header
  comment before touching it — several "obvious" grep patterns there are
  wrong against real `pg_dump` output.
- Tables: `games`, `players`, `game_state`, `game_state_meta`, `profiles`,
  `push_subscriptions`, `map_pool` (`observers` was added then removed).
  Per-game config lives in the `games.settings` jsonb column rather than new
  columns — add pregame toggles there (`GameSettings` in `dbTypes.ts`), no
  migration needed.
- A local stack (`supabase start` / `db push` / `functions serve`,
  `supabase/config.toml`) needs Docker, which the sandbox doesn't have. The
  `@claude` GitHub Action runner does — it preinstalls the Supabase CLI and
  Deno for exactly this.

## Testing

- Vitest, jsdom environment, globals enabled, `@testing-library/react` +
  `jest-dom` (`src/test/setup.ts`, config lives in `vite.config.ts`).
- Engine tests are the backbone (`src/engine/__tests__/`) — pure, fast, and
  the right place to pin any rules change.
- `src/test/supabaseStack/` is an **in-process stack that behaves like
  production**: real `@supabase/supabase-js` clients over a patched `fetch`,
  the real Edge Function handlers, the migrations' RLS, the
  `game_state_sync_meta` trigger, `version` CAS, and gzip-at-rest. Only
  Postgres and the Deno runtime are doubles, so it runs on a plain Node CI
  runner with no Docker.
- **Regression-testing a real game is a drop-in:** save a game export into
  `src/test/fixtures/productionGames/<name>.json` (from GamePage's "Copy game
  export") plus an optional `.room.json` sidecar declaring final scores and
  winners. `productionGames.test.ts` globs the folder — no registration step.
  See that folder's README.
- Prefer adding a fixture or an engine test over a component test when a bug
  is reproducible at the rules level.
- `src/test/productionSmoke/` replays those same fixtures against the **live**
  project through the deployed Edge Functions (`npm run test:production`,
  `.github/workflows/production-smoke.yml`, after each Supabase deploy and
  nightly). It is deliberately unreachable from `npm run test`: vitest's
  default `include` matches `*.test.*`, and those files are `*.smoke.ts` under
  their own config. The runner itself is covered on every PR by
  `src/test/__tests__/productionSmokeRunner.test.ts`, which points it at the
  in-process stack. Read that folder's README before changing it — its
  isolation rules (private room, `play_mode: 'live'` so no notification can
  fire, delete the room *before* the throwaway users) are load-bearing.

## Code style

- No semicolons, single quotes, 2-space indent, trailing commas in multiline
  literals. Long lines are fine; there is no Prettier config — match the file
  you're in.
- Lint is **oxlint** with `react/rules-of-hooks` as an error. TypeScript is
  strict-ish via `tsconfig.app.json`: `noUnusedLocals`, `noUnusedParameters`,
  `erasableSyntaxOnly`, `verbatimModuleSyntax` (so `import type` is required
  for type-only imports), `noFallthroughCasesInSwitch`.
- Three TS projects build together: `tsconfig.app.json` (`src`, excluding the
  service worker), `tsconfig.node.json` (`vite.config.ts`),
  `tsconfig.sw.json` (`src/sw.ts`, WebWorker lib).
- **This codebase documents heavily in doc comments** — most modules open
  with a comment explaining not just what they do but which ruling or issue
  drove the design. When you change behavior these comments describe, update
  them in the same commit; they are the real design record.

## Documentation map

| File | What it is |
| --- | --- |
| `README.md` | Setup and operations: Supabase, Discord/Google OAuth, Discord + Web Push turn notifications, guest auth, hotseat, server-side rule enforcement, game-state export, and what is and isn't built. |
| `todo.md` | The de-facto changelog: 70 numbered entries, each a problem, its investigation, and what shipped. **Check here first when touching anything that looks like it has history.** |
| `PROJECT_PLAN.md` | Overall roadmap and open decisions. |
| `RULE_ENFORCEMENT_PLAN.md` | The server-authority design: enforcement model, forced-action semantics, `ruleEnforcementEnabled` rollout, phases. |
| `HIDDEN_INFORMATION_PLAN.md` | Redaction of simultaneous-phase secrets (`src/engine/redaction.ts`). |
| `VARIANTS_PLAN.md` | Guilds & Tales variants — 23 Tales designed, a handful implemented. |
| `UnitActions.md` | Per-unit-action implementation checklist + resolved rules questions. |
| `ELO_SYSTEM_PLAN.md` | Rating system design (not built). |
| `src/content/README.md` | **The most important single doc**: every content file's fields, the board-generation rules, achievements/VP, resources, and Tales, each cross-referenced to the engine module that implements it. |

## Working conventions

- Branch, commit, and push as instructed; don't open a PR unless asked.
- Keep changes minimal and in the style of the surrounding code.
- Tales/variant content is opt-in per game (`GameState.activeTaleIds`) and
  must stay inert for a base game — a game with no Tales active never reads
  `tales.json`.
- Settings that matter to a running game are copied onto `GameState` at
  genesis (`activeTaleIds`, `gameLength`) so a running game and its export
  stay self-contained; read them from `GameState`, not the `games` row.
