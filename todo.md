# TODO

Open items surfaced while implementing the card-play and decline rules in
`src/engine/`. Each one currently blocks a specific piece of the engine from
being finished — the code has a clearly marked placeholder or stub at each
spot below until the real rule is provided.

## 1. Real per-unit-kind unit limits — done

Decline rule 1 says every unit kind has a limit, per player, that triggers
decline once reached. Real values now in `src/content/units.json`'s
`supply.byPlayerCount` (8 Cities, 3 Temples, 8 Nomads, 6 Merchants, 3
Mountaineers, 5 Ships — same across every player count), which turned out
to be exactly the concept this item was asking about.

`getUnitLimit()`/`isDeclineTriggered()` (`src/engine/decline.ts`) now read
`GameState.unitLimits`, set once at game creation via `createNewGame`'s
`unitLimits` param (`src/engine/createGame.ts`) — the caller resolves it
from `units.json`, same pattern as `resourceBank`. Defaults to `{}` (no
limits) if omitted, so existing callers/tests are unaffected. Tested in
`src/engine/__tests__/decline.test.ts`.

## 2. Purchase-phase cost formula — done

Round step 4 lets a player buy a card back from decline, at a gold cost
"determined by the number of achievements achieved by players." The
formula was already implemented (`calculatePurchaseCost()` in
`src/engine/purchaseCost.ts`, reading `content/achievements.json`'s
`purchaseCost.byAchievementCount`) — what blocked `PURCHASE_CARD` itself was
that `GameState` didn't track claimed achievements, so "achievements
claimed so far" had nothing to read.

