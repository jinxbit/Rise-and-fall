# Backend Rule Enforcement & Information Hiding — Spec, Design & Execution Plan

Tracks [issue #37](https://github.com/jinxbit/Rise-and-fall/issues/37). This is
the living source of truth for this work — update it as decisions change,
the same way `PROJECT_PLAN.md` tracks the rest of the project. It supersedes
the plan text scattered across the issue's comment history; that history is
the design rationale, this file is the current state of the plan.

[Issue #407](https://github.com/jinxbit/Rise-and-fall/issues/407) refined the
undo/redo and reveal semantics below (§4.4, §5.3) after this document
already existed — those sections carry that refinement's rationale inline
rather than being restated as a separate proposal.

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
  (`supabase/functions/notify-discord-turn/index.ts`, and since,
  `supabase/functions/notify-web-push/index.ts`).
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

**Update (issue #412, 2026-09-04):** the "today" paragraph immediately below
is now historical — `handleUndo()`/`handleRedo()` (`src/pages/GamePage.tsx`)
no longer truncate `actionHistory` or keep a client-local `redoStack`.
`UNDO_ACTION`/`REDO_ACTION` are real logged entries now, appended to
`actionHistory` like any other action (`UndoAction`/`RedoAction`,
`src/engine/actions.ts`); `src/engine/historyFold.ts`'s `resolveHistory()`
folds them back into "what's actually in effect" (the substantive prefix
`GameState` is derived from) by maintaining the exact same pointer this
section specs — it's just derived from the log itself on every read instead
of living in a separate persisted `historyPointer` column. That happens to
satisfy this section's two central asks (append-only history; no
separate redo-payload endpoint) **without needing schema/RLS changes at
all**, so it shipped now rather than waiting on phase 6 — but it's still
entirely client-trusted (no §4.1 enforcement exists yet, same caveat as
everything else pre-phase-6), it doesn't yet implement the
owner-override/cross-player-pruning authorization below (a rewind that
prunes another player's action is unrestricted, exactly as destructive
today as before this change), and RETRACT_CHOICE/§5.3's simultaneous-phase
refinement below is unaffected (already implemented separately, see phase
3 in §8). Whether phase 6 still wants its own persisted `historyPointer`
column (e.g. for a server-side authorization check that doesn't want to
refold the whole log on every request) or can just reuse `resolveHistory`
against the same `actionHistory` it already reads is an open question for
that phase, not resolved here.

Today (pre-#412, kept for the design rationale below): `actionHistory`
(`src/engine/types.ts`) was truncated in place by `handleUndo()`
(`src/pages/GamePage.tsx`), and the only record of what was undone was a
**client-local, unpersisted** `redoStack` state (`src/pages/GamePage.tsx`)
— `handleRedo()` resubmitted that stored `Action` object, `playerId` and
all. Once §4.1 lands, that would have become a live impersonation hole:
nothing stops a client from calling the redo path with a *fabricated*
action claiming another player's `playerId` — issue #412's append-only
redesign closes that specific hole today (redo has no payload at all
anymore) even ahead of §4.1's own enforcement.

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

**Refinement (per jinxbit, issue #407, 2026-09-03): a plain pointer
decrement is the wrong model while a simultaneous phase
(`selectCards`/`decline`, §2) is still open.** `chosenCardIdByPlayerId`
entries for different players interleave in `actionHistory` in submission
order, not turn order — they're independent, commuting writes (each
`CHOOSE_CARD`/`MOVE_TO_DECLINE` only ever touches the acting player's own
slot). If player A submits, then player B submits, A calling "undo" must
not silently undo B's still-secret pick just because B's entry happens to
sit at the tip. Concretely:

- **While the caller has an unresolved pick of their own in the
  currently-open phase** (they're not in `pendingPlayerIds` for this phase,
  and the phase hasn't resolved), "undo" retracts **only that entry** —
  implemented as a new compensating action (e.g. `RETRACT_CHOICE`), not a
  pointer move, so it's a normal `apply-action` submission authorized like
  any other (§4.1: `action.playerId === callerSeat`) and requires no
  owner-override (it only ever discards the caller's own entry). It puts
  the caller back in `pendingPlayerIds` and leaves every other player's
  pending entry — visible or still-secret — untouched, appended after it in
  the (still append-only) log.
- **Redo, in this state, is just submitting `CHOOSE_CARD` again** — no
  special endpoint, consistent with the no-redo-payload rule above.
  Because the retraction didn't touch other players' entries, this can
  never "void the other player's selection."
- **Once the caller has nothing left of their own to retract in the open
  phase, the next undo falls back to ordinary shared-pointer semantics** —
  it walks the pointer back across the phase boundary into the previous,
  already-resolved phase, exactly as §4.4's original model describes.
- **If information has already been revealed** (the phase resolved — every
  player chose, `pendingPlayerIds` emptied and the round advanced) **and a
  later ordinary pointer-rewind undo goes back into that resolved phase**,
  submitting a different `CHOOSE_CARD` there is an ordinary
  submit-while-`pointer < tip` branch (the existing rule above): the pruned
  tail necessarily includes every other player's now-revealed pick for that
  phase and the transition that resolved it, so `branchDiscardsAnotherPlayersAction`
  is true and the **existing owner-override gate already covers this case**
  — no new authorization concept needed. The practical effect the issue
  asked for — "selecting a new card should force the other players to
  reselect" — falls out for free: since their `CHOOSE_CARD` entries are
  gone from the pruned history, replaying from the pointer naturally shows
  them back in `pendingPlayerIds`, owing a fresh pick. See §5.3 for the one
  piece this doesn't give for free: keeping their *already-revealed* pick
  from flickering back to secret for a client that saw it, right up until
  someone actually branches.

### 4.5 Admin / room-owner privileges (issue #391)

Two distinct asks, tracked separately because they land on different sides
of the trust boundary this document is about:

- **"Take a turn for another player."** Already safe under *today's* fully
  client-trusted model (no §4.1 enforcement exists yet, so nothing
  server-side distinguishes who submitted an action anyway) — implemented
  directly in `GamePage.tsx` without waiting on the rest of this plan. An
  "Admin mode" toggle, gated on `isCreator || isAdmin` (reusing
  `games.created_by` and `profiles.is_admin`, the same checks `canDelete`
  already uses) and excluded for hotseat (which already has this property
  by construction — one shared device cycles `me` through every seat via
  `pendingActorId`, see below). While enabled, `me` — the single identity
  every submitted action's `playerId` and every panel's interactivity gate
  (`myPlayerId` throughout `RoundView`/`BoardSetupView`) already derives
  from — follows `pendingActorId` (`engine/turnOrder.ts`'s `currentActorId`)
  instead of the signed-in user's own seat, exactly mirroring the mechanism
  hotseat already uses to let one device act as a rotating cast of players.
  No changes needed to any action panel. **Once §4.1 lands**, `apply-action`
  must carve out the equivalent server-side: allow `action.playerId !==
  callerSeat` when the caller is the room owner or `profiles.is_admin`,
  checked from the DB, not trusted from the client — otherwise this feature
  silently breaks (or, if naively left as a client-only bypass, becomes a
  real impersonation hole) the moment enforcement ships.
- **"Redo with overwrite" — force a stale redo through, discarding
  whatever else happened since the undo.** Deliberately *not* implemented
  as a hack on top of today's `redoStack`/in-place-truncation model: today,
  undoing already permanently truncates `actionHistory`, so a subsequent
  redo is "resubmit this stored action against whatever the current tip
  now is," and if another player acted in between there's no record of
  where the undone branch actually forked from — reconstructing "overwrite"
  correctly would mean silently discarding a real player's move with no
  archive and no way to tell, from the log alone, that it happened. That's
  exactly the failure mode §4.4's pointer-based history + tail-archiving
  exists to prevent. This capability is the owner-override case §4.4
  already specs ("if branching would discard at least one action whose
  `playerId` differs from the caller's, require the room owner...") —
  **this issue additionally asks to extend that same override to
  `profiles.is_admin`, not just `games.created_by`** — implement it there,
  as part of §4.4's `apply-action`/pointer work (phase 6, §8), not before.
  The `redoStack` UI already becomes a courtesy hint at that point (§4.4),
  so admin mode's "force it through" is just: submit the branching action
  through the normal owner-override path with the admin flag instead of
  (or in addition to) the ownership check.

**Hidden-information interaction:** today, admin mode changes nothing here
either — there's no redaction yet (§5), so admin already sees exactly what
every other player's client already receives (the known gap issue #37
exists to close). Once §5's `get_game_state` redaction ships, admin mode
needs an explicit carve-out there too: a viewer who is the room owner or
`profiles.is_admin` should receive the **unredacted** state (skip the
`selectCards`/`decline` masking in §5.1) so that acting on another
player's still-secret in-progress choice via admin mode actually works —
otherwise admin mode would let them click a card-choice button whose
contents they can't see. This is a deliberate, logged-as-"admin mode"
trust boundary (the room owner and any site admin can already see/do
almost everything else in this app), not an oversight — call it out
explicitly in the `get_game_state` implementation (§8 phase 5) so it isn't
missed.

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
  question — exactly when a branch (§4.4: submitting a new action at
  `pointer < tip`) prunes away the action that produced that resolution.
  This is the same tail-prune already computed for
  `branchDiscardsAnotherPlayersAction`/`archivedTail`
  (`src/engine/historyPointer.ts:95`,`107`) — no separate detection pass:
  if the resolving transition falls inside `archivedTail`, its mark goes
  with it. This is what makes §4.4's "branch after reveal forces the other
  players to reselect" hold *for redaction too*, not just for
  `pendingPlayerIds`: once the mark is gone, `redactStateForPlayer` goes
  back to deriving strictly from the (now genuinely-unresolved) replayed
  state, so their old picks are masked again exactly as if that phase had
  never resolved — because, per this rule, for redaction purposes it
  didn't.

Net effect: "revealed" is now a small piece of persisted, monotonic-until-
branched state, not a pure function of the pointer — deliberately, to match
real epistemic reality (a client that already saw a value doesn't un-know
it just because someone is reviewing history), while still resetting
cleanly the moment that revelation's own causal history is actually
discarded.

**Bug found and fixed while scoping phase 5 (2026-09-04):**
`computeRevealedPhaseMarks()` (`src/engine/historyPointer.ts`) walked
`resolveHistory(history).effective` — but `.effective` is truncated to
wherever the pointer currently sits, and issue #412's real, shipped undo
mechanism (`applyUndoAction`, `src/engine/undoRedo.ts` — a plain
`UNDO_ACTION` logged into `actionHistory` itself, see §4.4's update above)
is exactly "move the pointer back." A scratch reproduction confirmed this
concretely: after a real `applyUndoAction()` rolled a resolved `selectCards`
phase back to "still pending," walking `.effective` found **no mark at
all** — the exact flicker bug #407/§5.3 exist to prevent, silently
reintroduced for the one undo path players actually use (the explicit-
pointer test coverage this document's phase-3 checklist already had never
exercised this, since it drives `applyActionAtPointer`, a separate,
not-yet-wired-up pointer model — see below).
`resolveHistory`'s `ResolvedHistory` (`src/engine/historyFold.ts`) now also
exposes `substantive`: every substantive action still reachable, which a
plain undo/redo never shrinks (only an actual branch — a new substantive
action submitted behind the tip — does, via the same `substantive.length =
pointer` truncation `.effective` was already computed from).
`computeRevealedPhaseMarks()` now walks `.substantive` instead, which is
identical to `.effective` whenever `history` has no undo/redo entries (so
every existing test kept passing unmodified) and strictly fixes the case
where it does. Two new regression tests in `redaction.test.ts` exercise the
real `applyUndoAction()` path directly (not just `applyActionAtPointer`):
one confirms the mark now survives a genuine undo, one confirms it's still
correctly cleared once a genuine subsequent branch (an ordinary new action
submitted after undoing past the resolution) prunes it for real.

**A second, separate thing this surfaced:** `historyPointer.ts`'s
explicit-integer-pointer API (`stateAtPointer`, `applyActionAtPointer`,
`branchDiscardsAnotherPlayersAction`, and `computeRevealedPhaseMarks` itself)
is not actually the same mechanism as issue #412's shipped undo/redo
(`applyUndoAction`/`applyRedoAction`, an implicit pointer folded from logged
`UNDO_ACTION`/`REDO_ACTION` entries via `resolveHistory`) — they're two
different pointer models that happen to compose (an explicit `pointer` into
`history` can itself contain implicit-model undo/redo entries within its
prefix) but were never exercised together by this document's own test
coverage until the fix above. `historyPointer.ts`'s explicit model remains
unused by any production call site today (only `applyUndoAction`/
`applyRedoAction` are wired into `GamePage.tsx`) — kept for phase 6's
branch-authorization check and a possible future "browse to an arbitrary
historical point" feature, neither of which exist yet. §4.4's still-open
question ("whether phase 6 still wants its own persisted `historyPointer`
column... or can just reuse `resolveHistory`") is unaffected by this fix
either way.

## 6. Data model changes

**Update (2026-09-04, phase 4, §8): smaller than originally scoped.**
Issue #412's append-only `actionHistory` + `resolveHistory()`
(§4.4's now-implemented update) turned out to already satisfy two of this
section's four original bullets for free — see the strikethroughs below —
so phase 4's actual DB work is just `game_state_meta` (done, this section)
plus, later, the RLS lockdown (deliberately not done yet — see that
bullet).

- **`game_state` (existing table):** stays the single authoritative row
  per game, but becomes **service-role write-only** — clients stop writing
  it directly (`writeGameState()` in `gameApi.ts` is replaced by
  `apply-action`/`undo-action`/`redo-action` invocations). Existing
  `version` column continues to back the compare-and-swap Edge Functions
  use internally. **Not done yet, deliberately:** flipping this RLS before
  `get_game_state`/`apply-action` exist (phases 5-6) and `gameApi.ts` is
  rewired onto them (phase 8) would cut off every client's *current* direct
  read/write path with nothing yet in place to replace it — this must land
  in the same push as phase 8, not standalone, or the live app breaks the
  moment this migration auto-deploys (`.github/workflows/deploy-supabase.yml`,
  §7).
- **`game_state_meta` — done** (`0025_game_state_meta.sql`): phase/status/
  turn/version only, kept in sync by a `security definer` trigger on every
  `game_state` insert/update (bypasses RLS to write it, since clients have
  no direct grant on this table), RLS-readable by the same audience
  `game_state` itself currently is (`0021_remove_observers.sql`,
  `0024_admin_read_all_game_state.sql`), added to the `supabase_realtime`
  publication. Landed ahead of the RLS lockdown it's actually for, same
  "safe to land early, deploys generically" reasoning §7's workflow used —
  it's inert (nothing reads it) until phase 8 subscribes to it instead of
  `game_state` directly.
- ~~**New: `historyPointer`**~~ — **turned out to be unnecessary.**
  Issue #412's `resolveHistory()` (`src/engine/historyFold.ts`) already
  derives "where current is" from `actionHistory` itself (walking
  `UNDO_ACTION`/`REDO_ACTION` entries), and nothing in `actionHistory` is
  ever deleted or reordered — so there's no separate pointer value that
  isn't already a pure function of the column phase 3 already writes
  (`state.actionHistory`, inside the existing `game_state.state` jsonb).
  `get_game_state`/`apply-action` (phases 5-6) can compute it the same way
  `resolveHistory()`/`stateAtPointer()` already do, with no new column.
- ~~**New: reveal high-water mark (§5.3)**~~ — **also unnecessary as
  persisted state**, for the same reason: `computeRevealedPhaseMarks()`
  (`src/engine/historyPointer.ts`) is already "deliberately a pure function
  of `history` rather than separately persisted, mutable state" (its own
  doc comment) — a mark can't outlive the resolving entry that produced it,
  since it's recomputed from `actionHistory` on every call. §10 has a new
  open item on what this means for `get_game_state`'s implementation,
  though: computing it requires replaying the *engine*, not just
  field-nulling, which is more than the "field-nulling, not game rules"
  characterization §5.2 gives `get_game_state` accounted for.
- ~~**Archived/pruned tail**~~ — **also unnecessary.** §4.4's original
  "submitting a new action while `pointer < tip` prunes the abandoned
  tail" language predates issue #412's actual implementation:
  `resolveHistory()` never deletes or moves entries out of `actionHistory`
  at all — a branch just means later `UNDO_ACTION`/`REDO_ACTION` entries
  can no longer reach the superseded ones (see `resolveHistory()`'s doc
  comment: "Branched-away entries stay in `history` ... simply no longer
  reachable by REDO_ACTION once superseded"). The raw column already *is*
  the permanent, unpruned archive; no side table needed.
- **RLS:** `game_state`'s existing read policies get replaced by policies
  restricting direct table access to service role only, with reads going
  through `get_game_state` instead — **deferred, see the `game_state`
  bullet above.** `game_state_meta`'s RLS (done) already uses the
  equivalent-to-today read policies this bullet originally called for.

## 7. Deploy automation

**Update (2026-09-04): done, and landed ahead of the functions/RPC it was
originally scoped to wait for.** Migrations and Edge Functions can still be
applied by hand (SQL editor / `supabase` CLI), but also deploy automatically
on every push to `main` via
[`.github/workflows/deploy-supabase.yml`](.github/workflows/deploy-supabase.yml)
— a human with workflow-edit rights added it directly (Claude's GitHub App
permissions still exclude editing `.github/workflows/*`, so this one
couldn't have shipped through the same path as the rest of this plan). It
triggers on a push touching `supabase/migrations/**` or `supabase/functions/**`
(or manual dispatch from the Actions tab), links the Supabase CLI to the
project, runs `supabase db push` for migrations, then plain
`supabase functions deploy` (no function names listed) to redeploy every
Edge Function in the repo. Authenticated via `SUPABASE_ACCESS_TOKEN`/
`SUPABASE_PROJECT_ID`/`SUPABASE_DB_PASSWORD` repo secrets, documented in
`README.md`'s "Deploying Supabase changes" section — same shape as Vercel's
existing auto-deploy. This also fixed the pre-existing manual-deploy
friction for `notify-discord-turn` (and now `notify-web-push` too).

Deploying *every* function rather than naming `apply-action`/`undo-action`/
`redo-action` explicitly (this document's original plan) was a deliberate
simplification: it means this workflow needs no edit when those functions
are added in phase 6 below, or if a future function is added later —
one less thing for a human-with-workflow-rights to remember to touch.

## 8. Execution plan (phased)

Each phase should land as its own PR/commit set; later phases depend on
earlier ones being merged.

1. **This document.** Record scope/design decisions (done — this file).
2. **`redactStateForPlayer()` + exhaustive unit tests** in `src/engine/`
   (done — `src/engine/redaction.ts`, `src/engine/__tests__/redaction.test.ts`).
   No behavior change to production code paths yet — purely additive and
   independently testable, same pattern as the rest of `src/engine/__tests__/`.
3. **`historyPointer` model**: engine-side support for an immutable
   `actionHistory` + pointer (replay from pointer instead of always from
   tip; branch = prune-and-append), with unit tests (done —
   `src/engine/historyPointer.ts`, `src/engine/__tests__/historyPointer.test.ts`).
   Still no network/DB change — this is engine logic first, wiring second.
   This phase's two open items from §4.4/§5.3 are now also settled and
   implemented, engine-side only:
   - **§5.3's reveal high-water mark** is `computeRevealedPhaseMarks()`
     (`historyPointer.ts`) — deliberately *not* separately persisted/mutable
     state, since it's a pure function of the tip `actionHistory` (replay it
     once, record every `(turn, roundPhase)` whose `pendingPlayerIds` hit
     zero); "deleted on branch" falls out for free because a pruned
     resolving entry just isn't in the new tip anymore, no explicit delete
     step needed. `redactStateForPlayerAtPointer()` (`redaction.ts`) is the
     pointer-aware entry point that consults it. **Bug fixed 2026-09-04 (see
     §5.3):** this originally walked the wrong internal array
     (`resolveHistory`'s pointer-truncated `.effective` instead of its
     branch-pruned-but-pointer-independent `.substantive`), which meant it
     silently lost the mark the moment a real player used the real Undo
     button (issue #412's shipped mechanism) — verified correct now against
     that actual path, not just the not-yet-wired-up explicit-pointer model
     its original tests exercised.
   - **§4.4's `RETRACT_CHOICE`** (`actions.ts`/`applyAction.ts`) is
     implemented for the `selectCards` case, which turned out to be the
     unambiguous half of the open item: `chosenCardIdByPlayerId` is a flat
     map and the card never leaves the player's hand at pick time, so
     retracting is just clearing the map entry and re-adding the player to
     `pendingPlayerIds` — no data beyond `playerId` needed on the action.
   - **§4.4's `RETRACT_DECLINE`** (`actions.ts`/`applyAction.ts`, resolving
     the open item this document previously left here — see §10's now-
     resolved entry) is implemented for both the "which zone did this card
     come from" and "can I retract before catching up on every owed card"
     questions §10 raised. It's a compensating action, symmetric with
     `RETRACT_CHOICE`, but needs a `cardId` payload (unlike `RETRACT_CHOICE`,
     a player can owe, and so already have declined, more than one card this
     phase — see `beginDeclinePhase`, `round.ts` — so "the" single thing to
     retract isn't well-defined without saying which). Legal for any of the
     caller's own still-open additions from the *current* decline phase,
     regardless of whether they've caught up on everything else they still
     owe.
4. **DB migration** — **`game_state_meta` done** (§6,
   `0025_game_state_meta.sql`); archived-tail storage and a `historyPointer`
   column turned out to be unnecessary (§6) so there's nothing left to build
   there. Updated RLS locking `game_state` to service-role-only is the one
   remaining part of this phase, intentionally deferred to land together
   with phase 8 (§6's `game_state` bullet explains why).
5. **`get_game_state` SQL RPC** (read-side redaction, §5.1–5.2) + migration
   — **open design question first, see §10:** §5.3's reveal high-water mark
   needs a full engine replay (`computeRevealedPhaseMarks()`), not the plain
   field-nulling §5.2 originally scoped this RPC as, which is a real tension
   with implementing it as plain SQL/plpgsql instead of an Edge Function.
6. **`apply-action` / `undo-action` / `redo-action` Edge Functions**,
   reusing the engine as-is: seat resolution from JWT, `action.playerId`
   enforcement (§4.1), fast-forwarding (§4.3), pointer-based undo/redo
   with owner-override pruning (§4.4), version compare-and-swap on write.
7. **CI deploy workflow** (§7) — done ahead of order, out of phase sequence
   (`.github/workflows/deploy-supabase.yml`, added directly by a human with
   workflow-edit rights since Claude's GitHub App permissions can't touch
   `.github/workflows/*`). Safe to land early because it deploys generically
   (`supabase functions deploy` with no names) rather than depending on
   phase 6's specific functions existing yet.
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
  `MOVE_TO_DECLINE`; §4.4/§5.3 refinement cases specifically — retracting
  only the caller's own pending pick leaves other players'
  visible-or-secret picks untouched; `RETRACT_DECLINE` returning a card to
  its actual source zone (hand vs. discard, including this round's played
  card) rather than always defaulting to one, remaining retractable
  regardless of whether the caller has caught up on every card they still
  owe, and rejecting a card that isn't this phase's own addition; a plain
  review-only pointer rewind into an already-resolved phase does not
  re-mask it (no flicker); a branch that prunes a phase's resolving action
  both reopens
  `pendingPlayerIds` for every player whose pick was discarded **and**
  deletes that phase's reveal high-water mark so redaction re-masks it;
  cross-player pruning here still requires the owner-override gate.
- **Edge Function level:** requires a live Supabase project — out of reach
  in this sandbox (no credentials/Docker), consistent with existing
  `todo.md` notes about board-setup/round-view verification. Maintainer
  verification needed post-merge for each of phases 6–9.
- **Regression:** existing `src/engine/__tests__/` suite (220+ tests as of
  this writing) must continue passing unmodified — this work changes *who*
  calls the engine and *what subset* of its output a given viewer receives,
  not the engine's rules themselves.

## 10. Open items / risks

- ~~Exact storage shape for the archived branch-pruning tail (§6)~~ —
  **resolved, phase 4 (2026-09-04): no storage needed.** `resolveHistory()`
  (issue #412) never deletes or moves `actionHistory` entries — a branch is
  just later `UNDO_ACTION`/`REDO_ACTION` entries no longer being able to
  reach the superseded ones. The existing column already is the archive.
- Exact storage shape for the reveal high-water mark (§5.3/§6) — **engine
  side (phase 3, §8) needs no storage at all** (unchanged from before):
  `computeRevealedPhaseMarks()` derives it on demand from the tip
  `actionHistory` — and, as of the 2026-09-04 fix documented in §5.3 above,
  now does so *correctly* against the real, shipped undo/redo mechanism
  (issue #412), not just the not-yet-wired-up explicit-pointer model its
  existing tests happened to exercise. **Tension found while scoping phase 5
  (2026-09-04), still open:** §5.2 characterizes `get_game_state` as pure
  "field-nulling, not game rules," implementable as a plain SQL/plpgsql
  `SECURITY DEFINER` RPC — but `computeRevealedPhaseMarks()` isn't
  field-nulling, it's a full replay of every logged action through
  `applyAction()` (the actual rules engine) to find which simultaneous
  phases resolved. Reimplementing that in SQL would duplicate rule logic
  outside `src/engine/` — exactly what §3 chose Edge Functions to avoid in
  the first place. Two ways to resolve this, needs a decision before phase 5
  is implemented:
  a. `get_game_state` does §5.1's plain (non-sticky) redaction only, in SQL,
     as originally scoped, and §5.3's stickiness either waits for a later
     increment or is computed a different way (e.g. cached alongside
     `game_state` by whichever Edge Function call last resolved a phase,
     rather than recomputed per read). Concretely regresses issue #407's own
     ask the moment it ships (a real player using the real Undo button would
     see other players' already-revealed picks flicker back to hidden) —
     not a security leak (§5.3), but a real, user-visible step backward from
     behavior #407 already fixed, not just a hypothetical gap; or
  b. `get_game_state` is actually implemented as an Edge Function (Deno/TS,
     reusing `src/engine/`'s `computeRevealedPhaseMarks()`/
     `redactStateForPlayerAtPointer()` unmodified) despite the "Postgres
     RPC" framing in §5.2 — consistent with §3's reuse-the-engine rationale,
     at the cost of one more Deno cold start per state read (mitigated by
     §3's own "negligible for a turn-based game" expectation, same as
     `apply-action`).
  **New consideration against assuming (b) is low-risk (2026-09-04):** the
  one Edge Function precedent that already exists,
  `supabase/functions/notify-discord-turn/index.ts`, does NOT import
  `src/engine/` — its own comment says why: "Deno Edge Functions run in an
  isolated runtime that can't import the app's Vite-aliased TypeScript
  sources directly," so it keeps a small, explicitly-flagged "deliberate,
  minimal copy" of the pure logic it needs instead. Checked directly:
  `src/engine/` itself has no Vite path aliases at all (pure relative
  imports throughout — confirmed via `tsconfig.json`/`vite.config.ts`, no
  `paths` config, and `grep`ing `src/engine/` for `from '@`), so that
  specific claim doesn't describe an actual obstacle in this codebase as it
  stands today — but this sandbox has no Deno CLI and no way to run
  `supabase functions deploy` or a local Postgres/Docker stack (`docker
  info` needs interactive approval this non-interactive session can't give)
  to actually verify an Edge Function importing `src/engine/` bundles and
  deploys cleanly (in particular, whether `resolveContent.ts`'s direct
  `.json` imports need a Deno `with { type: "json" }` import assertion, and
  whether `supabase functions deploy`'s bundler resolves a relative import
  three directories outside `supabase/functions/` at all). Getting this
  wrong isn't cheap to discover: `.github/workflows/deploy-supabase.yml`
  runs a bare `supabase functions deploy` (every function, no names listed)
  on every push touching `supabase/migrations/**` or `supabase/functions/**`
  — an Edge Function that fails to bundle would fail that step on every
  subsequent push touching either path, not just its own, until someone
  notices and fixes or reverts it. (b) is still closer to this document's
  own stated principles (§3: reuse `src/engine/` unmodified, no rule-logic
  duplication) and remains the better answer *if* it deploys — but "if it
  deploys" is now flagged as a real, checkable-only-against-a-live-project
  unknown rather than assumed away, so this still needs an explicit decision
  (and ideally a maintainer's own `supabase functions deploy --dry-run` or
  equivalent smoke test against a real project) before phase 5 starts,
  not an assumption either way.
- **`RETRACT_CHOICE` and `RETRACT_DECLINE` both implemented (§4.4, phase 3,
  §8).** `RETRACT_DECLINE` turned out to need two design decisions beyond
  `RETRACT_CHOICE`'s treatment, both now resolved (2026-09-04):
  - **Source-zone tracking.** `CHOOSE_CARD` never moves the picked card out
    of the player's hand (only `chosenCardIdByPlayerId` changes), so
    retracting it is a pure map edit. `MOVE_TO_DECLINE` (`applyMoveToDecline`,
    `applyAction.ts`) *does* move the card immediately, via `moveCard()`
    (`cards.ts`), out of whichever zone it actually came from — hand or
    discard. This document's prior draft recommended deriving the source
    zone from `actionHistory` via `stateAtPointer` at retract time, matching
    `computeRevealedPhaseMarks`' "derive, don't persist" approach — in
    practice that needs a `genesis` state to replay from, which
    `applyRetractDecline`'s call site (an ordinary `dispatchAction` handler,
    like every other `apply*` function) never has; only the pointer-aware
    callers in `historyPointer.ts` do. Threading `genesis` through the whole
    `applyAction` call chain just for this one handler was judged worse than
    the alternative actually taken: a new **optional** `GameState` field,
    `declineSourceZoneByCardId: Record<string, CardZone>` (`types.ts`) —
    populated by `applyMoveToDecline` at the moment a card actually leaves
    hand/discard, reset to `{}` at the start of every new decline phase
    (`beginDeclinePhase`, `round.ts`), and consumed (key deleted) by
    `applyRetractDecline`. This is live scratch state for "what to do right
    now," not part of the replayable log — same category as
    `chosenCardIdByPlayerId` itself, not a new kind of persistence. Optional
    specifically so every existing test fixture that builds a `GameState`
    object literal (dozens, across `src/engine/__tests__/`) keeps compiling
    unchanged; every read defaults via `?? {}`/optional-chaining. A card
    with no entry (an already-public prior round's decline addition,
    never bought back) is correctly not retractable — this is also what
    makes "only *this* phase's own additions are retractable" hold, for
    free, without a separate check.
  - **Multi-card-owed retraction timing.** A player who owes more than one
    decline card (`beginDeclinePhase`, `round.ts`) appears more than once in
    `pendingPlayerIds`. Decided: retracting one already-declined card never
    requires having caught up on every other card still owed — symmetric
    with how `RETRACT_CHOICE` needs no special permission, and avoids an
    arbitrary ordering restriction with no rules basis. `RetractDeclineAction`
    accordingly carries a `cardId` (unlike the payload-less
    `RetractChoiceAction`), since a player can have more than one of their
    own still-open additions at once and needs to say which one.
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
- Edge Function cold-start/latency impact on perceived responsiveness in
  live mode — expected to be negligible for a turn-based game, but worth
  confirming during phase 9 verification.
- §4.5's admin/owner carve-outs (server-side `playerId` override in
  `apply-action`, `profiles.is_admin` added to §4.4's owner-override redo
  condition, unredacted `get_game_state` for admin/owner) need to land
  *with* phases 5–6, not after — otherwise admin mode either breaks or
  becomes an unreviewed impersonation hole the moment enforcement ships.
