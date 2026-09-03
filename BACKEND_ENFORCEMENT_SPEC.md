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
- **New: reveal high-water mark (§5.3)** — at most one live entry per
  simultaneous phase (`selectCards`/`decline`), keyed by `turn` + phase,
  recording that phase's resolution as sticky-revealed independent of
  `historyPointer`. Given §2's confirmed scope (never more than one
  simultaneous-secret window open at a time), this never needs more than a
  single "currently sticky" row per game, though prior turns' marks may be
  worth retaining for audit/debugging even after they stop affecting
  redaction. Deleted (or superseded) when the resolving action it refers to
  is pruned by a branch (§4.4/§5.3) — exact shape (column on `game_state`
  vs. its own table) TBD in phase 4 (§8), alongside `historyPointer`.
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
     pointer-aware entry point that consults it.
   - **§4.4's `RETRACT_CHOICE`** (`actions.ts`/`applyAction.ts`) is
     implemented for the `selectCards` case, which turned out to be the
     unambiguous half of the open item: `chosenCardIdByPlayerId` is a flat
     map and the card never leaves the player's hand at pick time, so
     retracting is just clearing the map entry and re-adding the player to
     `pendingPlayerIds` — no data beyond `playerId` needed on the action.
     **`RETRACT_DECLINE` is deliberately not implemented yet** — see §10.
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
  `MOVE_TO_DECLINE`; §4.4/§5.3 refinement cases specifically — retracting
  only the caller's own pending pick leaves other players'
  visible-or-secret picks untouched; a plain review-only pointer rewind
  into an already-resolved phase does not re-mask it (no flicker); a
  branch that prunes a phase's resolving action both reopens
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

- Exact storage shape for the archived branch-pruning tail (§6) — side
  table vs. JSON array column — to be settled in phase 4.
- Exact storage shape for the reveal high-water mark (§5.3/§6) — **partly
  resolved**: engine-side (phase 3, §8) it needs no storage at all, since
  `computeRevealedPhaseMarks()` derives it on demand from the tip
  `actionHistory`. Phase 4 still needs to decide whether the DB layer
  persists this (e.g. to avoid replaying a long game's full history on
  every `get_game_state` call) or just calls the equivalent logic
  server-side per read — a performance choice, not a correctness one, given
  a small friend group's game lengths.
- **`RETRACT_CHOICE` implemented (§4.4, phase 3, §8); `RETRACT_DECLINE`
  still open**, and turns out to need one more design decision, not just
  the same treatment as `RETRACT_CHOICE`: `CHOOSE_CARD` never moves the
  picked card out of the player's hand (only `chosenCardIdByPlayerId`
  changes), so retracting it is a pure map edit. `MOVE_TO_DECLINE`
  (`applyMoveToDecline`, `applyAction.ts`) *does* move the card immediately,
  via `moveCard()` (`cards.ts`), out of whichever zone it actually came from
  — hand or discard, callers may supply either. Reversing that move needs
  to know which zone to put the card back in, and nothing on the logged
  action records it today (`MoveToDeclineAction` only carries `cardId`).
  Recommended fix, to decide alongside `RETRACT_DECLINE`'s implementation:
  determine the source zone by looking up where `cardId` sat in
  `actionHistory`-derived state immediately before that specific
  `MOVE_TO_DECLINE` entry (`stateAtPointer` up to that index already gives
  this for free, no new stored field needed) — same "derive, don't persist"
  approach `computeRevealedPhaseMarks` above just validated. A second,
  smaller wrinkle: a player who owes more than one decline card
  (`beginDeclinePhase`, `round.ts`) appears more than once in
  `pendingPlayerIds`; §4.4's text ("they're not in `pendingPlayerIds` for
  this phase") describes the `selectCards` case cleanly but doesn't say
  whether a player who has submitted one of two owed cards (still pending
  for the second) should already be able to retract the first, or only once
  fully caught up — needs an explicit answer before implementing, since it
  changes the legality check `applyRetractDecline` would use.
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