Resolved by adding achievement-claim tracking: `GameState.
claimedByAchievementId: Record<string, string>` (achievement id -> claiming
player id) and `GameState.achievementsClaimedThisRound: number` (see #5)
in `src/engine/types.ts`, populated by `updateAchievementClaims()`
(`src/engine/achievements.ts`) — for each achievement not yet claimed,
checks whether any non-eliminated player now holds their full per-player
supply of the tied unit kind (reuses `UnitContent.unitSupplyCaps`, the same
values already used elsewhere — no new content needed for the cap itself),
and the first to qualify claims it, permanently. Called from
`applyResolveUnitAction` (`src/engine/applyAction.ts`) after every
`RESOLVE_UNIT_ACTION`, since create/convert/a destroySelf transform are the
only things that can change a player's unit count for a kind.

`PURCHASE_CARD` is now `applyPurchaseCard()` in `src/engine/applyAction.ts`:
validates the card is in that player's `decline`, computes the cost from
`Object.keys(state.claimedByAchievementId).length`, spends the gold (bank
gains it back, same as any other cost), and moves the card to `hand`
(re-synced to `supply` instead if the player currently has no unit of that
kind — same rule 5/6 logic every other card move already respects). New
`AchievementContent` bundle (`src/engine/achievementContent.ts`, mirroring
`UnitContent`'s pattern) threads `purchaseCostTable` (and the other
achievement/VP content — see #3) through `applyAction()`'s new optional
`achievementContent` param. Tested in `src/engine/__tests__/round.test.ts`.

## 3. Game-end / win condition — done

Round step 6 checks whether the game has ended. `finishRound()`
(`src/engine/round.ts`) now checks it for real: once
`achievementContent.gameLength` total achievements have been claimed
(`Object.keys(state.claimedByAchievementId).length`, see #2), the round in
progress (which just finished) ends the game — `sumVP()` combines
`calculateAchievementVP`/`calculateBoardCountVP`/`calculateTerrainControlVP`
and `determineWinners()` picks whoever has the most total VP among
non-eliminated players (no tiebreaker — a tie is a shared win), setting
`status: 'completed'` and `winnerPlayerIds`. `finishRound()` takes a new
optional `achievementContent: AchievementContent` param (default
`EMPTY_ACHIEVEMENT_CONTENT`, `gameLength: Infinity`, so a caller that
doesn't supply it keeps the old always-continue behavior).

`AchievementContent` (`src/engine/achievementContent.ts`) bundles
everything the win check needs: `gameLength`, `achievementVictoryPoints`,
plus `unitBoardCountVP`/`terrainVictoryPoints`/`terrainScoresAs` for the
other two VP sources — resolved by the caller from `content/achievements.
json`/`units.json`/`terrain.json`, same content-agnostic convention as
`UnitContent`.

Still a real caveat, not blocking but worth flagging: `calculateBoardCountVP`
and `calculateTerrainControlVP` will only ever score their placeholder/empty
inputs meaningfully once the real per-unit/per-terrain VP numbers are filled
in and real board generation exists (`PROJECT_PLAN.md` section 2/3) — the
win-condition *logic* is complete and tested, but until then a finished game
is decided almost entirely by achievement VP. Tested end-to-end in
`src/engine/__tests__/round.test.ts` (game ends at the target, doesn't end
below it, ties/VP summing) and via `src/engine/__tests__/achievements.test.ts`
for the claim-detection piece.

## 4. Player elimination — done

Rule: if a player has to play a card — choosing one in the select-cards
phase, or giving one up in the decline phase — and has none available
(empty hand for select-cards; empty hand *and* discard for decline),
they're eliminated: removed from the board and turn order for the rest of
the game, excluded from winning, all their gold/wood/stone returned to the
bank. Achievements they've already claimed are NOT revoked.

Implemented in `src/engine/elimination.ts` (`eliminatePlayer`,
`eliminatePlayersWithNoCardToPlay`, `eliminatePlayersWithNoCardToDecline`),
wired into `beginSelectCardsPhase`/`beginDeclinePhase`
(`src/engine/round.ts`) and cascading after each `MOVE_TO_DECLINE`
(`src/engine/applyAction.ts`). `Player.eliminated: boolean` and
`Player.resources`/`GameState.resourceBank` (see `src/content/resources.
json`) added to `src/engine/types.ts`. Tested, including end-to-end via
`applyAction` and the resource-return.

`determineWinners`'s explicit `playerIds` param (`src/engine/victoryPoints.ts`)
— taken rather than deriving player ids from the VP map — is exactly what
let `finishRound()` (see #3) pass only non-eliminated players:
`state.players.filter(p => !p.eliminated).map(p => p.id)`.

## 5. Multi-card decline — done

Rule: when the decline phase triggers, a player may need to decline more
than one card — specifically, if more than 1 achievement was claimed
*during that round*. This was blocked on the same gap as #2/#3 (nothing
tracked achievement claims), now resolved by `GameState.
achievementsClaimedThisRound: number` — incremented by
`updateAchievementClaims()` (see #2) every time an achievement is newly
claimed, and reset to 0 at the start of every round
(`beginSelectCardsPhase`, `src/engine/round.ts`).

`beginDeclinePhase` now computes `cardsPerPlayer = Math.max(1,
achievementsClaimedThisRound)` — every pending player owes that many cards
this phase, not just whoever claimed the achievement(s).

Per ruling, decline is **simultaneous**, like select-cards — not turn
order, contrary to what the round-3 doc comments originally assumed.
`beginDeclinePhase` now sets `activePlayerId: null` throughout the phase
(same as select-cards), and `applyMoveToDecline`
(`src/engine/applyAction.ts`) checks `pendingPlayerIds.includes(playerId)`
rather than `pendingPlayerIds[0] === playerId` — any pending player may
move a card into decline at any time, in any order relative to the others.
A player who owes more than one card still appears more than once in
`pendingPlayerIds` (repeating their id that many times), but each
`MOVE_TO_DECLINE` now removes just the one occurrence being fulfilled
(`removeOneOccurrence()`), not necessarily the front of the queue —
they remain pending, and may act again whenever they choose, until every
occurrence is gone. `eliminatePlayersWithNoCardToDecline`
(`src/engine/elimination.ts`) was rewritten to match: instead of cascading
through `activePlayerId` one at a time, it checks every currently-pending
player independently (same pattern as `eliminatePlayersWithNoCardToPlay`
for select-cards) — still re-run after each `MOVE_TO_DECLINE`, so a player
who runs out of cards partway through their required count is caught and
eliminated. Tested end-to-end in `src/engine/__tests__/round.test.ts` and
`src/engine/__tests__/elimination.test.ts`.

## 6. Movement timing/frequency — done

Resolved: movement is a normal action, with no exceptions. Every mobile
unit kind's card has a `move` action in its `actions` list, chosen and
resolved through `RESOLVE_UNIT_ACTION` exactly like create/transform/
income/etc. — same per-unit `targets` shape, same "applies independently to
every acting unit" semantics. Only units of the kind matching the card
played can move that turn (a Ship card activation can't move a Nomad).

Implemented as a `move` action entry on every mobile unit kind in
`units.json` (`MoveEffect` in `src/engine/unitContent.ts`), handled by
`applyMove()` — just another case in `applyUnitActionEffect()`'s per-unit
switch in `src/engine/unitActions.ts`, no special-casing needed. Each
acting unit moves to its own target hex (`targets[unit.id]`); a unit with
no target, or an illegal one (per `legalMoveDestinations()`,
`src/engine/movement.ts` — a BFS respecting terrain restrictions,
cliff-crossing, and the pass-through (`blockedByUnits`) vs. land-on
(`canEndMoveOnUnitTypes`) distinction, plus Ship's "infinite range, but
can't leave its water region" rule via `moveDistance: "unlimited"` bounded
implicitly by `terrains: ["water"]`), simply does nothing that turn — the
rest still act. There is no standalone `MOVE_UNIT` action type — see
`UnitActions.md`'s resolved questions #5.

## 7. Board generation — rules settled, implementation still open

Rule: the first phase of a game builds the map, then places starting
units, in four parts.

1. Seed the board with `content/terrain.json`'s water `initial` shapeGroup
   (the 8-hex "hourglass", rows of 3-2-3) — one tile per player. For 2
   players, the two hourglasses interlock along one tile's
   `{q:2,r:0}`/`{q:1,r:1}`/`{q:1,r:2}` edge, offset by `(dq:2, dr:1)` —
   the second tile sits one row lower than the first, not at the same
   height. For 3 players, three tiles chain together the same way,
   pairwise. For 4 players, it's two separate 2-player pairs, not one
   chain of 4.
2. Then, in player turn order, each player places one tile per turn,
   working through the full terrain hierarchy in order — every remaining
   water tile (the `expansion` shapeGroup's 7-hex "flower"), then every
   plain tile (6-hex "wedge"), then forest (4-hex "rhombus"), then
   mountain (3-hex triangle), then glacier (2-hex domino) — fully
   exhausting each tier's `limits.byPlayerCount` supply before the next
   tier starts. Quantities: 12/10/8/6/2 (2p), 15/14/11/8/3 (3p),
   19/17/15/11/4 (4p), following that same hierarchy order. There's no
   concept of a player's own territory — any player may place their tile
   anywhere on the board that's legal, not just near their own stuff.
3. Placement rule: a tile may only be placed where every hex it covers is
   *currently* the one terrain type directly below it in the hierarchy
   (`placesOn` — e.g. every hex a Plain tile covers must currently be
   Water). Covering a mix of terrains, or any not-yet-tiled "hole", is
   illegal. Placing it converts every covered hex to the new terrain —
   this is why each tier's supply is smaller than the one below: a tier
   can only ever claim part of the area the tier beneath it covers, so
   the map's usable area narrows as it rises in elevation, visibly
   matching the existing `level` 0-4 elevation/cliff system.
4. No-space rule: if a tile can't legally be placed anywhere (not enough
   contiguous space of the correct lower tier), one or more already-placed
   tiles must be *moved* elsewhere (re-placed following the same rule 3)
   to open up room — using the fewest tiles moved that makes the pending
   placement legal. Confirmed: only a currently-uncovered tile (nothing
   placed on top of any of its hexes) is eligible to be moved — a tile
   buried under a higher tier can't be moved at all (not even as part of
   a cascade), so the search for which tiles to move only ever considers
   the board's current topmost tiles.
5. Once every tile is placed, a new starting player is chosen. Starting
   with them, in turn order, each player places one of their three
   starting units — one City, one Nomad, one Ship, in their own color,
   choosing which of the three to place each turn (so this repeats around
   the table until everyone has placed all three). City and Nomad may be
   placed anywhere except Glacier; Ship only on Water. Placing a unit
   moves its matching card into the owning player's hand — already handled
   generically by the existing `syncCardZonesWithBoard()` rule 5/6 logic
   (`src/engine/cards.ts`), no new logic needed for that part. Once every
   player has placed all three units, round 1 begins for real.

All of this is recorded in `src/content/terrain.json` (shapes + per-tier
quantities) and `src/content/README.md`'s "Board generation" section.

**Implementation status:** the deterministic, non-interactive pieces are
now built in `src/engine/boardGeneration.ts` (tested in
`src/engine/__tests__/boardGeneration.test.ts`, 22 tests, including a pass
against the real `content/terrain.json` hourglass shape):
- `rotateShape()`/`placedShapeCells()` — rotate a shape's cells by 60° x n
  and resolve them to absolute board coordinates for a given anchor (rule
  1's rotation-on-placement).
- `isLegalTilePlacement()` — rule 3's covering check (`placesOn: null` =
  must be completely untiled hexes, e.g. water; `placesOn: [...]` = every
  covered hex must currently be exactly one of those terrains, no holes,
  no mixing) and `applyTilePlacement()` to actually cover them.
- `seedStartingWaterTiles()` — rule 1's automatic setup step (no player
  choice involved, so it's a plain pure function): places the starting
  hourglass tiles per player count, pairwise-interlocked via the
  `(dq:2, dr:1)` offset (2p: one pair; 3p: a chain of 3, the same offset
  applied cumulatively; 4p: two separate pairs). ASSUMPTION flagged in
  code (`STARTING_WATER_SECOND_PAIR_OFFSET`): how far apart the two pairs
  sit in the 4-player case isn't specified by the rules — chosen to be
  comfortably non-overlapping, not derived from anything.

**The interactive placement phase is now implemented too** (rules 2 and
5 — a player actually choosing where to place each tile/unit, turn by
turn). New `GameStatus` value `'boardSetup'` (`src/engine/types.ts`) sits
between `'lobby'` and `'active'`: the round cycle
(`selectCards`/`actions`/`decline`/`purchase`) doesn't start until it's
done. New `GameState.boardSetup: BoardSetupState | null` tracks progress
— `tileTierQueue`/`tilesRemainingInTier` for which tier is being placed
and how much of its pool is left, `tilePlacerIndex` for whose turn (a
plain wrapping index into `turnOrder`, not a draining queue, since tile
pools don't divide evenly by player count), then
`unitsRemainingByPlayerId`/`unitPlacerIndex` for the unit-placement
sub-phase once tiles are done.

`src/engine/boardSetup.ts`:
- `beginBoardSetup(state, content)` — the `lobby` -> `boardSetup`
  transition: seeds the starting water tiles and starts the tile queue
  at its first non-empty tier (skipping any with a 0 pool).
- `placeTile()`/`placeUnit()` — the two new actions' full validation
  (right status/sub-phase/turn, then legality via
  `isLegalTilePlacement()`/the City-Nomad-not-on-Glacier,
  Ship-only-on-Water, not-already-occupied rules) and application,
  returning the same `ActionResult` shape as every other action handler
  (moved to `src/engine/types.ts` so `boardSetup.ts` and `applyAction.ts`
  can share it without an import cycle). Advances the turn-cycling index,
  decrements the pool, skips to the next tier once one empties, and
  transitions tiles -> units -> `status: 'active'` + round 1's
  `beginSelectCardsPhase()` automatically as each stage completes.
  Placing a unit re-syncs card zones (`syncCardZonesWithBoard()`), so its
  card lands in hand automatically, same as everywhere else.
- New `PlaceTileAction`/`PlaceUnitAction` (`src/engine/actions.ts`) are
  dispatched from `applyAction()` *before* its normal
  `status !== 'active'` guard, since they're the only two actions valid
  during `boardSetup` — every other action still requires `active`.
  `applyAction()` gained a third optional content param,
  `boardGenerationContent: BoardGenerationContent`
  (`src/engine/boardGenerationContent.ts` — tile shapes/`placesOn`/pool
  sizes per tier, same content-agnostic pattern as `UnitContent`).

Tested in `src/engine/__tests__/boardSetup.test.ts` (20 tests: turn
cycling including an uneven pool, tier advancement, both sub-phase
transitions, all the placement-legality rejections, and a small pass
against real `content/terrain.json` shapes) plus two dispatch tests in
`applyAction.test.ts`.

**`createGame.ts`'s `startGame()` is now wired to the real procedure** —
it calls `beginBoardSetup()` directly (`status` becomes `'boardSetup'`,
not `'active'`; round 1 only starts once every player has placed all
three starting units via `PLACE_UNIT`). Its signature changed from
`startGame(state, startingPositions: Record<string, Coordinate>)` to
`startGame(state, boardGenerationContent: BoardGenerationContent)` — there's
no per-player starting coordinate in the real rules, units go anywhere
legal. The old hardcoded, non-real unit trio (kinds literally named
`'settlement'`/`'mobile-unit'`/`'ship'`) is gone from production code
entirely; where a test needed a quick fully-active game purely to
exercise round mechanics (not board setup itself), that placeholder logic
moved to a local, unexported test fixture
(`src/engine/__tests__/applyAction.test.ts`'s `makeActiveGame()`) rather
than living in `createGame.ts` — `round.test.ts`/`elimination.test.ts`/
`decline.test.ts` already had their own similar local fixtures and never
called `startGame()` at all, so they're unaffected.

**A first UI now exists** for board setup, per the click/rotate/confirm
design: `src/pages/LobbyPage.tsx`'s "start game" now calls
`createNewGame()`/`startGame()` for real (resolving
`BoardGenerationContent`/resources/unit limits from `content/*.json` via
the new `src/content/resolveContent.ts`) and persists the resulting
`GameState` into the `game_state` table (new functions in
`src/lib/gameApi.ts`: `insertGameState`/`getGameState`/`writeGameState`
— the last guarded by the row's `version` column for optimistic
concurrency — /`subscribeToGameState`). Note `games.status` itself stays
the coarse `lobby`/`active`/`completed` from the original schema — no
migration needed — the engine's finer `boardSetup`/`active` distinction
lives only inside the `game_state` row, and `GamePage.tsx` branches its
rendering on that. `src/pages/GamePage.tsx` now renders
`src/components/BoardSetupView.tsx` (tile-tier and starting-unit
sub-panels, turn-gated) over a new `src/components/HexBoard.tsx` (a real
pointy-top axial SVG hex grid — clickable, with a translucent
legal/illegal ghost-placement overlay) instead of the old fake
`BoardView.tsx` grid, which is deleted. Verified via `npx tsc -b`,
`npx oxlint src/`, `npx vitest run` (208 tests, none UI-specific), and
`npm run build`; **not** verified end-to-end in a browser against a real
Supabase project — this sandbox has no Supabase credentials or local
Docker to stand one up, so the actual click-through (join a lobby with
2+ browser tabs, start, place tiles/units in turn) still needs a manual
pass against a real deployment.

**Still not implemented:**
- Rule 4's no-space/move-tiles search — `placeTile()` currently just
  rejects an illegal placement outright; it doesn't detect "no legal
  placement exists anywhere" and prompt for a minimal tile rearrangement.
- The round cycle itself (`selectCards`/`actions`/`decline`/`purchase`)
  has no UI yet — once board setup finishes, `GamePage.tsx` falls back to
  a read-only board view with no way to actually play a round.
- Tile placement in the UI is confined to a padded rectangle around the
  board's current extent (`BoardSetupView.tsx`'s `paddedEmptyCoords`),
  not the fully unconstrained "anywhere on an infinite empty board" the
  engine allows — a deliberate scope cut (an infinite pan/zoom canvas
  felt like overkill for a first pass), not a rules gap.

Open questions once further work starts: whether "least tiles moved"
ties (multiple minimal-size rearrangements) need a tiebreak rule or are
just player choice; how the new starting player for unit placement is
actually chosen (currently just reuses `turnOrder[0]`, unconfirmed); and
what happens if a player somehow has no legal spot for a unit they must
place (mirrors the same open question for tiles).
