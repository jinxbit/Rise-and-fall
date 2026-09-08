# Rise & Fall — Project Plan

A general roadmap for taking Rise & Fall from its original scaffold to a
playable game. This is a living document — check items off or revise as
decisions get made.

**Where things stand:** the game is playable end to end and real games are
being played (several are checked in as replay fixtures — see
`src/test/fixtures/productionGames/`). Sections 0-4 are essentially done;
what's left is polish, the variants track, and the server-side read-path
work described in `HIDDEN_INFORMATION_PLAN.md`. Individual changes are
logged as numbered entries in `todo.md`.

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
- [x] Finalize the full unit list: stats, abilities, and the six unit
      kinds' special actions/transformations. All six kinds and all 27
      base actions are defined in `src/content/units.json` and implemented
      in `src/engine/unitActions.ts` — see `UnitActions.md` for the
      per-action checklist and the rulings behind it. Tales add six more
      on top (section 7).
- [x] Finalize the full card list and each card's effect. There is no
      separate card list: a card *is* a unit kind (one Civilization card
      per kind, `UNIT_KINDS` in `src/engine/cards.ts`), and its effects are
      that kind's `actions` in `units.json`. Tale-contributed companion
      pieces deliberately have no card of their own.
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
- [x] Capture all of the above as the source of truth the engine work in
      section 2 implements against — `src/content/*.json` + their schemas
      are that source of truth, and `src/content/README.md` is the prose
      rules reference explaining every field and which engine module
      implements it.

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
- [x] Implement each unit's actions (all 27, across the 6 kinds — create/
      transform/convert/income/produce/trade/trade-resource/move).
      `RESOLVE_UNIT_ACTION` carries `actionId` + per-unit `targets` and
      applies the chosen action to every unit of that kind the player
      controls, via `applyUnitActionEffect()` in `src/engine/unitActions.ts`.
      A handful of actions' designs rested on an assumption that needed
      confirming — all now resolved, see `UnitActions.md`'s "Resolved
      questions" at the repo root.
