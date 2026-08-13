# Rise & Fall — Room Lifecycle & Visibility: Implementation Plan

Companion to `PROJECT_PLAN.md`/`todo.md`, same spirit as `VARIANTS_PLAN.md`.
Scopes the work described in issue #40 ("Online Game Room Specification")
against the app as it exists today.

Source: issue #40's full spec (13 sections — ownership, lifecycle states,
visibility, public listing, participants, configuration, readiness,
start/cancel/delete, extensibility). Not reproduced here; read the issue
for the authoritative wording. This doc maps that spec onto the current
schema/API and breaks it into phases that can land without breaking the
existing lobby/game flows.

## 0. Where this sits relative to the current app

Today `games` (`supabase/migrations/0001_init_schema.sql`) is a single
table with `status: 'lobby' | 'active' | 'completed'`
(`src/lib/dbTypes.ts:33`), joined only by room code
(`src/lib/gameApi.ts`'s `generateRoomCode`/`createGame`). There is no
public/private distinction, no observer role, no cancel/delete states, and
no config-change readiness system — every room today is effectively
"private, link/code-only," which already satisfies spec §4's Private Room
behavior by default.

This app is currently scoped as a private tool for a friend group
(`PROJECT_PLAN.md` §6 "Launch" — share with the friend group, not a public
matchmaking product), so **§5's Public Rooms discovery screen and the
public/private toggle are the least aligned parts of the spec with the
project's current direction** and should be treated as optional/deferred
until there's an actual product need for room discovery. Everything else
in the spec (explicit lifecycle states, observers, readiness) is a
reasonable evolution of the existing lobby regardless of that decision, so
the phases below are ordered to deliver those first and put
public/discovery last.

## 1. Gap analysis (spec section → current state)

1. **Ownership (§2)** — `games.created_by` already exists and is the de
   facto Owner; there's no permission-check layer yet (any seated player
   can currently call `setGameStatus`, `gameApi.ts:251`). Needs: gate
   Owner-only actions (cancel, delete, start, configure) server-side via
   RLS, not just client-side.
2. **Lifecycle states (§3)** — `status` only has `lobby | active |
   completed`. Missing `canceled` and `deleted` (or a soft-delete flag —
   see §4 below on why soft-delete is preferred). No state machine
   enforcement exists beyond the two `if (status !== 'lobby')` guards in
   `gameApi.ts:182,218`.
3. **Visibility (§4)** — doesn't exist. Every game is "private" (findable
   only by room code) today, which already matches the spec's Private Room
   semantics; a `visibility` column would just make that explicit and
   allow an opt-in Public mode later.
4. **Public Rooms screen (§5)** — doesn't exist; no screen queries "all
   games" today, only `myGamesView.ts` (games the current user is seated
   in). Deferred — see §0.
5. **Participants: Player vs Observer (§6)** — only Player exists
   (`players` table, seat-indexed, `src/lib/seatIndex.ts`). No Observer
   concept, no notion of a non-seated viewer.
6. **Game configuration (§7)** — `games.min_players`/`max_players` exist
   and are enforced (`gameApi.ts:182` region). `game_settings`
   (`supabase/migrations/0007_game_settings.sql`) already holds
   variant/achievement-count-style config (`activeTaleIds`, `gameLength`,
   `mapTemplateId`, etc. — see `GameSettings` in `dbTypes.ts`), so this
   part of the spec is largely *already implemented*, just without a
   version number.
7. **Pre-creation configuration (§8)** — already how `createGame` works:
   settings are chosen before the room exists (`gameApi.ts` `createGame`
   params). Matches spec as-is.
8. **Config-change readiness (§9)** — doesn't exist. No `ready` flag on
   `players`, no config-version column, no invalidation-on-change logic.
   This is the single biggest net-new subsystem in the spec.
