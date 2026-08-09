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
      `END_TURN` implemented, `MOVE_UNIT`/`PLAY_CARD` stubbed.
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
      `src/engine/cliffs.ts`). Terrain *movement* rules beyond that
      (pathing, move costs) still need `MOVE_UNIT` itself (section 2).
- [ ] Specify turn structure and any per-phase rules (draw, action limits,
      combat resolution, etc.) — mostly done (`src/engine/round.ts`), but
      see `todo.md` #4/#5 for two new rules (elimination, multi-card
      decline) still needing design decisions before they can be built.
- [ ] Capture all of the above as the source of truth the engine work in
      section 2 implements against (update `src/content/*.json` +
      schemas, and/or a rules reference doc).

## 2. Implement the rules engine

- [ ] Implement `MOVE_UNIT` in `applyAction()`, including terrain/cliff
      movement restrictions.
- [ ] Implement `PLAY_CARD` and each card's effect.
- [ ] Implement remaining unit actions (attack, transform, trade, etc.
      per unit kind).
- [ ] Implement win-condition checking and game-end handling.
- [ ] Implement board generation/drafting at game start; wire it into
      `startGame()`.
- [ ] Expand the unit test suite in `src/engine/__tests__/` to cover
      every action and edge case as it's implemented.

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