- [x] Real per-unit-kind unit limits, board-count/terrain-control/
      achievement VP scoring, elimination, resource tracking, movement,
      win-condition/purchase/multi-decline wiring and board generation are
      all implemented (see `todo.md`). Since then the engine also gained
      event-sourced undo/redo and history review (`todo.md` #14/#70), the
      Tales variant hooks (section 7), and concede/admin-mode handling.
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
- [x] Implement board generation/drafting at game start; wire it into
      `startGame()` (done — every sub-item below is complete). The rules
      are settled — not just the tile shapes/
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
            `src/engine/boardGeneration.ts`, folded into `applyAction()`'s
            own forced-follow-up convergence in
            `src/engine/applyAction.ts` — see `todo.md` #44, and
            `RULE_ENFORCEMENT_PLAN.md` §4.2, which later replaced the
            separate `applyActionAndFastForwardTiles()` wrapper).
      - [x] Two extra rules for Water's own expansion tiles (the one tier
            that can land on untiled holes at all): a new Sea tile must
            touch at least 2 existing Sea tiles, and can never seal off an
            area of empty hexes with no way out
            (`touchesEnoughExistingTerrain()`/`wouldEncloseEmptyHexes()`
            in `src/engine/boardGeneration.ts` — see `todo.md` #45).
- [x] Expand the unit test suite in `src/engine/__tests__/` to cover
      every action and edge case as it's implemented — the suite is now
      1118 tests across 61 files, including passes against the real
      `content/*.json` files rather than only synthetic fixtures, and full
      games replayed through the real Edge Functions.
- [x] Skip board building entirely when the players want to: map templates
      (`content/mapTemplates.json`), a saved-map pool
      (`map_pool`, `0016_map_pool.sql`) with a random pick at start, and a
      "build alone" mode where one player lays every tile.

## 3. Build the real game UI

- [x] Replace the placeholder board with real tile rendering driven by
      `src/content/terrain.json` and the generated board — `HexBoard.tsx`,
      a pointy-top axial SVG grid with per-terrain fills and cliff hexsides
      drawn as thick black edges (`todo.md` #20).
- [x] Unit sprites/icons and per-tile unit rendering — pictogram markers on
      a neutral plate with a player-colour bar, stacked when a hex holds
      more than one unit (`todo.md` #26/#27/#28/#58), with per-player
      colour overrides in profile settings.
- [x] Interaction: select a unit → highlight legal moves/targets; select
      an action → highlight legal targets. Driven by
      `src/engine/actionTargeting.ts` plus `legalMoveDestinations()`, with
      a radial action menu that disables actions the unit can't actually
      take (`todo.md` #15/#17/#22).
- [x] Hand-of-cards UI — `RoundView.tsx`'s select-cards panel, plus a
      per-player status strip showing hand, played, decline and discard
      zones.
- [x] Action log / game history display — `src/engine/gameLog.ts` narrates
      every action; `RoundView.tsx`'s scrollable log panel renders it, and
      "Review history"/"Show history" step back through the game action by
      action and turn by turn (`todo.md` #68/#69).
- [x] Turn/phase indicator and end-turn controls — phase banner, pending-
      player highlighting, and a Pass button (turns also end automatically
      once every unit has acted, `todo.md` #19).
- [x] Win/loss end-of-game screen — `EndGameView.tsx`: every player
      ranked by total VP, with the achievements/board-count/terrain-
      control/gold breakdown and winner(s) highlighted (`todo.md` #53),
      plus per-player charts of score, spending and unit value over time.

## 4. Play-mode specific work

- [x] **Live:** Realtime pushes every `game_state` change to every client
      (`subscribeToGameState`/`subscribeToGame`/`subscribeToPlayers` in
      `gameApi.ts`). Out-of-sync writes are handled by the `version`
      compare-and-swap plus a transparent retry (`todo.md` #18), and stale
      screens refetch when a tab regains visibility
      (`useRefetchOnVisible`).
- [x] **Async ("play by turn"):** "your turn" notifications are built and
      sent server-side by Edge Functions, over Discord webhooks
      (`notify-discord-turn`) and Web Push (`notify-web-push`), so they
      fire with every tab closed. Setup for both is in `README.md`.
- [x] **Hotseat:** decided and built — neither of the two approaches
      `README.md` originally posed. One signed-in host seats several named
      local players under their own account
      (`0003_hotseat_local_players.sql`), and the app acts as whoever must
      move next behind a "pass the device" gate (skippable per game). See
      `README.md`'s hotseat section.
- [ ] Live-specific reconnect polish: nothing surfaces a dropped Realtime
      subscription today beyond the next manual refresh.

## 5. Polish and hardening

- [x] Error/edge-case handling across lobby and game flows — an error
      boundary and a shared error banner, friendly messages via
      `lib/errors.ts`, retry-on-conflict writes, JWT-expiry retry
      (`jwtRetryFetch.ts`), an illegal action rejected with the engine's
      own reason rather than silently consuming a unit's turn (`todo.md`
      #22), and room lifecycle/cancel handling.
- [x] Mobile/responsive pass on the board and UI — installable PWA, and the
      history bar/board reworked for small screens (`todo.md` #69). Worth
      revisiting as new panels land, but no longer an open gap.
- [ ] Accessibility pass (keyboard navigation, contrast, focus states) —
      still not started; the board is pointer-driven.
- [x] Playtest with the intended friend group; collect feedback — ongoing,
      and the source of most of `todo.md`. Finished games are exported and
      checked in as replay regression tests
      (`src/test/fixtures/productionGames/`).
- [x] Fix bugs and rebalance rules/cards based on playtest results —
      continuous; the real VP curves, costs and unit limits all came out of
      this (`todo.md` #41/#42/#51/#52).
- [ ] Server-side redaction of hidden information
      (`HIDDEN_INFORMATION_PLAN.md` phase 5) — redaction is implemented and
      tested but applied client-side, so a still-secret pick is hidden in
      the UI while present in the fetched row.

## 6. Launch

- [x] Final Supabase + Discord OAuth setup walkthrough with real
      production URLs — plus Google OAuth and email/password, all
      documented in `README.md`.
- [x] Deploy to Vercel production — `vercel.json`, Vercel Analytics, and
      an update banner when a newer build goes live (`vite.config.ts`'s
      `version.json` + `useAppUpdateAvailable`, issue #247).
      Supabase migrations and Edge Functions deploy from `main` via
      `.github/workflows/deploy-supabase.yml`.
- [x] Share with the friend group and start real games — real finished
      games are checked in as replay fixtures.

## 7. Guilds & Tales variants

- Full design, card-by-card catalog, and phased roadmap in
  `VARIANTS_PLAN.md`. Tales are opt-in per game
  (`GameState.activeTaleIds`), chosen at creation via `TaleSelector.tsx`,
  and a game with none active behaves exactly as it did before the variant
  existed.
- [x] Tales infrastructure: `applyTaleModifiers` merging Tale-contributed
      units/actions/movement onto resolved content, companion pieces
      (a unit with no card of its own, activated through another kind's
      card), Fantastic Events, Tale-contributed controllable structures as
      a fifth VP source, and the reusable effect machinery those needed
      (`src/engine/tales.ts`, `taleContent.ts`, `unitActions.ts`).
- [x] Five of the 23 Tale elements: The Capital (#4), The Majestic Bridge
      (#5), The Banks (#6), The Ports (#7), The Cathedral (#8) — see
      `src/content/tales.json`, and `todo.md` #61-#64 for the Ports and
      Capital work plus the shared infrastructure they drove out.
- [ ] The remaining 18 Tale elements (`VARIANTS_PLAN.md` §7, phase 2
      groups 1-3, the rest of 5, and 6-7).
- [ ] Tales UI polish and the Fantastic Event narration pass
      (`VARIANTS_PLAN.md` phase 3).
- [ ] The Guilds variant (24 cards) and the house-rule Shared Guild mode —
      not started (`VARIANTS_PLAN.md` phases 4-9).

---

## Open decisions blocking progress

Both of the original blockers are resolved: the full rules/units spec now
lives in `src/content/*.json` + `src/content/README.md` + `UnitActions.md`,
and hotseat identity was decided and built (section 4).

What's genuinely open:

1. **`get_game_state` as SQL RPC or Edge Function**
   (`HIDDEN_INFORMATION_PLAN.md` §10) — §5.3's reveal high-water mark needs
   a full engine replay, which plain SQL can't do. This blocks the
   read-side rewire in section 5.
2. **Whether to keep client-trusted games at all** once server-side
   enforcement has been played against for a while, or make
   `ruleEnforcementEnabled` the default and eventually the only path
   (`RULE_ENFORCEMENT_PLAN.md` §8 phase 8).
3. **Scope and timing of the Guilds track** — the Tales track is designed
   through phase 3 and only partly built; Guilds is a second, larger body
   of work that hasn't started (`VARIANTS_PLAN.md`).
