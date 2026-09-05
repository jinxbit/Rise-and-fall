# Rule Enforcement — Spec, Design & Execution Plan

Tracks [issue #37](https://github.com/jinxbit/Rise-and-fall/issues/37). This is
the living source of truth for the **rule enforcement** half of that issue —
update it as decisions change, the same way `PROJECT_PLAN.md` tracks the rest
of the project.

This document was split out of `BACKEND_ENFORCEMENT_SPEC.md` (per
[issue #423](https://github.com/jinxbit/Rise-and-fall/issues/423)) to separate
the rule-enforcement concern from the hidden-information concern — the two
were related but distinct problems (see §1) tangled together in one file.
**Section numbers are preserved from the original combined document**, so
existing code comments/tests that cite a section number by itself (without a
filename) still resolve correctly here; sections that moved to the companion
document are marked below rather than renumbered, so a bare "§5.1" elsewhere
in the codebase unambiguously means `HIDDEN_INFORMATION_PLAN.md`. See
[`HIDDEN_INFORMATION_PLAN.md`](HIDDEN_INFORMATION_PLAN.md) for the hidden-
information half (§2 scope of hidden fields, §5 redaction, and the
hidden-information-specific parts of §1/§6/§8/§9/§10 below).

[Issue #407](https://github.com/jinxbit/Rise-and-fall/issues/407) refined the
undo/redo semantics below (§4.4) after this document already existed — that
section carries that refinement's rationale inline rather than being restated
as a separate proposal.

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

Issue #37 is two related but distinct problems. This document covers the
first:

1. **Rule enforcement** — stop trusting client-submitted state; validate
   every action server-side against the existing engine, and reject actions
   a player isn't entitled to submit (e.g. someone else's move).

The second — **hidden information** (during the brief window where a choice
is simultaneous and unresolved, don't let opponents' clients receive the
secret data at all) — is covered by
[`HIDDEN_INFORMATION_PLAN.md`](HIDDEN_INFORMATION_PLAN.md).

## Scope

The full scope discussion (what's hidden, what's public, hotseat/live/async
in/out of scope) lives in
[`HIDDEN_INFORMATION_PLAN.md` §2](HIDDEN_INFORMATION_PLAN.md#2-scope-confirmed)
— it was resolved as one discussion covering both halves of issue #37 and
isn't duplicated here. The two points from it that bear directly on
enforcement:

- **Hotseat is explicitly out of scope.** All local hotseat players share
  one `auth.uid()` (see `supabase/migrations/0003_hotseat_local_players.sql`,
  `0004_hotseat_skip_pass_gate.sql`), so per-seat enforcement doesn't apply
  there — the existing "pass the device" courtesy gate remains the only
  boundary for hotseat, unchanged, and hotseat's rule enforcement stays
  exactly as trusting as it is today.
- **Live and async modes are in scope.**

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

This decision also underpins `HIDDEN_INFORMATION_PLAN.md`'s `get_game_state`
read path (§10 there has an open question on whether that RPC should
likewise be an Edge Function, for the same reuse-the-engine reasoning).

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

- **Forced single-card choice.** **Update (2026-09-05, per jinxbit): moved
  into the state machine itself, not a UI action.** Originally this was a
  client-side courtesy (`RoundView.tsx`'s `SelectCardsPanel` auto-submitting
  `CHOOSE_CARD` the instant a pending player's hand had one card) — jinxbit's
  design update reframed this: "when a player has only a single option ...
  this option should be taken automatically by the state machine," not by a
  UX action (automatic or player-driven). `SelectCardsPanel` no longer
  auto-submits anything; instead `applyAction.ts`'s fast-forward loops
  (§4.3) take the forced action themselves as part of ordinary action
  submission, for **every** game, not just `ruleEnforcementEnabled` ones —
  `applyActionAndFastForward()` is the single entry point both
  `GamePage.tsx`'s `submitAction` (client-trusted games) and the
  `apply-action` Edge Function (enforced games, via
  `gameEnforcement.ts`'s `applyActionFullyEnforced`) call. Each
  fast-forwarded step still lands its own ordinary `actionHistory` entry,
  now stamped `automatic: true` (`LoggedAction.automatic`, `src/engine/
  actions.ts`) so the log can say the state machine took it rather than the
  player (`RoundView.tsx`'s `LogPanel` renders a small "(auto)" tag).
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

This **must run inside `apply-action` server-side** for `ruleEnforcementEnabled`
games — not primarily for security (once §4.1 is enforced, a client can't
forge this on another player's behalf either way), but so the round doesn't
stall waiting on a client that's slow to, or never does, take the forced
follow-up.

**Update (2026-09-05, per jinxbit):** the client side of this also changed,
per §4.2's update above — `applyActionAndFastForwardChoices`/
`fastForwardPendingChoices` now run for every live submission via
`applyActionAndFastForward()` (`src/engine/applyAction.ts`), not just inside
`apply-action`. `GamePage.tsx`'s `submitAction` calls it for client-trusted
games exactly the same way `apply-action` does for enforced ones, so the
forced follow-up is always something the state machine took (and logged as
`automatic: true`), never a `RoundView.tsx` UI effect deciding on the
player's behalf — the security argument above (needed once §4.1 is
enforced) is unchanged, this just also fixes the UX/design property jinxbit
raised: even a client-trusted game's log should say "the game did this,"
not "the player did this," for a choice that was never really made.

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
today as before this change), and RETRACT_CHOICE/`HIDDEN_INFORMATION_PLAN.md`
§5.3's simultaneous-phase refinement below is unaffected (already implemented
separately, see phase 3 in §8). Whether phase 6 still wants its own persisted
`historyPointer` column (e.g. for a server-side authorization check that
doesn't want to refold the whole log on every request) or can just reuse
`resolveHistory` against the same `actionHistory` it already reads is an
open question for that phase, not resolved here.

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
(`selectCards`/`decline`, `HIDDEN_INFORMATION_PLAN.md` §2) is still open.**
`chosenCardIdByPlayerId` entries for different players interleave in
`actionHistory` in submission order, not turn order — they're independent,
commuting writes (each `CHOOSE_CARD`/`MOVE_TO_DECLINE` only ever touches the
acting player's own slot). If player A submits, then player B submits, A
calling "undo" must not silently undo B's still-secret pick just because B's
entry happens to sit at the tip. Concretely:

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
  them back in `pendingPlayerIds`, owing a fresh pick. See
  `HIDDEN_INFORMATION_PLAN.md` §5.3 for the one piece this doesn't give for
  free: keeping their *already-revealed* pick from flickering back to secret
  for a client that saw it, right up until someone actually branches.

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
either — there's no redaction yet (`HIDDEN_INFORMATION_PLAN.md` §5), so admin
already sees exactly what every other player's client already receives (the
known gap issue #37 exists to close). Once that document's `get_game_state`
redaction ships, admin mode needs an explicit carve-out there too: a viewer
who is the room owner or `profiles.is_admin` should receive the
**unredacted** state (skip the `selectCards`/`decline` masking) so that
acting on another player's still-secret in-progress choice via admin mode
actually works — otherwise admin mode would let them click a card-choice
button whose contents they can't see. This is a deliberate, logged-as-"admin
mode" trust boundary (the room owner and any site admin can already see/do
almost everything else in this app), not an oversight — call it out
explicitly in the `get_game_state` implementation (phase 5 of that
document's execution plan) so it isn't missed.

## 6. Data model changes

**Update (2026-09-04, phase 4, §8): smaller than originally scoped.**
Issue #412's append-only `actionHistory` + `resolveHistory()`
(§4.4's now-implemented update) turned out to already satisfy most of this
section's original asks for free — see the strikethroughs below — so this
phase's actual remaining DB work is just the RLS lockdown (deliberately not
done yet — see that bullet). `game_state_meta`, the one piece of this phase
that *is* done, exists primarily for `HIDDEN_INFORMATION_PLAN.md`'s
redaction work — see that document's §6 for it.

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
- ~~**New: `historyPointer`**~~ — **turned out to be unnecessary.**
  Issue #412's `resolveHistory()` (`src/engine/historyFold.ts`) already
  derives "where current is" from `actionHistory` itself (walking
  `UNDO_ACTION`/`REDO_ACTION` entries), and nothing in `actionHistory` is
  ever deleted or reordered — so there's no separate pointer value that
  isn't already a pure function of the column phase 3 already writes
  (`state.actionHistory`, inside the existing `game_state.state` jsonb).
  `get_game_state`/`apply-action` (phases 5-6) can compute it the same way
  `resolveHistory()`/`stateAtPointer()` already do, with no new column.
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
  bullet above.** `game_state_meta`'s RLS (done, see
  `HIDDEN_INFORMATION_PLAN.md` §6) already uses the equivalent-to-today read
  policies this bullet originally called for.
- **Update (2026-09-05, per jinxbit): phased rollout via a per-game opt-in
  flag, replacing the global cutover above.** Rather than locking
  `game_state`'s RLS to service-role-only for every game at once (which is
  what forced bundling this with phase 5's `get_game_state` read path, per
  the two bullets above), add `ruleEnforcementEnabled: boolean` to
  `GameSettings` (`src/lib/dbTypes.ts`, stored in `games.settings` jsonb —
  the same mechanism `skipHotseatPassGate`/`mapTemplateId`/etc. already use
  for per-game opt-in switches), defaulting to `false`. `game_state`'s
  insert/update RLS policies gain one extra clause — direct client writes
  are permitted only when the owning game's flag is off (`coalesce`d, so
  every pre-existing game with no such key reads as off automatically).
  Games with it off (the default, and every game that exists today) keep
  writing `game_state` directly exactly as now; games with it on can only
  be written by the service role, i.e. only through
  `apply-action`/`undo-action`/`redo-action`. This decouples the write-side
  RLS lock from `get_game_state`/redaction entirely: reads are untouched
  either way, so an enforcement-enabled game reads its state exactly as
  unredacted as any other game does today — hidden information
  (`HIDDEN_INFORMATION_PLAN.md`) stays the separate, independently-timed
  concern issue #423 split it out to be. See §8 phase 8 for how this
  changes the rewire itself.

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

This workflow deploys every migration/function in the repo generically, so
it serves `HIDDEN_INFORMATION_PLAN.md`'s `get_game_state` migration/function
too, not just this document's `apply-action`/`undo-action`/`redo-action`.

Deploying *every* function rather than naming
`apply-action`/`undo-action`/`redo-action` explicitly (this document's
original plan) was a deliberate simplification: it means this workflow needs
no edit when those functions are added in phase 6 below, or if a future
function is added later — one less thing for a human-with-workflow-rights to
remember to touch.

## 8. Execution plan (phased)

Each phase should land as its own PR/commit set; later phases depend on
earlier ones being merged. Phase numbers are shared with
[`HIDDEN_INFORMATION_PLAN.md`](HIDDEN_INFORMATION_PLAN.md#8-execution-plan-phased)
— it's one execution timeline covering both documents; phases not relevant
to rule enforcement (2, 5) are omitted here.

1. **These documents.** Record scope/design decisions (done — this file and
   `HIDDEN_INFORMATION_PLAN.md`, split from the original combined
   `BACKEND_ENFORCEMENT_SPEC.md` per issue #423).
3. **`historyPointer` model**: engine-side support for an immutable
   `actionHistory` + pointer (replay from pointer instead of always from
   tip; branch = prune-and-append), with unit tests (done —
   `src/engine/historyPointer.ts`, `src/engine/__tests__/historyPointer.test.ts`).
   Still no network/DB change — this is engine logic first, wiring second.
   This phase's open item from §4.4 is now also settled and implemented,
   engine-side only:
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
   - (`HIDDEN_INFORMATION_PLAN.md` §5.3's reveal high-water mark was also
     settled and implemented in this same phase, engine-side — see that
     document.)
4. **DB migration** — `game_state_meta` (`HIDDEN_INFORMATION_PLAN.md` §6) is
   done; archived-tail storage and a `historyPointer` column turned out to be
   unnecessary (§6 above) so there's nothing left to build there. Updated RLS
   locking `game_state` to service-role-only is the one remaining part of
   this phase, intentionally deferred to land together with phase 8 (§6's
   `game_state` bullet explains why).
6. **`apply-action` / `undo-action` / `redo-action` Edge Functions**,
   reusing the engine as-is: seat resolution from JWT, `action.playerId`
   enforcement (§4.1), fast-forwarding (§4.3), pointer-based undo/redo
   with owner-override pruning (§4.4), version compare-and-swap on write.
   `supabase/functions/apply-action`, `undo-action`, `redo-action`
   (+ shared plumbing in `supabase/functions/_shared/gameEnforcement.ts`)
   import `src/engine/`/`src/content/` **directly and unmodified**, resolving
   §6's "open question" left above in favor of the already-shipped
   marker-based history model (issue #412's `UNDO_ACTION`/`REDO_ACTION`
   entries + `resolveHistory`) rather than `historyPointer.ts`'s
   separate-pointer-column design — a new `redoableTail()`
   (`src/engine/historyFold.ts`, unit-tested) exposes exactly what the
   owner-override check (§4.4, extended to `profiles.is_admin` per §4.5)
   needs from that model. §4.3's fast-forwarding gained its `CHOOSE_CARD`/
   `MOVE_TO_DECLINE` half here too: `applyActionAndFastForwardChoices()`/
   `fastForwardPendingChoices()` (`src/engine/applyAction.ts`, unit-tested),
   mirroring the existing tile version.
   **Verified (2026-09-05) against a local `supabase start` stack** (Docker
   + the Supabase/Deno CLIs became available once `claude.yml` grew a real
   environment — see the `.github/workflows/claude.yml` history). Both
   risks this section used to flag as unverified were real, and both are
   now fixed:
   - The Edge Runtime (`supabase/edge-runtime` v1.74.3, bundled by CLI
     2.116) does **not** honor `sloppy-imports`, in a per-function
     `deno.json`, a workspace-root one, or any other placement tried — it
     failed on `src/engine/applyAction.ts`'s own extensionless `./cards`-
     style imports with `Module not found` every time. Fixed by adding
     explicit `.ts` extensions to every relative import in the ~30 files
     the three functions' module graph actually touches (`src/engine/*`,
     `src/content/resolveContent.ts`, `src/lib/gameGenesis.ts`/`dbTypes.ts`)
     — safe for the Vite/tsc side too, since `tsconfig.app.json` already
     sets `allowImportingTsExtensions`. The per-function `deno.json`'s
     `sloppy-imports` flag is left in place (harmless, and free insurance
     if a future edge-runtime version starts honoring it) but no longer
     load-bearing.
   - `src/content/resolveContent.ts`'s plain `import x from './x.json'`
     also failed to boot (`Expected a JavaScript or TypeScript module, but
     identified a Json module`) — fixed with the `with { type: 'json' }`
     import attribute the doc comment already anticipated, which
     TypeScript 6's `tsc` and Vite both accept unchanged.
   - With both fixed, all three functions boot and were smoke-tested end
     to end against the local stack with two real `auth.users` (password
     sign-in, real JWTs): `apply-action` correctly 403s a caller submitting
     another player's `playerId` and 200s + CAS-writes (`version` 0→1) a
     legal `PLACE_UNIT` for the caller's own seat, replaying through the
     real engine (card moved hand→board, `boardSetup.unitPlacerIndex`
     advanced); `undo-action`/`redo-action` correctly rebuild genesis and
     replay, round-tripping `version` 1→2→3 and the unit's presence on the
     board. Not yet done: a genuine two-browser session against a
     *deployed* (not local) project, and the fast-forward/owner-override
     paths specifically — still phase 9's job.
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
   **Update (2026-09-05, per jinxbit): per-game opt-in rewire, not a single
   flag-day cutover — see §6's `ruleEnforcementEnabled` bullet.**
   `gameApi.ts`'s write path branches on the game's flag: off (the default,
   and every pre-existing game) keeps writing `game_state` directly exactly
   as today; on calls `apply-action`/`undo-action`/`redo-action` instead.
   This lets the write-side half of this phase ship on its own — opt-in,
   new games only, zero risk to any in-progress game — without waiting on
   phase 5's `get_game_state`. The read-side half (rewiring onto
   `get_game_state`) stays exactly as blocked on phase 5 as before, for
   both flagged and unflagged games; an enforcement-enabled game just reads
   its own unredacted `game_state` row like every other game does until
   that phase lands.
   **Write-side half done (2026-09-05):**
   - `GameSettings.ruleEnforcementEnabled` (`src/lib/dbTypes.ts`), a
     `createGame()` param, and a `CreateGamePage.tsx` checkbox ("Enable
     server-side rule enforcement (experimental)", unchecked by default).
   - `0026_rule_enforcement_flag.sql` replaces `game_state`'s UPDATE RLS
     policy with one that additionally requires the owning game's flag to be
     off, `coalesce`d so every pre-existing/default game is unaffected.
     **INSERT is deliberately left alone** — `LobbyPage.tsx`'s one
     `insertGameState` call (writing the deterministic genesis state before
     any action exists) isn't an "action against existing state" in §4's
     sense (`apply-action` itself requires a `game_state` row to already
     exist), so it's out of this document's scope; see §10 for the
     follow-up this leaves open.
   - `gameApi.ts` gained `applyActionEnforced`/`undoActionEnforced`/
     `redoActionEnforced`, thin wrappers around
     `supabase.functions.invoke('apply-action'|'undo-action'|'redo-action', ...)`
     that normalize both the success and error shape of the Edge Functions'
     JSON responses (supabase-js reports a non-2xx response as `error` with
     `data: null` rather than the function's own body, so these reach into
     `error.context` to recover the actual `{ok:false, error}` message).
   - `GamePage.tsx`'s `submitAction`/`handleUndo`/`handleRedo` branch on
     `game.settings.ruleEnforcementEnabled`: off keeps the existing
     `writeWithRetry` client-computed-and-written path; on calls the new
     `runEnforced()` helper, which applies the same guard checks
     (`writeGuardError()`, factored out of `writeWithRetry`) then submits to
     the Edge Function and adopts its returned `state`/`version` directly —
     no client-side retry loop, since the Edge Function already did its own
     compare-and-swap server-side (a 409 just surfaces as an ordinary error).
   - Verified: `npm run test` (1064 tests), `npm run lint`, `npm run build`.
     **Not verified:** an actual `supabase db push` of the new migration
     against a live/local project, or the Edge Functions actually being
     invoked from a real signed-in browser session — this sandbox's
     `supabase start` stack from phase 6's verification wasn't re-used here;
     see §9/§10.
9. **End-to-end verification against a real two-browser Supabase
   session**, exercising this document's authorization rules specifically —
   confirm a client can't submit an action naming another player's
   `playerId`, that undo/redo/branch owner-override behaves as specced, and
   that admin mode's server-side carve-out (§4.5) works once enforcement is
   live. Phase 6's own smoke test (above) already did the single-browser,
   direct-curl version of the 403/undo/redo checks against a local
   `supabase start` project; what's still outstanding is the same checks
   through two actual signed-in browser sessions against a *deployed*
   project once phase 8 has rewired the client to call these functions —
   this sandbox can spin up a local stack but not a deployed one or a real
   two-browser session, so this phase still requires the maintainer's own
   environment, same limitation noted throughout `todo.md`. See
   `HIDDEN_INFORMATION_PLAN.md` §8 phase 9 for the
   companion verification of secret-field leakage in the same session.

## 9. Testing strategy

- **Engine-level (this sandbox can run these):** pointer-based undo/redo/
  branch unit tests including the owner-override condition; fast-forward
  tests for forced single-choice `CHOOSE_CARD`/`MOVE_TO_DECLINE`; §4.4's
  refinement cases specifically — retracting only the caller's own pending
  pick leaves other players' visible-or-secret picks untouched;
  `RETRACT_DECLINE` returning a card to its actual source zone (hand vs.
  discard, including this round's played card) rather than always
  defaulting to one, remaining retractable regardless of whether the caller
  has caught up on every card they still owe, and rejecting a card that
  isn't this phase's own addition; a branch that prunes a phase's resolving
  action reopens `pendingPlayerIds` for every player whose pick was
  discarded; cross-player pruning here still requires the owner-override
  gate.
- **Edge Function level:** requires a live Supabase project — out of reach
  in this sandbox (no credentials/Docker), consistent with existing
  `todo.md` notes about board-setup/round-view verification. Maintainer
  verification needed post-merge for each of phases 6–9, specifically:
  `action.playerId !== callerSeat` rejection, admin/owner override paths,
  and version compare-and-swap on concurrent writes.
- **Regression:** existing `src/engine/__tests__/` suite (220+ tests as of
  this writing) must continue passing unmodified — this work changes *who*
  calls the engine and *what subset* of its output a given viewer receives,
  not the engine's rules themselves.

(See `HIDDEN_INFORMATION_PLAN.md` §9 for redaction-specific testing.)

## 10. Open items / risks

- ~~Exact storage shape for the archived branch-pruning tail (§6)~~ —
  **resolved, phase 4 (2026-09-04): no storage needed.** `resolveHistory()`
  (issue #412) never deletes or moves `actionHistory` entries — a branch is
  just later `UNDO_ACTION`/`REDO_ACTION` entries no longer being able to
  reach the superseded ones. The existing column already is the archive.
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
- Edge Function cold-start/latency impact on perceived responsiveness in
  live mode — expected to be negligible for a turn-based game, but worth
  confirming during phase 9 verification.
- §4.5's admin/owner carve-outs (server-side `playerId` override in
  `apply-action`, `profiles.is_admin` added to §4.4's owner-override redo
  condition, unredacted `get_game_state` for admin/owner) need to land
  *with* phases 5–6, not after — otherwise admin mode either breaks or
  becomes an unreviewed impersonation hole the moment enforcement ships.
- **Resolved (2026-09-05): the `CreateGamePage.tsx` checkbox is visible to
  any room creator from day one** (labeled "experimental", unchecked by
  default) rather than gated behind an admin/dev-only affordance — still
  open: whether/when the default flips to `true` for new games (and the
  now-dead off-path + RLS carve-out get deleted) once it has run without
  surprises. Rollout-sequencing call, not a blocker.
- **New (2026-09-05), from the write-side rewire (§8 phase 8):**
  - ~~`undo-action`/`redo-action` don't yet repeat `GamePage.tsx`'s
    forced-single-card walk-back loop (issue #131)~~ — **resolved
    (2026-09-05), as a side effect of §4.2's state-machine redesign.** Now
    that a forced follow-up is stamped `automatic: true` on its own
    `actionHistory` entry (`LoggedAction.automatic`) instead of being
    invisible UI behavior, `applyUndoAction()` itself
    (`src/engine/undoRedo.ts`) walks back past any consecutive `automatic`
    entries before returning — one call, no special-casing by the caller.
    `GamePage.tsx`'s `handleUndo` and the `undo-action` Edge Function both
    just call `applyUndoAction()` once and get this for free (the old
    client-only `wasForcedCardChoice()` heuristic loop is deleted); redo
    naturally reverses it one `REDO_ACTION` at a time, same as any other
    entry. This also removes the last reason the write-side rewire's
    checkbox needed to stay labeled "experimental" for this specific gap.
  - The initial `game_state` row (`LobbyPage.tsx`'s `insertGameState`, the
    deterministic genesis state) is still a direct, unenforced client
    insert for every game, flagged or not (`0026_rule_enforcement_flag.sql`
    only restricts UPDATE) — a malicious client could in principle submit a
    fabricated genesis (e.g. rigged hands) before their first real action.
    Treated as out of scope for the same reason `apply-action` itself
    requires a `game_state` row to already exist: this is state *creation*,
    not an action against existing state. If this is judged to matter
    enough to close even for a fabricated one-off row, it needs its own
    "create-game-state" Edge Function (or folding into `apply-action`'s
    `loadGameContext` allowing a null `gameState`) — not attempted here.

(See `HIDDEN_INFORMATION_PLAN.md` §10 for redaction-specific open items:
the reveal high-water mark's storage shape, the `get_game_state`
implementation-language question, and whether `game_state_meta` subsumes
`0019_public_game_state_visible.sql`'s fix.)
