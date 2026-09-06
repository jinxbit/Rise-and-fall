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

Originally scoped here as a plain SQL/plpgsql `SECURITY DEFINER` Postgres
RPC, `get_game_state(game_id)` — "the masking logic is field-nulling, not
game rules, so it doesn't need to live in an Edge Function." **Superseded,
2026-09-06 (see §5.3/§10): implemented as `get-game-state`, an Edge
Function instead**, once §5.3's reveal high-water mark (which needed a full
engine replay, not field-nulling) was dropped — at that point reusing
`redactStateForPlayer()` unmodified from an Edge Function was strictly
simpler than re-deriving its logic in SQL, so the "doesn't need to live in
an Edge Function" framing no longer carried its own conclusion. It loads
the authoritative row and calls the equivalent logic server-side either
way — the paragraphs below (Realtime broadcast leaking `actionHistory`,
`game_state_meta`) are unaffected by which mechanism does the loading.

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

**Dropped (per jinxbit, issue #450, 2026-09-06).** This entire subsection
turned out to be the one thing standing between phase 5 (§8/§10) and
shipping: `get_game_state` couldn't be plain field-nulling (§5.2's framing)
while still needing `computeRevealedPhaseMarks`' full engine replay to
compute this mark, and jinxbit explicitly offered to drop the mark if it
"complicates things." It does, so it's gone: `computeRevealedPhaseMarks`/
`revealMarkKey` (`historyPointer.ts`) and `redactStateForPlayerAtPointer`
(`redaction.ts`) are deleted (they were already dead code in production —
only their own tests exercised them, per `todo.md`'s "unused in production"
note — so this was a pure deletion, no call site to migrate). `redactStateForPlayer`
now always derives strictly from `state`'s own `roundPhase`/`pendingPlayerIds`,
same as before this subsection was ever proposed. The one behavior this
gives up: a review-only pointer rewind (no branch) back into an
already-resolved `selectCards`/`decline` phase re-masks it for the
duration of the rewind, flickering back to `chosen: true, cardId: null`
for a value the viewer's own client already rendered before rewinding.
Per the analysis earlier in this section, that's a flicker, not a leak —
nothing new reaches the network that wasn't already there — so this is a
cosmetic regression during history review, not a reopened privacy hole.

## 6. Data model changes

**Update (2026-09-04, phase 4, §8): `game_state_meta` — done**
(`0025_game_state_meta.sql`): phase/status/turn/version only, kept in sync by
a `security definer` trigger on every `game_state` insert/update (bypasses
RLS to write it, since clients have no direct grant on this table),
RLS-readable by the same audience `game_state` itself currently is
(`0021_remove_observers.sql`, `0024_admin_read_all_game_state.sql`), added to
the `supabase_realtime` publication. Landed ahead of the RLS lockdown it's
actually for (see `RULE_ENFORCEMENT_PLAN.md` §6), same "safe to land early,
deploys generically" reasoning `RULE_ENFORCEMENT_PLAN.md` §7's workflow used.

