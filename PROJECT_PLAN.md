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
      (since superseded — see sections 1 and 2 below: movement is now a
      normal `move` action resolved through `RESOLVE_UNIT_ACTION`, not a
      standalone `MOVE_UNIT` action type, and `PLAY_CARD` was split into
      `CHOOSE_CARD` + `RESOLVE_UNIT_ACTION`).
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
      board-count + terrain-control + gold), no tiebreaker; game ends once
      `achievements.json`'s `gameLength` target has been claimed and the
      round in progress finishes. See `src/content/README.md`'s
      `achievements.json` section and `src/engine/victoryPoints.ts`. The
      real per-unit/per-terrain/per-achievement/per-gold VP numbers are
      all filled in (see `todo.md` #41/#42/#52).
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
- [x] Specify turn structure and any per-phase rules (draw, action limits,
      combat resolution, etc.) — `src/engine/round.ts`, including player
      elimination (`todo.md` #4) and multi-card decline (`todo.md` #5, once
      blocked on achievement-claim tracking, now resolved alongside the
      win-condition wiring below).
- [ ] Capture all of the above as the source of truth the engine work in
      section 2 implements against (update `src/content/*.json` +
      schemas, and/or a rules reference doc).

## 2. Implement the rules engine

- [x] Implement movement, including terrain/cliff movement restrictions.
      Movement is a normal action, no exceptions (per ruling — see
      `UnitActions.md`'s resolved questions #5): every mobile unit kind's
      card has a `move` action, chosen and resolved through
      `RESOLVE_UNIT_ACTION` exactly like create/transform/income/etc. —
      `applyMove()` is just another case in `applyUnitActionEffect()`'s
      per-unit switch (`src/engine/unitActions.ts`), no special-casing.
      Each acting unit moves to its own target hex (`targets[unit.id]`,
      same per-unit-target shape as create/transform/convert). A
      breadth-first search (`legalMoveDestinations` in
      `src/engine/movement.ts`) computes every hex a unit may legally move
      to, honoring `movement.terrains`, cliff-crossing (`canCrossCliffs`),
      and — as two independent checks — `blockedByUnits` (passing through a
      hex) and `canEndMoveOnUnitTypes` (landing on an occupied hex).
      `moveDistance` is either a finite integer or the `'unlimited'`
      sentinel (Ship): an unbounded BFS restricted to `terrains: ['water']`
      naturally stays within a ship's connected water region without a
      distance cap, satisfying "movement allowance is infinity but can't
      leave its water region."
- [x] Implement each unit's actions (all 26, across the 6 kinds — create/
      transform/convert/income/produce/trade/trade-resource/move).
      `RESOLVE_UNIT_ACTION` carries `actionId` + per-unit `targets` and
      applies the chosen action to every unit of that kind the player
      controls, via `applyUnitActionEffect()` in `src/engine/unitActions.ts`.
      A handful of actions' designs rested on an assumption that needed
      confirming — all now resolved, see `UnitActions.md`'s "Resolved
      questions" at the repo root.
- [x] Real per-unit-kind unit limits, board-count/terrain-control/
      achievement VP scoring, elimination, resource tracking, movement, and
      win-condition/purchase/multi-decline wiring are all implemented (see
      `todo.md`) — what's left in this section is real board generation.
- [x] Implement win-condition checking and game-end handling. Achievement
      claims are now tracked (`GameState.claimedByAchievementId`, populated
      by `updateAchievementClaims()` in `src/engine/achievements.ts` after
      every `RESOLVE_UNIT_ACTION`) — `finishRound()` (`src/engine/round.ts`)
      checks the total against `achievementContent.gameLength` and, once
      met, sums all four VP sources (`sumVP` in
      `src/engine/victoryPoints.ts`) and sets `status: 'completed'` +
      `winnerPlayerIds` instead of starting the next round. Also unblocked
      `PURCHASE_CARD` (`applyPurchaseCard` in `src/engine/applyAction.ts`,
      cost via `calculatePurchaseCost()`) and multi-card decline
      (`beginDeclinePhase` now sizes each player's required decline count
      off `achievementsClaimedThisRound`) — see `todo.md` #2/#3/#5. The VP
      numbers are real (see `todo.md` #41/#42/#52) and real board
      generation is implemented below — the win-condition logic itself is
      complete and tested.
- [ ] Implement board generation/drafting at game start; wire it into
      `startGame()`. The rules are settled — not just the tile shapes/
      quantities in `content/terrain.json`, but the full procedure (seed
      the starting water tiles, then place the rest tier by tier in player
      order with no territory concept, each tile only placeable where it
      fully covers the tier directly below it, moving already-placed
      uncovered tiles if there's no space, then a unit-placement
      sub-phase) — see `src/content/README.md`'s "Board generation"
      section and `todo.md` #7.
      - [x] The deterministic half: `src/engine/boardGeneration.ts` has
            shape rotation (`rotateShape`/`placedShapeCells`), placement
            legality/covering (`isLegalTilePlacement`/`applyTilePlacement`),
            and the automatic starting-water-tile seeding
            (`seedStartingWaterTiles`).
      - [x] The interactive placement phase: a new `GameStatus`
            (`'boardSetup'`, sitting between `lobby` and `active`) and
            `GameState.boardSetup` track progress; new `PLACE_TILE`/
            `PLACE_UNIT` actions (`src/engine/actions.ts`,
            dispatched from `applyAction()` ahead of its normal
            `status: 'active'` guard) are implemented in
            `src/engine/boardSetup.ts` — `beginBoardSetup()` for the
            `lobby` -> `boardSetup` transition, `placeTile()`/
            `placeUnit()` for the two actions themselves, cycling turn
            order (a wrapping index, since tile pools don't divide evenly
            by player count), advancing tiers, and auto-transitioning
            tiles -> units -> `active` + round 1.
      - [x] `createGame.ts`'s `startGame()` is wired to the real
            procedure — it validates `lobby` status then delegates
            straight to `beginBoardSetup()` (status becomes
            `boardSetup`, not `active`); the old hardcoded placeholder
            unit trio is gone from production code.
      - [x] A first UI: `LobbyPage.tsx`'s "start game" now calls the real
            `createNewGame()`/`startGame()` and persists the result to a
            new `game_state` table row; `GamePage.tsx` renders the new
            `BoardSetupView`/`HexBoard` components (click/rotate/confirm
            tile placement, click-to-place starting units) over a real
            SVG hex grid. Not yet verified end-to-end against a live
            Supabase project (no credentials/Docker in the build
            sandbox) — typecheck/lint/tests/build all pass.
      - [x] The round cycle also has a UI now: `src/components/RoundView.tsx`
            renders once `GameState.status` is `'active'` — select-cards,
            actions (with per-unit target selection on the board, driven
            by a new `src/engine/actionTargeting.ts`), decline, and
            purchase, plus a `'completed'` winner banner. Also not yet
            click-tested end-to-end against a live Supabase project.
      - [x] Rule 4 (no-space), simplified per ruling: rather than the
            original "relocate a minimal set of already-placed tiles"
            search, `placeTile()` now just rejects a placement outright if
            it would leave nowhere left for the tier's own remaining tiles
            to legally go (`canPlaceRemainingTiles()` in
            `src/engine/boardGeneration.ts`, a greedy check across *all*
            remaining tiles, not just the next one — see `todo.md` #43).
      - [x] Once a tier's remaining tiles have only one possible legal
            arrangement left, they're auto-placed instead of making players
            confirm a foregone conclusion (`findForcedPlacement()` in
            `src/engine/boardGeneration.ts`,
            `applyActionAndFastForwardTiles()` in
            `src/engine/applyAction.ts` — see `todo.md` #44).
      - [x] Two extra rules for Water's own expansion tiles (the one tier
            that can land on untiled holes at all): a new Sea tile must
            touch at least 2 existing Sea tiles, and can never seal off an
            area of empty hexes with no way out
            (`touchesEnoughExistingTerrain()`/`wouldEncloseEmptyHexes()`
            in `src/engine/boardGeneration.ts` — see `todo.md` #45).
- [x] Expand the unit test suite in `src/engine/__tests__/` to cover
      every action and edge case as it's implemented — 220 tests, including
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
- [x] Win/loss end-of-game screen — `EndGameView.tsx`: every player
      ranked by total VP, with the achievements/board-count/terrain-
      control/gold breakdown and winner(s) highlighted (`todo.md` #53).

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

## 7. Guilds & Tales variants

- [ ] Implement the rulebook's two variants (Guilds: 24 cards; Tales: 23
      numbered elements), plus a house-rule Shared Guild mode (one Guild
      card chosen at setup, applying to every player, instead of one dealt
      per player). Full design, card-by-card catalog, and phased roadmap
      in `VARIANTS_PLAN.md`. Not started.

---

## Open decisions blocking progress

These need answers before the corresponding section above can move:

1. **Full rules/cards/units spec** (blocks section 1 → 2) — this is the
   single biggest unblock; everything else in the engine and UI depends
   on it.
2. **Hotseat identity approach** (blocks part of section 4) — README
   currently recommends "pre-authenticate once, switch in-app," but it's
   not yet decided.
