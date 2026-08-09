# Rise & Fall — Project Plan

A general roadmap for taking Rise & Fall from its current scaffold to a
playable game. This is a living document — check items off or revise as
decisions get made.

## Status legend

- [x] Done
- [ ] Not started / in progress

## 0. Foundations (done)

- [x] Repo scaffold: Vite + React + TypeScript, Tailwind CSS v4.
- [x] Rules engine skeleton (`src/engine/`) — types, `applyAction()` with
      `END_TURN` implemented, `MOVE_UNIT`/`PLAY_CARD` originally stubbed
      (since superseded — see sections 1 and 2 below: movement is now
      implemented as one of `RESOLVE_UNIT_ACTION`'s per-kind actions rather
      than a standalone `MOVE_UNIT` action type, and `PLAY_CARD` was split
      into `CHOOSE_CARD` + `RESOLVE_UNIT_ACTION`).
- [x] Supabase schema + Row Level Security for `games` / `players` /
      `game_state`.
- [x] Supabase client, Discord OAuth sign-in/out, `useAuth()` hook,
      opt-in guest sign-in for testing.
- [x] Lobby: create game (pick play mode), join by room code, live
      player list via Realtime, host-gated "start game".
- [x] Placeholder in-game board view (hardcoded hex board) confirming the
      engine → UI data path.
- [x] Editable content JSON for units and terrain (`src/content/`).
- [x] CI workflow + Vercel deploy config.

## 1. Nail down the full ruleset

- [x] Document exact win conditions. Most total VP wins (achievements +
      board-count + terrain-control), no tiebreaker; game ends once
      `achievements.json`'s `gameLength` target has been claimed and the
      round in progress finishes. See `src/content/README.md`'s
      `achievements.json` section and `src/engine/victoryPoints.ts`. (The
      real per-unit/per-terrain/per-achievement VP *numbers* are still
      placeholders — the rule itself is settled.)
- [ ] Finalize the full unit list: stats, abilities, and the six unit
      kinds' special actions/transformations (e.g. merchant transform,
      ship trade — already partially defined in `src/content/units.json`).
- [ ] Finalize the full card list and each card's effect.
- [x] Cliff definition: a hexside is a cliff if the two hexes' terrain
      elevation `level` differs by more than 1 (`src/content/terrain.json`,
      `src/engine/cliffs.ts`). Terrain *movement* — which terrains a unit
      may step onto, cliff-crossing, and how other units' presence gates
      passing through vs landing — is implemented per-unit via
      `movement.terrains`/`canCrossCliffs`/`blockedByUnits`/
      `canEndMoveOnUnitTypes` in `content/units.json`; see the `move` action
      in section 2.
- [ ] Specify turn structure and any per-phase rules (draw, action limits,
      combat resolution, etc.) — mostly done (`src/engine/round.ts`,
      including player elimination — see `todo.md` #4). Still open: the
      multi-card decline rule (`todo.md` #5), blocked on achievement-claim
      tracking, same as the win-condition wiring above.
- [ ] Capture all of the above as the source of truth the engine work in
      section 2 implements against (update `src/content/*.json` +
      schemas, and/or a rules reference doc).

## 2. Implement the rules engine

- [x] Implement movement, including terrain/cliff movement restrictions.
      Movement is an action like any other (per ruling — see `UnitActions.
      md`'s resolved questions #5): every mobile unit kind's card has a
      `move` action, resolved through `RESOLVE_UNIT_ACTION` same as
      create/transform/income/etc. — but unlike those, `move` acts on only
      the one unit named in `targets`, not every unit of the kind
      (`applyMove()` in `src/engine/unitActions.ts`). A breadth-first search
      (`legalMoveDestinations` in `src/engine/movement.ts`) computes every
      hex a unit may legally move to, honoring `movement.terrains`,
      cliff-crossing (`canCrossCliffs`), and — as two independent checks —
      `blockedByUnits` (passing through a hex) and `canEndMoveOnUnitTypes`
      (landing on an occupied hex). `moveDistance` is either a finite
      integer or the `'unlimited'` sentinel (Ship): an unbounded BFS
      restricted to `terrains: ['water']` naturally stays within a ship's
      connected water region without a distance cap, satisfying "movement
      allowance is infinity but can't leave its water region."
- [x] Implement each unit's actions (all 26, across the 6 kinds — create/
      transform/convert/income/produce/trade/trade-resource/move).
      `RESOLVE_UNIT_ACTION` carries `actionId` + per-unit `targets` and
      applies the chosen action to every unit of that kind the player
      controls (except `move` — see above), via `applyUnitActionEffect()`
      in `src/engine/unitActions.ts`. A handful of actions' designs rested
      on an assumption that needed confirming — all now resolved, see
      `UnitActions.md`'s "Resolved questions" at the repo root.
- [x] Real per-unit-kind unit limits, board-count/terrain-control/
      achievement VP scoring, elimination, resource tracking, and movement
      are all implemented (see `todo.md`) — what's left in this section is
      win-condition wiring and board generation.
- [ ] Implement win-condition checking and game-end handling.
- [ ] Implement board generation/drafting at game start; wire it into
      `startGame()`.
- [x] Expand the unit test suite in `src/engine/__tests__/` to cover
      every action and edge case as it's implemented — 151 tests, including
      a pass against the real `content/*.json` files, not just synthetic
      fixtures.

## 3. Build the real game UI

- [ ] Replace the placeholder board with real tile rendering driven by
      `src/content/terrain.json` and the generated board.
- [ ] Unit sprites/icons and per-tile unit rendering.
- [ ] Interaction: select a unit → highlight legal moves/targets; select
      a card → highlight legal targets.
- [ ] Hand-of-cards UI.
- [ ] Action log / game history display.
- [ ] Turn/phase indicator and end-turn controls.
- [ ] Win/loss end-of-game screen.

## 4. Play-mode specific work

- [ ] **Live:** verify Realtime sync feels immediate across multiple
      clients; handle reconnect/out-of-sync edge cases.
- [ ] **Async ("play by turn"):** build "your turn" notifications
      (email and/or push) — currently a stubbed TODO.
- [ ] **Hotseat:** decide the identity/turn-switching approach (see the
      tradeoff already written up in `README.md` — re-authenticate each
      turn vs. pre-authenticate once and switch sessions in-app) and
      implement it.

## 5. Polish and hardening

- [ ] Error/edge-case handling across lobby and game flows (disconnects,
      invalid moves, stale state).
- [ ] Mobile/responsive pass on the board and UI.
- [ ] Accessibility pass (keyboard navigation, contrast, focus states).
- [ ] Playtest with the intended friend group; collect feedback.
- [ ] Fix bugs and rebalance rules/cards based on playtest results.

## 6. Launch

- [ ] Final Supabase + Discord OAuth setup walkthrough with real
      production URLs.
- [ ] Deploy to Vercel production.
- [ ] Share with the friend group and start real games.

---

## Open decisions blocking progress

These need answers before the corresponding section above can move:

1. **Full rules/cards/units spec** (blocks section 1 → 2) — this is the
   single biggest unblock; everything else in the engine and UI depends
   on it.
2. **Hotseat identity approach** (blocks part of section 4) — README
   currently recommends "pre-authenticate once, switch in-app," but it's
   not yet decided.
