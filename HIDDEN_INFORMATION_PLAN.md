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

**Update (2026-09-08, phase 8): `get-game-state` is now a real read path —
for a `GameSettings.hiddenInformationEnabled` game.** `gameApi.ts`'s
`getGameStateRedacted()`/`subscribeToGameState(..., redacted: true)` call it
instead of reading `game_state` directly, gated on `GamePage.tsx`'s
`usesRedactedReads(game)` (`ruleEnforcementEnabled && hiddenInformationEnabled`,
never hotseat). For a game with the flag on, the paragraph below (written
2026-09-07, before this landed) is no longer accurate — a still-secret pick
genuinely never reaches an opponent's client, network tab included, per
`getGameState.test.ts`'s coverage against the real Edge Function. For every
other game — the flag off, unchecked, or unavailable (client-trusted games
have no server authority to redact from in the first place, per
`GameSettings.hiddenInformationEnabled`'s own doc comment) — the paragraph
below still describes exactly what happens: nothing changed for them.

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

The limitation above is exactly what phase 8 closes for a game that opts in
(`GameSettings.hiddenInformationEnabled`): its client fetches only the
redacted view, so an opponent's still-secret pick is never present in the
payload their browser received at all — client-side redaction there is
belt-and-suspenders on top of a real server-side guarantee, not the whole
guarantee. For any other game, this section's original point stands
unchanged: the client fetches the whole `game_state` row and hides part of
it locally, so client-side redaction is a UX guarantee only, not a security
one.

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
8. **Rewire `gameApi.ts`'s read path onto `get-game-state` — done
   (2026-09-08), landed opt-in rather than for every `ruleEnforcementEnabled`
   game.** This phase was scoped the same day (see the paragraph this
   replaces, kept below in spirit) as needing three things beyond a bare
   `getGameState()` swap: a way past `RedactedGameState` not being
   structurally the same type as `GameState`, a resolution for the §5.4/§8
   blocker found while scoping it (gameLog.ts/turnReview.ts replaying a
   masked `CHOOSE_CARD`/`MOVE_TO_DECLINE` entry — a `cardId: null` isn't a
   legal `Action` payload, and `replayActions` throws outright on one), and
   real browser verification this sandbox can't do. Here's how each landed:
   - **New opt-in flag, `GameSettings.hiddenInformationEnabled`** (only
     offered once `ruleEnforcementEnabled` is checked, and never for hotseat
     — see `CreateGamePage.tsx`), carried onto `GameState` at genesis like
     `activeTaleIds`/`gameLength`. `get-game-state` only actually calls
     `redactStateForPlayer` when this is on (and the caller isn't an admin
     or in a hotseat game) — every other caller, including every game that
     predates this flag, gets `revealedGameStateView(state)`: the exact same
     `RedactedGameState` *shape* with nothing masked, so gameApi.ts's
     `getGameStateRedacted` always gets one predictable shape back regardless
     of who's asking. This is also what made the blast radius safe to land
     without a live browser: `gameApi.ts`'s `getGameState()` (the raw-row
     read) is completely untouched, and `getGameStateRedacted()` /
     `subscribeToGameState(..., redacted: true)` are only ever called
     (`GamePage.tsx`'s `usesRedactedReads`) for a game with the flag on — so
     every pre-existing game, and every enforced game that doesn't opt in,
     reads exactly the code path it always has.
   - **The replay blocker resolved by truncation, not by teaching
     gameLog.ts/turnReview.ts about redaction.** `redaction.ts`'s new
     `unredactedPrefix(actionHistory)` drops a `RedactedLoggedAction[]`'s
     tail from its first masked entry onward — sound because a masked entry
     only ever exists for the *current*, still-unresolved simultaneous
     phase (`entry.turn === state.turn`, per `redactStateForPlayer`), and
     `CHOOSE_CARD`/`MOVE_TO_DECLINE` never themselves move VP/resources/the
     board, so nothing downstream of the cut is lost. `toClientGameState`
     (also `redaction.ts`) calls it once, at the network boundary, and
     collapses `RedactedChoice`/`declineCardIds` back into `GameState`'s own
     shapes (keeping a masked decline id as `null` in place rather than
     filtering it out, so pile length/order survive) — so `GamePage.tsx`
     stores a plain `GameState` exactly as before, and gameLog.ts,
     turnReview.ts, scoreHistory.ts, unitValue.ts, historyFold.ts and every
     `RoundView.tsx` render path needed **zero** changes; they simply never
     see a masked entry. `undoRedo.ts`'s own `replayActions` calls turned out
     not to be reachable here at all: `GamePage.tsx` already delegates
     Undo/Redo to the `undo-action`/`redo-action` Edge Functions for every
     `ruleEnforcementEnabled` game (server-side, real unredacted history),
     never running `applyUndoAction`/`applyRedoAction` against client state
     for one — so hiddenInformationEnabled (enforced-only by construction)
     never reaches that path.
   - **No RoundView.tsx changes needed, on inspection — not "deferred".**
     The "about five places" the 2026-09-08 scoping worried about turned out
     to already gate every *other* player's `chosenCardIdByPlayerId` read on
     `roundPhase === 'actions'` (the "Playing" indicator, the hand-hiding
     filter, a unit's `cardState: 'selected'`) — which is exactly the
     condition under which that phase has already resolved and nothing is
     masked. `declineCardIds`' two read sites (`kindsInZone` for another
     player's pile) already drop an unrecognized id rather than crash, so a
     masked `null` just under-counts a still-secret pile by omission until
     it resolves. `toClientGameState`'s own doc comment records this
     reasoning inline, including the one real trade-off: there's no distinct
     "chosen, not yet revealed" treatment for an opponent's live pick during
     `selectCards` itself, since collapsing `{chosen: true, cardId: null}`
     to `null` reads the same as "hasn't chosen yet" — nothing today renders
     that distinction anyway (RoundView only surfaces it once resolved), so
     this is a documented limitation, not a regression.
   - **Admin room-configuration panel** (`GamePage.tsx`, issue #453) now
     also reports "Hidden information: ON/OFF" alongside "Backend rule
     enforcement", off the same `usesRedactedReads(game)` check gameApi.ts
     uses to pick a read path.
   - Engine/Edge-Function-level coverage: `redaction.test.ts` (`revealedGameStateView`/
     `unredactedPrefix`/`toClientGameState`, including the round-trip and the
     decline-null-preserved-in-place cases) and `getGameState.test.ts`
     (the opt-in gating, the hotseat bypass, admin's now-uniformly-shaped
     response, and — directly regression-testing the blocker this phase was
     stuck on — a real redacted response run through `toClientGameState`
     then `buildGameLogFrom` without throwing). What's still open is real
     two-browser verification (phase 9 below) and, per the RoundView note
     above, an intentionally-unimplemented "chosen, hidden" UI treatment for
     opponents' live picks — currently invisible either way, so nothing
     regressed by leaving it for a later increment if it's ever wanted.
9. **End-to-end verification against a real two-browser Supabase
   session** — still outstanding. Phase 8's own automated coverage (the
   in-process `supabaseStack`) proves the *server's* response body never
   carries a still-secret `cardId` for a `hiddenInformationEnabled` game, and
   that the client-side collapse of that response doesn't crash — but not
   that the browser's own network stack (DevTools Network tab, a
   Realtime/Websocket frame, a service-worker cache) never independently
   surfaces it, nor that a reviewed-but-not-branched rewind never re-masks
   an already-revealed pick (§5.3's flicker, expected but unverified in a
   real UI). A game *without* the flag on is unaffected either way — it
   never calls `get-game-state` at all (§8), same as before this phase
   landed. This sandbox has no live Supabase project to test against, so
   this phase requires the maintainer's own environment, same limitation
   noted throughout `todo.md`. See `RULE_ENFORCEMENT_PLAN.md` §8 phase 9 for
   the companion verification of action authorization in the same session.

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
- **Edge Function level: done (2026-09-08, phase 8), via
  `getGameState.test.ts`** against `RULE_ENFORCEMENT_PLAN.md` §9's
  in-process stack (`src/test/supabaseStack/`) — real Edge Function
  handlers, RLS and the storage encoding, no Docker needed. Covers the
  opt-in gating (redacted only with both `ruleEnforcementEnabled` and
  `hiddenInformationEnabled` on), the hotseat bypass, admin's now-uniformly-
  RedactedChoice-shaped response (`revealedGameStateView`), and — the
  regression test for the blocker phase 8 was originally stuck on — a real
  redacted response run through `toClientGameState` then `gameLog.ts`'s
  `buildGameLogFrom` without throwing. What genuinely still needs a live
  project shrinks to §5.2's original Realtime concern (confirming no raw-row
  broadcast bypasses this function — already believed closed by issue #448's
  unrelated `game_state_meta` subscription swap, per §5.2's "Resolved
  (2026-09-08)" note, but never verified against a real socket) and phase 9's
  browser-network-tab check below. Maintainer verification is still needed
  post-merge for phase 9.
- **Regression:** the existing suite (1137 tests across 62 files, up from
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
- New from phase 8 (2026-09-08): a `RedactedChoice` of `{chosen: true,
  cardId: null}` (an opponent's live, still-secret pick) and `{chosen:
  false}` (hasn't picked) both collapse to the same `null` through
  `toClientGameState`, since nothing in `RoundView.tsx` currently
  distinguishes them (see §8 phase 8's landing note). A future "show that
  someone's picked, without showing what" UI treatment during `selectCards`
  itself would need to consume `RedactedChoice` directly instead of calling
  `toClientGameState` — not needed today since nothing renders that signal.

(See `RULE_ENFORCEMENT_PLAN.md` §10 for enforcement-specific open items:
`RETRACT_CHOICE`/`RETRACT_DECLINE` design decisions, Edge Function
cold-start risk, and the admin/owner carve-out landing sequence.)
