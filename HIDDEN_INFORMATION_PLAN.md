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

**Update (2026-09-08, phase 5 shipped): this section's original framing was
superseded — see §10 for the full story.** `get_game_state` was scoped below
as a plain SQL/plpgsql RPC on the theory that redaction is pure
field-nulling, not game rules. That held until §5.3's reveal high-water mark
needed a full engine replay to compute, which would have meant duplicating
`applyAction()` logic in SQL. §5.3 was dropped (2026-09-06, see that
section) specifically to avoid that duplication, which reopened the plain
field-nulling framing — but by then the decision had already landed the
other way: `get-game-state` shipped as a Deno/TS Edge Function
(`supabase/functions/get-game-state/index.ts`) reusing
`redactStateForPlayer()` unmodified, consistent with
`RULE_ENFORCEMENT_PLAN.md` §3's reuse-the-engine principle, rather than as a
Postgres RPC. The rest of this section (the original SQL-RPC framing below)
is left as the historical record of the initial design; it did not ship.

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

**Resolved (2026-09-08): both (a) and (b), as it turns out, not an
either/or.** (a) was already true by the time this mattered — issue #448
(bandwidth, unrelated to this document) had already moved
`subscribeToGameState` (`src/lib/gameApi.ts`) onto subscribing to
`game_state_meta` rather than `game_state` itself, so the raw row was never
actually broadcast over Realtime by the time phase 5 shipped. That leaves
(b) — a plain REST/RPC read of the raw row, not a Realtime broadcast — as
the one path this section's masking still needed to cover, and it now does:
`redactStateForPlayer()` masks `actionHistory`'s `CHOOSE_CARD`/
`MOVE_TO_DECLINE` entries' `cardId` under the same conditions as
`chosenCardIdByPlayerId`/`declineCardIds` above (see `redaction.ts`'s doc
comment, and phase 5's entry in §8 for when this landed).

### 5.3 Sticky reveal across undo — the reveal high-water mark

**Dropped (2026-09-06), per jinxbit's offer to simplify if it complicated
phase 5 — it did.** Computing the mark requires `computeRevealedPhaseMarks()`
to replay the *entire* history through `applyAction()` (see §10's account of
why that's in tension with `get_game_state` being simple field-nulling), and
with the mark gone, `redactStateForPlayer()` needs no `revealed` parameter
and reuses cleanly from `get-game-state` (§5.2, §8 phase 5) with no replay at
all. `computeRevealedPhaseMarks`/`revealMarkKey`/`redactStateForPlayerAtPointer`
are deleted (`src/engine/historyPointer.ts`, `src/engine/redaction.ts`) along
with their tests — they were dead code in production (only phase 3 built
them; nothing downstream ever called them, since phase 5 is what would have
called `redactStateForPlayerAtPointer`). The rest of this section is kept
below as the historical record of the design that was dropped.

**What this actually trades away:** a review-only pointer rewind (no
branch) back into an already-resolved `selectCards`/`decline` phase now
flickers back to masked for the duration of the rewind, instead of staying
revealed. Per this section's own §5.3 analysis, that's "a flicker, not a
leak" — the viewer's client already rendered the real value before the
rewind, and nothing new reaches the network. Acceptable given the
alternative (an engine replay inside a "just field-nulling" read function).

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

### 5.4 What actually runs today (client-side)

**Update (2026-09-08): phase 5's `get-game-state` Edge Function now exists
(`supabase/functions/get-game-state/index.ts`), but nothing calls it yet.**
`gameApi.ts`'s `getGameState()` still reads the raw `game_state` row
directly for every caller — the rewire onto `get-game-state` is
`RULE_ENFORCEMENT_PLAN.md` §8 phase 8, a separate, larger step. Until that
lands, the paragraph below (written 2026-09-07, before phase 5) still
accurately describes what's actually reachable over the network: this
section's own point stands unchanged — client-side redaction is a UX
guarantee, not a security one, until phase 8 makes `get-game-state` the
only read path.

**Update (2026-09-07).** §5.2's server-side read path doesn't exist yet
(phase 5), but redaction is not sitting unused in the meantime — it is
applied client-side, which hides secrets in the *UI* without keeping them
off the wire:

- `redactGameLog(events, state, viewerId)` (`src/engine/redaction.ts`)
  masks a narration line for a still-secret `CHOOSE_CARD` — every
  `GameEvent` carries a `secret.redactedMessage` alternative — and reveals
  it automatically once that round's `selectCards` phase resolves.
  `GamePage.tsx`'s `visibleGameLog` applies it against whichever state the
  log is sourced from, the live game or the state being reviewed, so
  scrubbing history doesn't leak either.
- **Neither the room owner nor a site admin gets a free pass** (issue
  #456): both see the same redacted log as any other player. The one
  bypass is the admin-only "Cheat mode" toggle (issue #430), which must be
  switched on deliberately and isn't persisted.

The limitation is exactly the one phase 5 exists to close, and it is worth
being blunt about: the client fetches the whole `game_state` row and hides
part of it locally, so an opponent's still-secret pick **is** present in
the payload their browser received. Client-side redaction is a UX
guarantee, not a security one.

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

- ~~**New: reveal high-water mark (§5.3)**~~ — **dropped outright
  (2026-09-06)**, not just simplified. It was already "deliberately a pure
  function of `history` rather than separately persisted, mutable state"
  (its own doc comment) — no column was ever needed regardless — but
  computing it still requires replaying the *engine* on every read, not
  just field-nulling, which was in tension with `get_game_state`'s "just
  field-nulling" framing enough that it was simplest to drop it rather than
  resolve that tension. See §5.3 and §10 for the full story; no data-model
  change resulted either way.
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
   **Later dropped in full (2026-09-06) — see §5.3.**
4. **DB migration** — **`game_state_meta` done** (§6,
   `0025_game_state_meta.sql`). Nothing else needed on this document's side
   of phase 4 (the reveal high-water mark needed no column — §6 above).
5. **`get-game-state` read path (§5.1–5.2) — done (2026-09-08).** The §10
   open question resolved in favor of an Edge Function
   (`supabase/functions/get-game-state/index.ts`), not a SQL RPC, once §5.3
   was dropped, removing the tension that question was about: no replay
   needed, so it's a straight reuse of `redactStateForPlayer()` against the
   live state. Gates access with `canReadGameState()`
   (`supabase/functions/_shared/gameEnforcement.ts`), mirroring
   `game_state`'s current RLS SELECT policies since the service-role client
   bypasses RLS entirely. Returns the raw, unredacted state only for
   `profiles.is_admin` callers (§4.5's carve-out) — **not** the room owner,
   per jinxbit's 2026-09-06 follow-up on issue #450: creating a room is not
   a reason to see another player's still-secret pick. Everyone else
   (seated players, and any other visitor `canReadGameState` admits) gets
   `redactStateForPlayer` keyed to their own seat (or no seat, for a
   non-player visitor). Nothing calls this function yet — see phase 8.
   **`actionHistory` redaction added (2026-09-08).** §5.2's remaining gap —
   `redactStateForPlayer` masked `chosenCardIdByPlayerId`/`declineCardIds`
   but shipped the raw `actionHistory` log unmodified, which carries the
   exact same secret `cardId` inside each still-secret `CHOOSE_CARD`/
   `MOVE_TO_DECLINE` entry's own payload — closed the same way: those two
   action types' `cardId` is nulled under the identical conditions (see
   `redaction.ts`'s doc comment and its new `RedactedLoggedAction` type).
   Landed as its own engine-only, server-side-only change — safe to merge
   ahead of phase 8 the same way `get-game-state` itself was, since nothing
   consumes it yet. Deliberately does **not** make `RedactedGameState`
   replayable through `applyAction()`/`replayActions()` — a masked entry's
   `cardId: null` isn't a legal action payload, so this is a display-only
   log for a viewer not yet entitled to the real one; genesis + replay
   always uses the real, unredacted `game_state` row server-side.
7. **CI deploy workflow** — done, see `RULE_ENFORCEMENT_PLAN.md` §7; covers
   this document's `get-game-state` deploy too (`supabase functions deploy`
   with no arguments deploys every function under `supabase/functions/`
   generically, so the new function needed no separate wiring there).
8. **Rewire `gameApi.ts`** and every call site (`GamePage.tsx`,
   `LobbyPage.tsx`, `RoundView.tsx`, `BoardSetupView.tsx`) from direct
   `game_state` reads onto `get_game_state` specifically (see
   `RULE_ENFORCEMENT_PLAN.md` §8 phase 8 for the write-side
   `apply-action`/`undo-action`/`redo-action` half). Keep the engine bundled
   client-side for optimistic UI (legal-move highlighting, immediate
   feedback) but never treat its output as authoritative — always reconcile
   against the server's redacted response.
   **Scoped in more detail (2026-09-08), while looking for the next
   concrete step to implement: this is a larger change than "swap
   `gameApi.ts`'s `getGameState()` implementation."** `RedactedGameState`
   (`redaction.ts`) is not structurally the same type as `GameState` —
   `chosenCardIdByPlayerId` becomes `Record<string, RedactedChoice>` instead
   of `Record<string, string | null>`, `players[].declineCardIds` becomes
   `(string | null)[]`, and (per this phase's own note above)
   `actionHistory` becomes `RedactedLoggedAction[]`, non-replayable. Every
   consumer of these fields — `RoundView.tsx` reads
   `state.chosenCardIdByPlayerId[playerId]` and `player.declineCardIds`
   directly in about five places to decide what to render (hand contents,
   the "Playing" indicator, the decline buy-back list) — currently assumes
   the real, un-redacted shape. Wiring a rule-enforced game's `gameState`
   onto the redacted read therefore isn't just an API/data-plumbing change:
   it needs new UI logic for rendering an opponent's masked pick (a
   `{chosen: true, cardId: null}` needs its own "chose a card, not yet
   revealed" treatment distinct from the real card art), a client-side type
   distinction between a live enforced game's `RedactedGameState` and every
   other game's plain `GameState`, and — being a rendering change — real
   browser verification (golden path *and* the masked-pick edge case)
   before it can be called done, which no sandbox environment used for this
   issue so far has been able to do (see phase 9 below). Also still true
   from this phase's original scoping: it must correctly bypass redaction
   for hotseat (`GameState.play_mode === 'hotseat'`, or actually the
   `games` row's `play_mode`) regardless of `ruleEnforcementEnabled`, since
   hotseat's one shared `auth.uid()` across every local seat (§2) makes
   `get-game-state`'s per-seat masking actively wrong there — it would hide
   a local player's own pick from the very device they're using to make it.

   **Blocking issue found while attempting this phase (2026-09-08, resuming
   on issue #473): the client cannot simply start reading
   `RedactedGameState.actionHistory` as if it were `GameState.actionHistory`
   — five existing call sites replay `actionHistory` through
   `applyAction()`/`applyActionWithSteps()`/`replayActions()` client-side,
   and every one of them assumes every logged action is a legally-replayable
   payload. A masked `CHOOSE_CARD`/`MOVE_TO_DECLINE` entry's `cardId: null`
   fails that replay (`applyChooseCard` rejects it at
   `applyAction.ts:417`'s `player.handCardIds.includes(cardId)` check, the
   `MOVE_TO_DECLINE` handler analogously), and this was never exercised
   before because the client has only ever replayed its own, fully-real
   `actionHistory` — nothing has fed it a redacted one until phase 8 tries
   to. Traced each call site rather than assuming:
   - `gameLog.ts`'s `extendGameLog` (line 292) calls `applyActionWithSteps`,
     which returns `{ok: false}` on the masked entry; `extendGameLog`
     already has a defensive bail for exactly that shape of failure (line
     293, `if (!result.ok) return {..., ok: false}`, written for "a
     validly-logged action should never fail to reapply") — so it wouldn't
     throw, but it would silently stop narrating the *live* game log from
     that entry onward, for as long as the phase stays open. That's every
     round, not an edge case.
   - `turnReview.ts`'s `buildTurnReview` (line 525) has the identical
     defensive bail (`break`, line 526) for an ordinary entry — but its
     separate UNDO_ACTION/REDO_ACTION branch (line 500) calls
     `replayActions()` directly, which **throws** on any rejected entry
     (`replay.ts:59-61`, by design — it also backs the event-sourcing
     correctness guarantee CLAUDE.md's invariant 3 describes, so it can't
     just be made lenient without losing that guarantee for its other,
     legitimate caller). A review window spanning an earlier undo/redo and
     a currently-masked entry would throw uncaught.
   - `undoRedo.ts`'s `applyUndoAction`/`applyRedoAction` (lines 50, 67) both
     call `replayActions()` over the whole history from genesis — same
     throw. Only reachable for a **client-trusted** game today (a
     `ruleEnforcementEnabled` game's undo/redo already goes through the
     `undo-action`/`redo-action` Edge Functions instead, per
     `GamePage.tsx`'s branch around lines 1188/1238) — which matters,
     see below.
   - `scoreHistory.ts`/`unitValue.ts` also replay the full history through
     `applyAction()`, but checked their only call sites (`GamePage.tsx`
     lines 970-999) and both are guarded on `gameState.status ===
     'completed'` — a completed game can't have an unresolved
     `selectCards`/`decline` phase, so these two are **not** actually at
     risk. Recording that so a future pass doesn't have to re-derive it.
   - `historyPointer.ts`'s `stateAtPointer`/`applyActionAtPointer` have the
     identical throw risk, but are unused in production (the §4.4
     pointer-move design they were built for was superseded by the
     append-only `resolveHistory`/`applyUndoAction` model, todo.md #70) —
     not an active bug, just a landmine if they're ever revived.

   Separately, but compounding this: `apply-action`/`undo-action`/
   `redo-action` (`supabase/functions/*/index.ts`) return `result.state`
   **unredacted** today — the real state `applyActionFullyEnforced` computed
   server-side, including any opponent's still-secret pick, which
   `GamePage.tsx`'s `runEnforced` (lines 1035-1043) sets straight into local
   state. That leaks exactly what `get-game-state`'s read path exists to
   stop leaking, and needs the same `redactStateForPlayer(result.state,
   callerPlayerId)` treatment — independently worth fixing, and lower-risk
   *for the write path itself* (the caller's next apply-action call
   re-derives from the server's own real DB row, never the client's cached
   copy) — but it feeds the client the exact same masked `actionHistory` the
   read path would, so it doesn't sidestep the replay hazard above; it's the
   same problem from the other door (and, in a 3+-player game, reachable
   *without* even touching the read path: the second-to-last player's own
   apply-action response can already come back with an earlier player's pick
   masked).

   **Recommendation, not yet decided:** (a) `gameLog.ts`/`turnReview.ts`'s
   ordinary-entry path already degrades instead of throwing — it would need
   to stop treating that as "should never happen" and instead resume once a
   later, unmasked refetch arrives, and the two `replayActions()`-throws
   (`turnReview.ts`'s undo/redo branch, `undoRedo.ts`) need a distinct,
   explicitly-lenient replay entry point rather than a flag on the one used
   for authoritative reconstruction. (b) Once `gameLog.ts` can produce its
   own "hidden" line directly from `cardId: null`, `redactGameLog`/
   `GameEvent.secret` (`redaction.ts` lines 136-165, `types.ts:309-321`)
   become redundant — the server already redacted per-viewer — and could be
   deleted as a simplification, not a requirement. (c) `undoRedo.ts`'s
   throw only matters for client-trusted games, which raises a scoping
   question §2 never separated: a client-trusted game's *write* path already
   trusts the client with the real state (`writeGameState`), so redacting
   only its *reads* is the same asymmetry §5.4 already flagged as "a UX
   guarantee, not a security one" — recommend scoping phase 8's read rewire
   to `ruleEnforcementEnabled` games only, leaving client-trusted games on
   today's direct (unredacted) read, which also removes `undoRedo.ts` from
   the list of call sites needing (a)'s tolerance, since it never runs for
   enforced games.

   Not fixed this session — flagging as blocking rather than shipping a
   rewire that would regress the live game log (and, in some cases, throw)
   every round a simultaneous phase is genuinely open, which is not a rare
   condition.
9. **End-to-end verification against a real two-browser Supabase
   session**, inspecting actual network payloads (not just UI rendering)
   to confirm secret fields never reach an opponent's client during the
   `selectCards`/`decline` windows — today they still do, since redaction
   runs client-side and the client fetches the whole row, and that a reviewed-but-not-branched
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
- **Edge Function/RPC level:** still the gap, but for a narrower reason than
  when this was written. `RULE_ENFORCEMENT_PLAN.md` §9's in-process stack
  (`src/test/supabaseStack/`) now exercises real Edge Function handlers,
  RLS and the storage encoding on every pull request with no Docker, so
  "requires a live Supabase project" no longer holds for the *write* path.
  It doesn't help this document yet only because phase 5's `get_game_state`
  doesn't exist — once it does, it can be tested there the same way, and
  what genuinely needs a live project shrinks to §5.2's Realtime concern:
  confirming the raw row broadcast to subscribers doesn't carry secrets the
  RPC strips. Maintainer verification is still needed post-merge for
  phases 5 and 8-9.
- **Regression:** the existing suite (1118 tests across 61 files, up from
  the 220+ this section was written against) must continue passing
  unmodified — this work changes *what subset* of the engine's output a
  given viewer receives, not the engine's rules themselves.

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
- **New (2026-09-08): phase 8's client rewire is blocked on a client-side
  replay hazard, not just the UI/type work §8 already scoped.** See phase
  8's own entry above for the full trace — five call sites
  (`gameLog.ts`, `turnReview.ts`, `undoRedo.ts`, plus two confirmed-safe
  ones) replay `actionHistory` through `applyAction()`/`replayActions()`
  client-side and were never built to tolerate a masked entry, which a
  redacted read/response now hands them every round a simultaneous phase is
  genuinely open. Needs the (a)/(b)/(c) recommendation there decided (or a
  better alternative) before `gameApi.ts`'s read path can safely be rewired
  onto `get-game-state` — attempting the rewire without resolving this
  first would regress the live game log (and sometimes throw) in ordinary
  play, not just in a corner case.

(See `RULE_ENFORCEMENT_PLAN.md` §10 for enforcement-specific open items:
`RETRACT_CHOICE`/`RETRACT_DECLINE` design decisions, Edge Function
cold-start risk, and the admin/owner carve-out landing sequence.)
