# Backend Rule Enforcement & Information Hiding — Spec, Design & Execution Plan

Tracks [issue #37](https://github.com/jinxbit/Rise-and-fall/issues/37). This is
the living source of truth for this work — update it as decisions change,
the same way `PROJECT_PLAN.md` tracks the rest of the project. It supersedes
the plan text scattered across the issue's comment history; that history is
the design rationale, this file is the current state of the plan.

## 1. Problem statement

`applyAction()` (`src/engine/applyAction.ts`) is pure, dependency-free
TypeScript that runs **entirely client-side** today. Whichever browser takes
an action computes the next `GameState` itself and writes the full JSON blob
straight into the `game_state` table (`writeGameState()` in
`src/lib/gameApi.ts`). Row Level Security
(`supabase/migrations/0001_init_schema.sql`, tightened by later migrations
such as `0019_public_game_state_visible.sql`) only gates access at **row**
granularity — "any seated player (or, for public rooms, any signed-in
visitor) may read the whole state row" — with no server-side check that a
submitted state is actually the legal result of a legal action. Nothing
stops a client from fabricating an illegal state, or from submitting an
action attributed to a seat it doesn't own, and writing it directly.

This issue is two related but distinct problems:

1. **Rule enforcement** — stop trusting client-submitted state; validate
   every action server-side against the existing engine, and reject actions
   a player isn't entitled to submit (e.g. someone else's move).
2. **Hidden information** — during the brief window where a choice is
   simultaneous and unresolved, don't let opponents' clients receive the
   secret data at all (not just "the UI doesn't render it" — today the
   browser network tab / a modified client can already see it).

## 2. Scope, confirmed

Resolved through discussion on the issue (2026-08-13 through 2026-08-15):

- **Hands, discard piles, decline piles, and the board are all public,
  always.** There is no hidden information by rule outside of one
  transient window.
- **The only hidden information is:**
  - A player's in-progress pick during the current `selectCards` phase —
    `chosenCardIdByPlayerId` (`src/engine/types.ts:321`) — while any player
    is still pending. Once every player has chosen, choices resolve into
    `currentlyPlayed` and become public, exactly as today.
  - Cards moved to decline **during the currently in-progress `decline`
    phase**, before that phase resolves. Once resolved, decline piles are
    public like everything else (players can already see prior rounds'
    decline piles; only *this round's still-in-progress* additions are
    secret).
- **Board setup (tile/unit placement) is fully public by design** — no fog
  of war on the board itself. Out of scope.
- **Hotseat is explicitly out of scope.** All local hotseat players share
  one `auth.uid()` (see `supabase/migrations/0003_hotseat_local_players.sql`,
  `0004_hotseat_skip_pass_gate.sql`), so per-seat enforcement and hiding
  don't apply there — the existing "pass the device" courtesy gate remains
  the only privacy boundary for hotseat, unchanged, and hotseat's rule
  enforcement stays exactly as trusting as it is today.
- **Live and async modes are in scope.**

### Non-goals

- No forever-hidden information of any kind (no fog of war, no secret
  hands).
- No change to hotseat's trust model.
- No new persistent-connection infrastructure (WebSocket server) — Supabase
  Realtime's existing "something changed, refetch" signal pattern is
  sufficient for a turn-based game.

## 3. Architecture decision: Supabase Edge Functions

Considered building a standalone backend service (Fly.io/Render/Railway
Node, or folding into Vercel serverless functions) vs. Supabase Edge
Functions. **Decision: Supabase Edge Functions.**