**Update (2026-09-06, issue #448):** no longer inert. `gameApi.ts`'s
`subscribeToGameState` now subscribes to `game_state_meta` instead of
`game_state` directly — Realtime broadcasts a changed row's full contents
over the websocket regardless of what actually changed, so subscribing to
the authoritative row meant pushing the entire `GameState` (routinely
~200kb, including the whole `actionHistory`) uncompressed on every move.
`game_state_meta`'s tiny broadcast is just the "something changed" signal;
the client then fetches the full state via the existing `getGameState` REST
call, which gets ordinary HTTP gzip compression the websocket never did.
This is only the read-side piece §5.2/(a) already described for phase 8 —
it doesn't touch `game_state`'s RLS, writes, or redaction, so `get_game_state`
(§5) and the write-side lockdown (`RULE_ENFORCEMENT_PLAN.md` §6/§8 phase 8)
are unaffected and still outstanding.

- ~~**New: reveal high-water mark (§5.3)**~~ — **turned out to be
  unnecessary as persisted state**, then **dropped entirely (2026-09-06,
  see §5.3)**. `computeRevealedPhaseMarks()` was already "deliberately a
  pure function of `history` rather than separately persisted, mutable
  state" (its own doc comment) — no column was ever needed — but it also
  turned out not to be needed *at all*: computing it requires replaying the
  *engine*, not just field-nulling, which was real tension with `get_game_state`'s
  "field-nulling, not game rules" characterization (§5.2) and the reason §10's
  SQL-vs-Edge-Function question stayed open. Resolved by removing the mark
  instead of resolving that tension the hard way.
- `game_state`'s RLS lockdown to service-role-only, and the removal of the
  `historyPointer`/archived-tail columns this document's prior draft also
  scoped here, live in `RULE_ENFORCEMENT_PLAN.md` §6 — they're enforcement
  concerns, not redaction ones.

## 7. Deploy automation

Shared with `RULE_ENFORCEMENT_PLAN.md` — see that document's §7 for the full
description of `.github/workflows/deploy-supabase.yml`. It deploys every
migration/Edge Function generically, so it covers this document's
`get-game-state` function (§5.2, no migration — it's an Edge Function, not a
SQL RPC) the same way it covers `apply-action`/`undo-action`/`redo-action`,
with no separate setup needed here.

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
5. **`get-game-state` Edge Function** (read-side redaction, §5.1–5.2) —
   **done (2026-09-06).** §10's open question (plain SQL/plpgsql RPC vs.
   Edge Function) is resolved in favor of the Edge Function, both because
   §5.3's reveal high-water mark (the thing forcing a full engine replay,
   the actual source of tension with a "plain SQL" RPC) was dropped the same
   day (§5.3), and because reusing `src/engine/`'s `redactStateForPlayer()`
   unmodified — no rule-logic duplication in SQL — was already §10's stated
   lean regardless. `supabase/functions/get-game-state/index.ts` mirrors
   `apply-action`/`undo-action`/`redo-action`'s shape: resolves the caller's
   seat via `_shared/gameEnforcement.ts`'s `loadGameContext()`, gates access
   with a new `canReadGameState()` (mirrors `game_state`'s current SELECT
   RLS policies — 0021/0024 — since a service-role Edge Function bypasses
   RLS entirely and has to reimplement that gate itself), returns the raw
   unredacted state for a `profiles.is_admin` caller only (§4.5's carve-out
   — **update (2026-09-06, per issue #450): narrowed from "room owner or
   admin" to admin-only.** The room owner is still just a player; there's no
   rules reason for them to see another player's still-secret pick just for
   having created the room. `isOwnerOrAdmin` (`gameEnforcement.ts`) stays
   broader and unchanged for the write-side act-as-any-player/history-
   override carve-out §4.4/§4.5 actually specs — `GameContext` now exposes
   `isAdmin` alongside it, and `get-game-state` checks the narrower one), and
   `redactStateForPlayer(state, callerPlayerId)` for everyone else: a seated
   player (including a room owner who's also seated) keyed to their own
   seat, anyone else entitled to read at all (§2: any signed-in user, once a
   game is non-lobby — including a non-seated room owner) keyed to `null`
   (`redactStateForPlayer`'s `viewerId` widened to `string | null` to match
   `redactGameLog`'s existing convention, so such a viewer sees everything
   currently secret from every player, same as `redactGameLog` already
   treats a `null` viewer). No migration needed — an Edge Function needs no
   DB schema change of its own, unlike the SQL-RPC framing §5.2 originally
   assumed. Verified: `src/engine/` unit tests (unaffected — this phase
   doesn't touch engine rules, only what's exposed by a new caller) and
   `deno check --node-modules-dir=auto` against all four Edge Functions
   (this one plus the three from `RULE_ENFORCEMENT_PLAN.md` phase 6, to
   confirm the shared-file edits didn't regress them). **Not done:**
   deploying and calling it against a live Supabase project, or `apply-action`-
   style local-stack smoke testing (`RULE_ENFORCEMENT_PLAN.md` §8 phase 6) —
   this sandbox has Deno but couldn't get an interactive `supabase
   start`/Docker session approved non-interactively; needs the maintainer's
   environment, same limitation §9 already flags for phases 5/8/9. Nothing
   calls this function yet (see phase 8 below) — landing it standalone first
   is deliberately low-risk, the same "additive and inert until wired up"
   shape `apply-action`/`undo-action`/`redo-action` shipped in.
7. **CI deploy workflow** — done, see `RULE_ENFORCEMENT_PLAN.md` §7; covers
   this document's `get-game-state` deploy too.
8. **Rewire `gameApi.ts`** and every call site (`GamePage.tsx`,
   `LobbyPage.tsx`, `RoundView.tsx`, `BoardSetupView.tsx`) from direct
   `game_state` reads onto `get-game-state` specifically (see
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
  `decline`) and confirming everything else passes through unchanged. (§5.3's
  review-rewind-flicker/branch-re-masking cases were removed along with the
  reveal high-water mark itself, 2026-09-06 — see §5.3.)
- **Edge Function level:** requires a live Supabase project — out of
  reach in this sandbox (no credentials/Docker; `deno check` against all
  four functions is as far as phase 5 could verify here, see §8), consistent
  with existing `todo.md` notes about board-setup/round-view verification.
  Maintainer verification needed post-merge for each of phases 5, 8–9: confirm
  `get-game-state` never leaks a secret field over the wire, including via
  Realtime broadcast of the raw row (§5.2).
- **Regression:** existing `src/engine/__tests__/` suite (220+ tests as of
  this writing) must continue passing unmodified — this work changes *what
  subset* of the engine's output a given viewer receives, not the engine's
  rules themselves.

(See `RULE_ENFORCEMENT_PLAN.md` §9 for authorization/undo-redo-specific
testing.)

## 10. Open items / risks

- ~~Exact storage shape for the reveal high-water mark (§5.3/§6)~~ / ~~SQL
  RPC vs. Edge Function tension for `get_game_state` (found while scoping
  phase 5, 2026-09-04)~~ — **resolved (2026-09-06): the reveal high-water
  mark (§5.3) is dropped entirely**, per jinxbit's offer on issue #450 to
  drop it if it complicated phase 5 — it did (computing it needs a full
  `applyAction()` replay, in tension with `get_game_state` being pure
  field-nulling), so `computeRevealedPhaseMarks()`/`redactStateForPlayerAtPointer()`
  are deleted rather than resolved around. That leaves plain §5.1 redaction,
  which needed no SQL-vs-Edge-Function decision to begin with once the
  replay requirement was gone — implemented as `get-game-state`, an Edge
  Function (option (b) below, which was already this document's stated
  lean): reuses `redactStateForPlayer()` unmodified, no rule-logic
  duplication in SQL. (Original options considered, for the record: (a) SQL
  RPC with non-sticky redaction only, deferring stickiness; (b) Edge
  Function reusing the engine directly, at the cost of one more Deno cold
  start per read — same "negligible for a turn-based game" expectation
  `RULE_ENFORCEMENT_PLAN.md` gives `apply-action`.)
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