9. **Starting the game (§10)** — `setGameStatus` flips `lobby → active`
   unconditionally; none of the readiness/min-players/max-players gating
   described in §10 is enforced server-side (`gameApi.ts:251`).
10. **Canceling (§11)** — no `canceled` state; nothing stops a lobby game
    from just being abandoned today.
11. **Deleting (§12)** — no delete path exists at all; `games` rows are
    permanent once created (only `on delete cascade` exists, for FK
    cleanup, not a user-facing action).
12. **Extensibility (§13)** — matches the project's existing direction
    (`game_settings` as a flexible settings blob, engine/UI layering in
    `PROJECT_PLAN.md`); no changes needed to honor this, just discipline
    going forward.

## 2. Design decisions for this codebase

1. **Soft-delete, not hard-delete.** Spec §12 says deleted rooms are
   "permanently removed" with "all data ... permanently removed." Given
   `game_state`/`players`/`game_settings` all cascade off `games.id`, a
   literal `delete from games` already achieves that via the existing FK
   cascades — no new cascade logic needed. Recommend implementing it as a
   real `delete`, gated by the same Owner + state check (`lobby` or
   `canceled` only), rather than inventing a `deleted` status value that
   then has to be filtered out of every query forever.
2. **`canceled` becomes a fourth `games.status` value** (`lobby | active |
   completed | canceled`), enforced via a Postgres `check` constraint
   update (new migration) plus a transition-validating trigger or RLS
   `with check` clause so `active → lobby` or `completed → anything` can't
   happen from the client.
3. **Readiness (§9) is the highest-value, highest-effort piece.** Needs:
   a `config_version int` on `games` (bumped on every settings change), a
   `ready_for_version int` (or boolean + version pair) on `players`,
   reset-to-not-ready on config write, and `startGame` gating on "every
   non-owner player's `ready_for_version = games.config_version`." This
   should land before touching visibility/discovery, since it's useful
   regardless of that decision and is the part of the spec with real
   gameplay-integrity value (players currently can get surprised by a
   config change with no acknowledgment step).
4. **Observers (§6) need a lightweight non-seat row** — not a `players`
   row (would collide with seat-index/min/max-player logic per spec's own
   "not counted toward limits" rule). Simplest fit: a new `observers`
   table (`game_id`, `user_id`, `joined_at`) with its own RLS, read access
   to `game_state` but no write access.

## 3. Phased roadmap

Ordered so each phase is independently useful and doesn't require the
later ones. Public discovery (Phase 4) is last and optional per §0.

- [ ] **Phase 1 — Explicit lifecycle + Owner-gated transitions.** Add
      `canceled` status, an owner-only cancel action, a delete action
      (hard delete via cascade, gated to `lobby`/`canceled`), and move
      `start`/`cancel`/`delete` permission checks into RLS (`with check
      (created_by = auth.uid())`) instead of trusting the client. Update
      `MyGamesPage.tsx` to show canceled games distinctly and exclude
      deleted ones (trivially true once the row is gone).
- [ ] **Phase 2 — Configuration versioning + readiness.** `config_version`
      on `games`, `ready`/`ready_for_version` on `players`, reset-on-change
      logic, `startGame` gating per spec §10. Lobby UI: Ready button,
      "waiting on N players" indicator, auto-unready banner when the owner
      changes settings.
- [ ] **Phase 3 — Observers.** New `observers` table + RLS, an
      observer-join path (distinct from seating), and a read-only game
      view for observer sessions in `GamePage.tsx`.
- [ ] **Phase 4 — Visibility + Public Rooms screen (optional/deferred).**
      `visibility` column, a real "all public games" query + RLS policy,
      and the grouped Public Rooms screen from spec §5. Only worth
      building if/when there's an actual need for room discovery beyond
      the friend group; revisit before starting.

Each phase is a normal `todo.md`-style entry once implemented — this doc
just scopes the work up front, the way `VARIANTS_PLAN.md` does for the
Guilds/Tales variants.