Rationale (full pros/cons in the issue's 2026-08-15 comment): this is a
private, non-commercial app for a small friend group
(`README.md`: "Vercel (frontend) + Supabase free tier (backend)"), so the
deciding factor is ongoing maintenance surface for one maintainer, not raw
capability — a standalone service adds a whole new platform to provision,
secure, and pay for, for benefits (persistent connections, no Deno quirks)
that don't map to any actual requirement here. Edge Functions:

- Reuse `src/engine/`'s pure, dependency-free TypeScript **unmodified** —
  no rule-logic duplication between client and server.
- Get JWT verification and a service-role DB client for free, colocated
  with Postgres (no extra network hop).
- Match an existing precedent already in this repo
  (`supabase/functions/notify-discord-turn/index.ts`).
- Keep the stack at two platforms (Vercel + Supabase), both with existing
  auto-deploy-on-push precedent to extend (see §7).

This isn't a one-way door: because `src/engine/` has zero runtime
dependencies, everything below would port to a standalone Node server
without a rewrite if a future requirement Edge Functions genuinely can't
satisfy ever emerges (e.g. a real need for server push, or CPU limits
becoming a real constraint).

## 4. Enforcement model

### 4.1 Action authorization

`apply-action` rejects any action where `action.playerId !== callerSeat`
(the caller's seat, resolved server-side from their JWT via `players`).
This is currently missing entirely — **any** seated player can submit an
action naming any other seated player as `playerId`, today only gated by
"are you seated in this room," not "is this your move." This is the
concrete vulnerability this issue exists to close.

### 4.2 Automatic / forced actions — no special-casing needed

Two existing mechanisms stay as-is once the engine runs server-side, no new
authorization concept required:

- **Forced single-card choice**: today, `RoundView.tsx` auto-submits
  `CHOOSE_CARD` client-side when a player's hand has exactly one card. This
  is not one player acting for another — it's the *same* player's client
  skipping a click, still submitted under their own `playerId`/session.
  Under the enforced backend it's an ordinary `CHOOSE_CARD` where
  `action.playerId` legitimately equals the caller's seat.
- **Cascading eliminations** (`eliminatePlayersWithNoCardToDecline` and
  friends, `src/engine/elimination.ts`) aren't separately submitted actions
  at all — they're folded into phase transitions
  (`beginActionsPhase`/`beginPurchasePhase`/etc., `src/engine/round.ts`) as
  a pure consequence of whichever action closed out the previous phase,
  computed inside the one already-validated `applyAction()` call. Nothing
  to authenticate.

### 4.3 Server-side fast-forwarding of no-decision choices

Precedent already exists for "don't wait for a submission when there's only
one legal option": `applyActionAndFastForwardTiles()`
(`src/engine/applyAction.ts`) — during board setup, whenever
`findForcedPlacement()` shows a tier's remaining tiles have only one
possible arrangement, it keeps calling `applyAction()` automatically,
attributed to whoever's turn it actually is, using `trustedReplay: true` to
skip the redundant legality re-check since the forced-placement search
already proved it legal. Each fast-forwarded step still lands its own
ordinary `actionHistory` entry, so replay never has to re-derive anything.

This generalizes directly to `CHOOSE_CARD`: a new
`applyActionAndFastForwardChoices()` (mirroring the tile version) — while
`roundPhase === 'selectCards'`, for each still-pending player with exactly
one hand card, synthesize and apply
`{ type: 'CHOOSE_CARD', playerId, cardId: onlyCard }` through the same
trusted-replay path, looping while any pending player still has a forced
single card. `MOVE_TO_DECLINE` has the same shape of case (a pending player
whose hand+discard together exactly match what they still owe) and should
get the same treatment for symmetry.

This **must run inside `apply-action` server-side**, not left to each
client's own auto-submit effect as it is today — not primarily for
security (once §4.1 is enforced, a client can't forge this on another
player's behalf either way), but so the round doesn't stall waiting on a
client that's slow to, or never does, auto-submit the courtesy action.

### 4.4 Undo / Redo — pointer-based history, replacing the client-local redo stack

Today: `actionHistory` (`src/engine/types.ts`) is truncated in place by
`handleUndo()` (`src/pages/GamePage.tsx`), and the only record of what was
undone is a **client-local, unpersisted** `redoStack` state
(`src/pages/GamePage.tsx`) — `handleRedo()` resubmits that stored `Action`
object, `playerId` and all. Once §4.1 lands, that becomes a live
impersonation hole: nothing stops a client from calling the redo path with
a *fabricated* action claiming another player's `playerId`.

**Design (per jinxbit, 2026-08-14):** `actionHistory` becomes **immutable
and append-only**. A single shared `historyPointer` (an int, no
per-action attribution needed) tracks the current position:

- **Undo / Redo just move the pointer.** Non-destructive — nothing is ever
  lost, so this is safe to leave gated on "any seated player of this game,
  at any time," matching today's documented intent
  (`GamePage.tsx`'s existing Undo doc comment: "any player, at any time...
  deliberately not gated on `me`"). No payload; no per-action legality
  check applies to moving the pointer itself.
- **There is no separate "redo" endpoint that takes an action payload.**
  Redo is just advancing the pointer back toward the tip along the
  existing (never-deleted) history.
- **Submitting a new action while `pointer < tip` prunes the abandoned
  tail** — this is the one genuinely destructive operation, and it is
  authorized exactly like any other live action submission: normal
  `apply-action` validation (§4.1: `action.playerId === callerSeat`, plus
  ordinary legality) against the state replayed as of the pointer.
- **Owner override for cross-player pruning:** if branching would discard
  at least one action whose `playerId` differs from the caller's, require
  the room owner (`games.created_by`) to be the one submitting it. The
  common case — a player rewinds to re-decide only their own still-pending
  choice — needs no special permission. This is a small, checkable
  condition: walk `actionHistory[pointer+1..tip]` and compare `playerId`s.
  Archive the discarded tail rather than hard-deleting it, so even an
  owner override is recoverable.
- Client (`GamePage.tsx`): `redoStack` becomes a **UI-only hint** (whether
  to enable the Redo button, derived from `historyPointer < tip`), never
  the payload source for a network call.

## 5. Redaction

### 5.1 `redactStateForPlayer(state, viewerId)`

New pure function in `src/engine/`, unit-tested like the rest of the
engine (no behavior change to the engine's own logic — it's a read-side
view, not a rule):

- While `roundPhase === 'selectCards'` and any player is still pending:
  mask other players' `chosenCardIdByPlayerId` entries (return "chosen:
  true/false", not the card id, for anyone but the viewer).
- While `roundPhase === 'decline'`: mask `declineCardIds` **added during
  the current decline phase** for players other than the viewer. This
  needs a phase-start snapshot to distinguish "already-public pile from
  earlier rounds" from "this phase's still-secret additions" —
  `pendingPlayerIds` alone isn't sufficient, since a player can owe more
  than one decline card and only the still-unresolved ones are secret.
- Everything else passes through unchanged (hands, discard, board, prior
  rounds' decline piles, resources, VP, etc. are all public per §2).

### 5.2 Where redaction runs

The masking logic is field-nulling, not game rules, so it doesn't need to
live in an Edge Function. Read-side redaction runs as a
`SECURITY DEFINER` Postgres RPC, `get_game_state(game_id)`, deployed via an
ordinary SQL migration (same mechanism as the existing `supabase/migrations/`
files) — it loads the authoritative row and calls the equivalent logic
server-side.

**`actionHistory` must not be shipped wholesale to other players while
their entries are still secret.** Redacting the *current-state* read isn't
enough on its own: Realtime broadcasts row changes at row granularity, so
if a phase's in-progress `CHOOSE_CARD`/`MOVE_TO_DECLINE` entries sit in the
same row every seated player subscribes to, the live broadcast leaks them
regardless of what a redacted read returns. Once a phase resolves, its
entries are safe to include as-is. Two ways to satisfy this, to be decided
during implementation (§8, phase 3):
  a. keep the authoritative `game_state` row service-role-only (not
     Realtime-broadcast at all), with a slim public `game_state_meta` row
     (phase/version only) that Realtime broadcasts purely as a "something
     changed, refetch your redacted view via RPC" signal; or
  b. redact `actionHistory` itself at the RPC layer and rely on RLS to keep
     the raw row from ever reaching a `postgres_changes` subscription.

Given RLS already can't filter *within* a row for Realtime purposes, (a) is
the more robust choice and is the current recommendation — it also cleanly
subsumes `game_state_meta`'s existing purpose today (see
`0019_public_game_state_visible.sql`'s public-room read path, which reads
full state and would need reworking either way).

## 6. Data model changes

- **`game_state` (existing table):** stays the single authoritative row
  per game, but becomes **service-role write-only** — clients stop writing
  it directly (`writeGameState()` in `gameApi.ts` is replaced by
  `apply-action`/`undo-action`/`redo-action` invocations). Existing
  `version` column continues to back the compare-and-swap Edge Functions
  use internally.
- **New: `game_state_meta` (or equivalent slim public projection):**
  phase/status/version/turn only, still Realtime-broadcastable to every
  seated player and public-room visitor per existing RLS patterns
  (`0011_room_visibility.sql`, `0019_public_game_state_visible.sql`) — used
  purely to trigger a client refetch of its own redacted view.
- **New: `historyPointer`** — one int per game (a column on `game_state`
  or a new one-row-per-game table), moved by `undo`/`redo`, read by
  `apply-action`/`get_game_state` to know where "current" is.
- **Archived/pruned tail:** discarded `actionHistory` entries from a
  branch (§4.4) are archived, not deleted — likely a side table
  (`action_history_archive` or similar) rather than mutating the
  authoritative log, exact shape TBD in phase 4 (§8).
- **RLS:** `game_state`'s existing "seated players / observers / public
  visitors can read" policies (`0001_init_schema.sql`,
  `0010_observers.sql`, `0019_public_game_state_visible.sql`) get replaced
  by policies restricting direct table access to service role only, with
  reads going through `get_game_state` instead. `game_state_meta` gets the
  equivalent-to-today read policies (same audience as current
  `game_state` reads).

## 7. Deploy automation

Both existing Supabase artifacts in this repo are deployed manually today:
migrations (`README.md`: "run manually in the Supabase SQL editor") and the
one existing Edge Function, `notify-discord-turn`
(`README.md`: `supabase functions deploy notify-discord-turn`, run by
hand). `ci.yml` only lints/tests/builds the frontend — there's no Supabase
deploy step, unlike Vercel which already auto-deploys on push.

**Plan:** a GitHub Actions job using the Supabase CLI
(`supabase/setup-cli` action), triggered on push to `main` when
`supabase/**` changes, running `supabase db push` for migrations and
`supabase functions deploy apply-action undo-action redo-action
notify-discord-turn` for functions, authenticated via
`SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_REF` repo secrets — same shape as
Vercel's existing auto-deploy. This also fixes the pre-existing manual-
deploy friction for `notify-discord-turn`.

**Caveat:** Claude's GitHub App permissions exclude editing
`.github/workflows/*`, so this step needs to be added by a human with
workflow-edit rights once the functions/RPC below exist (§8, phase 7).

## 8. Execution plan (phased)

Each phase should land as its own PR/commit set; later phases depend on
earlier ones being merged.

1. **This document.** Record scope/design decisions (done — this file).
2. **`redactStateForPlayer()` + exhaustive unit tests** in `src/engine/`.
   No behavior change to production code paths yet — purely additive and
   independently testable, same pattern as the rest of `src/engine/__tests__/`.
3. **`historyPointer` model**: engine-side support for an immutable
   `actionHistory` + pointer (replay from pointer instead of always from
   tip; branch = prune-and-append), with unit tests. Still no network/DB
   change — this is engine logic first, wiring second.
4. **DB migration**: `game_state_meta` (or chosen equivalent), archived-
   tail storage, `historyPointer` column, and updated RLS locking
   `game_state` to service-role-only.
5. **`get_game_state` SQL RPC** (read-side redaction, §5.1–5.2) + migration.
6. **`apply-action` / `undo-action` / `redo-action` Edge Functions**,
   reusing the engine as-is: seat resolution from JWT, `action.playerId`
   enforcement (§4.1), fast-forwarding (§4.3), pointer-based undo/redo
   with owner-override pruning (§4.4), version compare-and-swap on write.
7. **CI deploy workflow** (§7) — needs a human with workflow-edit rights.
8. **Rewire `gameApi.ts`** and every call site (`GamePage.tsx`,
   `LobbyPage.tsx`, `RoundView.tsx`, `BoardSetupView.tsx`) from direct
   `game_state` reads/writes onto `get_game_state`/`apply-action`/
   `undo-action`/`redo-action`. Keep the engine bundled client-side for
   optimistic UI (legal-move highlighting, immediate feedback) but never
   treat its output as authoritative — always reconcile against the
   server's redacted response.
9. **End-to-end verification against a real two-browser Supabase
   session**, inspecting actual network payloads (not just UI rendering)
   to confirm secret fields never reach an opponent's client during the
   `selectCards`/`decline` windows. This sandbox has no live Supabase
   project to test against, so this phase requires the maintainer's own
   environment, same limitation noted throughout `todo.md`.

## 9. Testing strategy

- **Engine-level (this sandbox can run these):** `redactStateForPlayer()`
  unit tests covering both hidden windows (mid-`selectCards`, mid-
  `decline`) and confirming everything else passes through unchanged;
  pointer-based undo/redo/branch unit tests including the owner-override
  condition; fast-forward tests for forced single-choice `CHOOSE_CARD`/
  `MOVE_TO_DECLINE`.
- **Edge Function level:** requires a live Supabase project — out of reach
  in this sandbox (no credentials/Docker), consistent with existing
  `todo.md` notes about board-setup/round-view verification. Maintainer
  verification needed post-merge for each of phases 6–9.
- **Regression:** existing `src/engine/__tests__/` suite (220+ tests as of
  this writing) must continue passing unmodified — this work changes *who*
  calls the engine and *what subset* of its output a given viewer receives,
  not the engine's rules themselves.

## 10. Open items / risks

- Exact storage shape for the archived branch-pruning tail (§6) — side
  table vs. JSON array column — to be settled in phase 4.
- Whether `game_state_meta` subsumes or coexists with the public-room
  status-visibility fix in `0019_public_game_state_visible.sql` — likely
  subsumes it, but the migration needs to preserve that bug's fix (public
  rooms' `status` must stay visible to non-participants) once redaction
  lands.
- Edge Function cold-start/latency impact on perceived responsiveness in
  live mode — expected to be negligible for a turn-based game, but worth
  confirming during phase 9 verification.
