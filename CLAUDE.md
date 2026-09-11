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
npm run test:smoke   # smoke-test a LIVE Supabase project (needs SMOKE_* env vars)
npm run lint         # oxlint (not eslint) — sub-second
npm run build        # tsc -b (3 projects) + vite build — ~10s
```

CI (`.github/workflows/ci.yml`) runs `lint`, `test`, `build` in that order on
every PR. Run all three before pushing; they are fast enough that there is no
excuse to skip them.

A green CI run on a PR can merge it: `automerge.yml` merges into `main`
without waiting for the maintainer, but only for a PR that is not a draft, is
based on `main`, has its head on a `claude/` branch **in this repository**,
carries the `automerge` label, touches no `supabase/migrations/**`, and is
still at the commit CI passed on. A migration always gets a human read
(`DELIVERY_PIPELINE_PLAN.md` §7). The PR itself is opened by
`claude-branch-pr.yml` when `claude.yml` pushes a `claude/issue-**` branch —
the action only posts a "Create PR" link, so without this a finished branch
sits unmerged — and that workflow applies the label, which is what makes the
issue-to-pre-production loop run unattended. Issues enter that loop through
`claude-queue.yml`: label an issue `queued` and it is started — `priority`
first, then lowest number, **one at a time** — as soon as the label lands if
nothing is in flight, otherwise when the previous one closes.
`priority` reorders the queue; it never interrupts an issue already running. An issue that needs a
decision holds the queue on purpose, which is what the `in-progress` label on
a stalled issue means — but an `in-progress` issue with no branch and no open
PR after 90 minutes is treated as a start that never happened and is
requeued, so a run that dies before Claude begins cannot hold the queue
forever. The issue is closed by `automerge.yml` when its PR
merges — not by the PR body's `Closes #N`, which comes from a `push`-triggered
workflow and so can be written by a stale copy of itself on an older branch. Both that workflow and `smoke.yml`'s
failure reporting need the `AUTOMATION_TOKEN` secret, because GitHub does not
start workflow runs from events its own `GITHUB_TOKEN` caused — without it a
merge would reach `main` without triggering CI or the Supabase deploy, so
`automerge.yml` declines to merge at all.

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
defaults it to `false` when omitted). `CreateGamePage.tsx` no longer offers a
checkbox for it at all (issue #552, superseding issue #432's checked-by-
default checkbox; `RULE_ENFORCEMENT_PLAN.md` §10) — it always passes `true`,
so every game created through the UI is enforced, with no creator opt-out.
The client-trusted path itself isn't removed: it's still what every
pre-#552 game runs on, and still what `createGame()` gives any other caller
that omits the flag (tests included).

`games.settings.hiddenInformationEnabled` (only meaningful alongside rule
enforcement) follows the same split: `createGame()` still defaults it to
`false` when omitted — that's the contract for every caller that doesn't
pass it, tests and pre-existing games included — but `CreateGamePage.tsx`
also no longer offers a checkbox for this (issue #552, superseding issue
#481's checked-by-default checkbox): since rule enforcement is now always on
too, it always passes `hiddenInformationAvailable`, so a game created
through the UI hides in-progress picks unless it's hotseat, where hiding is
never offered or submitted (`src/lib/hiddenInformationEligibility.ts`;
`HIDDEN_INFORMATION_PLAN.md`). This changes new games only — no existing
game's stored settings change.

`GamePage.tsx`'s `submitAction` branches on it:

- **Client-trusted (every older game):** the client runs
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

The same split now starts at genesis, not just at the first action.
`LobbyPage.tsx`'s Start Game (`gameApi.ts`'s `startGameFromLobby()`) branches
on `ruleEnforcementEnabled` too: client-trusted still builds
`buildGenesisState()` locally and inserts `game_state` directly, unchanged;
rule-enforced instead posts `{ gameId }` to the `start-game` Edge Function,
which re-fetches the roster itself, builds the same genesis server-side, and
does the authoritative insert plus the `games.status` flip to `'active'`
under a service-role client. `0029_start_game_edge_function.sql` blocks a
direct client from doing either write (the `game_state` INSERT, and the
`games` `'lobby' -> 'active'` transition) once a game is enforced — the
latter lives in the `enforce_game_status_transition` trigger rather than a
plain RLS policy, since the rule needs both the row's old and new status in
one check. See `RULE_ENFORCEMENT_PLAN.md` §10 (2026-09-11 update, issue
#519) for why this closed a real bug, not just a theoretical gap.

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
- **`main` is pre-production, not production.** `.github/workflows/deploy-supabase.yml`
  deploys to the **Preview** Supabase project on push to `main`, and to
  production on push to the `production` branch — which is only ever
  fast-forwarded to a commit `main` already carries, by the `Promote to
  production` workflow (`promote.yml`), which checks the commit is on `main`,
  that CI is green on it and that pre-production is not red, then waits for an
  approval on the `production-release` environment before pushing. Vercel mirrors the same
  split. It fires when `supabase/migrations/**`, `supabase/functions/**`, or
  **`src/lib/**`** changes, running `supabase db push` and `supabase functions
  deploy`. A `src/lib` change is a backend change. A migration that would cut
  off the live app must not land alone. See `DELIVERY_PIPELINE_PLAN.md` §3 for
  why the topology is this way round, and §4 for the environments.
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
  project through the deployed Edge Functions (`npm run test:smoke`,
  `.github/workflows/smoke.yml`, after each Supabase deploy and
  nightly; which project it tests comes from the deploy's own `deploy-target`
  artifact, and a failure files an issue carrying a redacted tail of the run —
  mentioning `@claude` for Preview, not for production). It is deliberately
  unreachable from `npm run test`: vitest's
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
| `DELIVERY_PIPELINE_PLAN.md` | How a change reaches production: the pre-production environment, branch topology, what auto-merges and what never does (design agreed, not built). |
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
