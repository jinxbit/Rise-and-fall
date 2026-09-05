# Hidden Information — Spec, Design & Execution Plan

Tracks [issue #37](https://github.com/jinxbit/Rise-and-fall/issues/37). This is
the living source of truth for the **hidden information** half of that issue —
update it as decisions change, the same way `PROJECT_PLAN.md` tracks the rest
of the project.

This document was split out of `BACKEND_ENFORCEMENT_SPEC.md` (per
[issue #423](https://github.com/jinxbit/Rise-and-fall/issues/423)) to separate
the hidden-information concern from the rule-enforcement concern — the two
were related but distinct problems (see §1) tangled together in one file.
**Section numbers are preserved from the original combined document**, so
existing code comments/tests that cite a section number by itself (without a
filename) still resolve correctly here; sections that moved to the companion
document are marked below rather than renumbered, so a bare "§4.4" elsewhere
in the codebase unambiguously means
[`RULE_ENFORCEMENT_PLAN.md`](RULE_ENFORCEMENT_PLAN.md) (§1 problem statement,
§3 architecture decision, §4 enforcement model, and the enforcement-specific
parts of §6/§7/§8/§9/§10 live there instead).

[Issue #407](https://github.com/jinxbit/Rise-and-fall/issues/407) refined the
reveal semantics below (§5.3) after this document already existed — that
section carries that refinement's rationale inline rather than being restated
as a separate proposal.

## 1. Problem statement

`applyAction()` (`src/engine/applyAction.ts`) is pure, dependency-free
TypeScript that runs **entirely client-side** today, and the full `GameState`
JSON blob is written straight into the `game_state` table
(`writeGameState()` in `src/lib/gameApi.ts`). Row Level Security
(`supabase/migrations/0001_init_schema.sql`, tightened by later migrations
such as `0019_public_game_state_visible.sql`) only gates access at **row**
granularity — "any seated player (or, for public rooms, any signed-in
visitor) may read the whole state row" — with no server-side concept of
per-viewer redaction.

Issue #37 is two related but distinct problems. This document covers the
second:

2. **Hidden information** — during the brief window where a choice is
   simultaneous and unresolved, don't let opponents' clients receive the
   secret data at all (not just "the UI doesn't render it" — today the
   browser network tab / a modified client can already see it).

The first — **rule enforcement** (stop trusting client-submitted state;
validate every action server-side; reject actions a player isn't entitled to
submit) — is covered by
[`RULE_ENFORCEMENT_PLAN.md`](RULE_ENFORCEMENT_PLAN.md).

## 2. Scope, confirmed

Resolved through discussion on the issue (2026-08-13 through 2026-08-15) —
this covers scope for both halves of issue #37, not just this document:

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
  `0004_hotseat_skip_pass_gate.sql`), so per-seat hiding doesn't apply
  there — the existing "pass the device" courtesy gate remains the only
  privacy boundary for hotseat, unchanged. (See
  `RULE_ENFORCEMENT_PLAN.md`'s Scope section for hotseat's enforcement-side
  implication.)
- **Live and async modes are in scope.**

### Non-goals

- No forever-hidden information of any kind (no fog of war, no secret
  hands).
- No change to hotseat's trust model.
- No new persistent-connection infrastructure (WebSocket server) — Supabase
  Realtime's existing "something changed, refetch" signal pattern is
  sufficient for a turn-based game.

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

### 5.3 Sticky reveal across undo — the reveal high-water mark

[Issue #407](https://github.com/jinxbit/Rise-and-fall/issues/407) proposed
moving hidden fields into a dedicated column that's cleared into the public
state transactionally on reveal, specifically so that "once information is
revealed, it stays revealed, even if undo was used to go back to previous
phases/rounds." Discussion on the issue concluded that literally relocating
data isn't necessary — §5.1's field-masking (`redactStateForPlayer`) stays
the mechanism — but the *stickiness* requirement is real and §5.1 as
written doesn't provide it, since `hideChosenCards`/`declineAdditionsThisPhase`
are derived fresh from `state.roundPhase`/`pendingPlayerIds` at whatever
point `stateAtPointer` replayed to. That's a genuine gap, confirmed against
`stateAtPointer` (`src/engine/historyPointer.ts:34`): rewinding the pointer
back into an already-resolved `selectCards`/`decline` phase — with **no
branch**, purely to review an earlier moment — reconstructs a state where
that phase's picks are still pending, and `redactStateForPlayer` masks them
again for a viewer whose client already rendered the real values before the
rewind. Re-masking already-seen data is a flicker, not a leak, but it's a
real inconsistency the issue is right to want closed.

**Decision (per jinxbit, 2026-09-03): approved as a deliberate break from
pure-replay determinism.** Redaction for a given simultaneous phase is no
longer solely a function of `stateAtPointer(pointer).roundPhase`/
`pendingPlayerIds`. A separate **reveal high-water mark** is introduced —
persisted per phase instance (keyed by `turn` + phase, since a round has at
most one `selectCards` and one `decline` phase, matching the original
issue's point 5: never more than one such window open, and never more than
one such mark relevant, at a time):

- **Set** when that phase actually resolves on the live tip (the
  `pendingPlayerIds.length === 0` transition genuinely happens, e.g.
  `beginActionsPhase`, `src/engine/round.ts:35`) — independent of wherever
  `historyPointer` sits afterward.
- **Consulted instead of the replayed phase state** when redacting a read
  at any pointer position that still lies within the *same, unpruned*
  history: a plain undo/redo that only moves the pointer, without
  submitting a new action, never touches this mark, so a phase already
  revealed stays unmasked through review-only rewinds. No flicker.
- **Deleted** — per jinxbit's explicit answer to this document's prior open
  question — exactly when a branch (`RULE_ENFORCEMENT_PLAN.md` §4.4:
  submitting a new action at `pointer < tip`) prunes away the action that
  produced that resolution. This is the same tail-prune already computed
  for `branchDiscardsAnotherPlayersAction`/`archivedTail`
  (`src/engine/historyPointer.ts:95`,`107`) — no separate detection pass:
  if the resolving transition falls inside `archivedTail`, its mark goes
  with it. This is what makes `RULE_ENFORCEMENT_PLAN.md` §4.4's "branch
  after reveal forces the other players to reselect" hold *for redaction
  too*, not just for `pendingPlayerIds`: once the mark is gone,
  `redactStateForPlayer` goes back to deriving strictly from the (now
  genuinely-unresolved) replayed state, so their old picks are masked again
  exactly as if that phase had never resolved — because, per this rule, for
  redaction purposes it didn't.

Net effect: "revealed" is now a small piece of persisted, monotonic-until-
branched state, not a pure function of the pointer — deliberately, to match
real epistemic reality (a client that already saw a value doesn't un-know
it just because someone is reviewing history), while still resetting
cleanly the moment that revelation's own causal history is actually
discarded.

## 6. Data model changes

**Update (2026-09-04, phase 4, §8): `game_state_meta` — done**
(`0025_game_state_meta.sql`): phase/status/turn/version only, kept in sync by
a `security definer` trigger on every `game_state` insert/update (bypasses
RLS to write it, since clients have no direct grant on this table),
RLS-readable by the same audience `game_state` itself currently is
(`0021_remove_observers.sql`, `0024_admin_read_all_game_state.sql`), added to
the `supabase_realtime` publication. Landed ahead of the RLS lockdown it's
actually for (see `RULE_ENFORCEMENT_PLAN.md` §6), same "safe to land early,
deploys generically" reasoning `RULE_ENFORCEMENT_PLAN.md` §7's workflow used
— it's inert (nothing reads it) until phase 8 subscribes to it instead of
`game_state` directly.

- ~~**New: reveal high-water mark (§5.3)**~~ — **turned out to be
  unnecessary as persisted state.** `computeRevealedPhaseMarks()`
  (`src/engine/historyPointer.ts`) is already "deliberately a pure function
  of `history` rather than separately persisted, mutable state" (its own
  doc comment) — a mark can't outlive the resolving entry that produced it,
  since it's recomputed from `actionHistory` on every call. §10 has an open
  item on what this means for `get_game_state`'s implementation, though:
  computing it requires replaying the *engine*, not just field-nulling,
  which is more than the "field-nulling, not game rules" characterization
  §5.2 gives `get_game_state` accounted for.
- `game_state`'s RLS lockdown to service-role-only, and the removal of the
  `historyPointer`/archived-tail columns this document's prior draft also
  scoped here, live in `RULE_ENFORCEMENT_PLAN.md` §6 — they're enforcement
  concerns, not redaction ones.

## 7. Deploy automation

Shared with `RULE_ENFORCEMENT_PLAN.md` — see that document's §7 for the full
description of `.github/workflows/deploy-supabase.yml`. It deploys every
migration/Edge Function generically, so it covers this document's
`get_game_state` migration/function the same way it covers
`apply-action`/`undo-action`/`redo-action`, with no separate setup needed
here.

## 8. Execution plan (phased)

Each phase should land as its own PR/commit set; later phases depend on
earlier ones being merged. Phase numbers are shared with
[`RULE_ENFORCEMENT_PLAN.md`](RULE_ENFORCEMENT_PLAN.md#8-execution-plan-phased)
— it's one execution timeline covering both documents; phases not relevant
to hidden information (6) are omitted here.

1. **These documents.** Record scope/design decisions (done — this file and
   `RULE_ENFORCEMENT_PLAN.md`, split from the original combined
   `BACKEND_ENFORCEMENT_SPEC.md` per issue #423).
2. **`redactStateForPlayer()` + exhaustive unit tests** in `src/engine/`
   (done — `src/engine/redaction.ts`, `src/engine/__tests__/redaction.test.ts`).
   No behavior change to production code paths yet — purely additive and
   independently testable, same pattern as the rest of `src/engine/__tests__/`.
3. **§5.3's reveal high-water mark** settled and implemented, engine-side
   only (done, alongside `RULE_ENFORCEMENT_PLAN.md`'s `historyPointer`
   model in the same phase — see that document's §8 phase 3 for the
   `RETRACT_CHOICE`/`RETRACT_DECLINE` half of this phase):
   `computeRevealedPhaseMarks()` (`historyPointer.ts`) — deliberately *not*
   separately persisted/mutable state, since it's a pure function of the tip
   `actionHistory` (replay it once, record every `(turn, roundPhase)` whose
   `pendingPlayerIds` hit zero); "deleted on branch" falls out for free
   because a pruned resolving entry just isn't in the new tip anymore, no
   explicit delete step needed. `redactStateForPlayerAtPointer()`
   (`redaction.ts`) is the pointer-aware entry point that consults it.
4. **DB migration** — **`game_state_meta` done** (§6,
   `0025_game_state_meta.sql`). Nothing else needed on this document's side
   of phase 4 (the reveal high-water mark needed no column — §6 above).
5. **`get_game_state` SQL RPC** (read-side redaction, §5.1–5.2) + migration
   — **open design question first, see §10:** §5.3's reveal high-water mark
   needs a full engine replay (`computeRevealedPhaseMarks()`), not the plain
   field-nulling §5.2 originally scoped this RPC as, which is a real tension
   with implementing it as plain SQL/plpgsql instead of an Edge Function.
7. **CI deploy workflow** — done, see `RULE_ENFORCEMENT_PLAN.md` §7; covers
   this document's `get_game_state` deploy too.
8. **Rewire `gameApi.ts`** and every call site (`GamePage.tsx`,
   `LobbyPage.tsx`, `RoundView.tsx`, `BoardSetupView.tsx`) from direct
   `game_state` reads onto `get_game_state` specifically (see
   `RULE_ENFORCEMENT_PLAN.md` §8 phase 8 for the write-side
   `apply-action`/`undo-action`/`redo-action` half). Keep the engine bundled
   client-side for optimistic UI (legal-move highlighting, immediate
   feedback) but never treat its output as authoritative — always reconcile
   against the server's redacted response.
9. **End-to-end verification against a real two-browser Supabase
   session**, inspecting actual network payloads (not just UI rendering)
   to confirm secret fields never reach an opponent's client during the
   `selectCards`/`decline` windows, and that a reviewed-but-not-branched
   rewind never re-masks an already-revealed pick (§5.3). This sandbox has
   no live Supabase project to test against, so this phase requires the
   maintainer's own environment, same limitation noted throughout `todo.md`.
   See `RULE_ENFORCEMENT_PLAN.md` §8 phase 9 for the companion verification
   of action authorization in the same session.

## 9. Testing strategy

- **Engine-level (this sandbox can run these):** `redactStateForPlayer()`
  unit tests covering both hidden windows (mid-`selectCards`, mid-
  `decline`) and confirming everything else passes through unchanged; §5.3
  refinement cases specifically — a plain review-only pointer rewind into
  an already-resolved phase does not re-mask it (no flicker); a branch that
  prunes a phase's resolving action deletes that phase's reveal high-water
  mark so redaction re-masks it, consistent with
  `RULE_ENFORCEMENT_PLAN.md` §4.4's owner-override gate covering that same
  branch.
- **Edge Function/RPC level:** requires a live Supabase project — out of
  reach in this sandbox (no credentials/Docker), consistent with existing
  `todo.md` notes about board-setup/round-view verification. Maintainer
  verification needed post-merge for each of phases 5, 8–9: confirm
  `get_game_state` never leaks a secret field over the wire, including via
  Realtime broadcast of the raw row (§5.2).
- **Regression:** existing `src/engine/__tests__/` suite (220+ tests as of
  this writing) must continue passing unmodified — this work changes *what
  subset* of the engine's output a given viewer receives, not the engine's
  rules themselves.

(See `RULE_ENFORCEMENT_PLAN.md` §9 for authorization/undo-redo-specific
testing.)

## 10. Open items / risks

- Exact storage shape for the reveal high-water mark (§5.3/§6) — **engine
  side (phase 3, §8) needs no storage at all** (unchanged from before):
  `computeRevealedPhaseMarks()` derives it on demand from the tip
  `actionHistory`. **New tension found while scoping phase 5 (2026-09-04):**
  §5.2 characterizes `get_game_state` as pure "field-nulling, not game
  rules," implementable as a plain SQL/plpgsql `SECURITY DEFINER` RPC — but
  `computeRevealedPhaseMarks()` isn't field-nulling, it's a full replay of
  every logged action through `applyAction()` (the actual rules engine) to
  find which simultaneous phases resolved. Reimplementing that in SQL would
  duplicate rule logic outside `src/engine/` — exactly what
  `RULE_ENFORCEMENT_PLAN.md` §3 chose Edge Functions to avoid in the first
  place. Two ways to resolve this, needs a decision before phase 5 is
  implemented:
  a. `get_game_state` does §5.1's plain (non-sticky) redaction only, in SQL,
     as originally scoped, and §5.3's stickiness either waits for a later
     increment or is computed a different way (e.g. cached alongside
     `game_state` by whichever Edge Function call last resolved a phase,
     rather than recomputed per read); or
  b. `get_game_state` is actually implemented as an Edge Function (Deno/TS,
     reusing `src/engine/`'s `computeRevealedPhaseMarks()`/
     `redactStateForPlayerAtPointer()` unmodified) despite the "Postgres
     RPC" framing in §5.2 — consistent with
     `RULE_ENFORCEMENT_PLAN.md` §3's reuse-the-engine rationale, at the cost
     of one more Deno cold start per state read (mitigated by that
     document's own "negligible for a turn-based game" expectation, same as
     `apply-action`).
  (b) is closer to this document's own stated principles (reuse
  `src/engine/` unmodified, no rule-logic duplication) and is the current
  lean, but this needs an explicit decision, not an assumption, before
  phase 5 starts.
- ~~Whether a pruned, abandoned branch that already crossed a reveal
  transition leaves that information revealed forever~~ — **resolved**: no,
  per jinxbit's 2026-09-03 answer, the reveal high-water mark is deleted
  when the branch that produced it is pruned (§5.3), so a discarded branch
  never leaves a permanent leak.
- Whether `game_state_meta` subsumes or coexists with the public-room
  status-visibility fix in `0019_public_game_state_visible.sql` — likely
  subsumes it, but the migration needs to preserve that bug's fix (public
  rooms' `status` must stay visible to non-participants) once redaction
  lands.

(See `RULE_ENFORCEMENT_PLAN.md` §10 for enforcement-specific open items:
`RETRACT_CHOICE`/`RETRACT_DECLINE` design decisions, Edge Function
cold-start risk, and the admin/owner carve-out landing sequence.)
