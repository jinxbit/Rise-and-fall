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

**The round cycle now has a UI too**, beyond just board setup:
`src/components/RoundView.tsx` renders once `GameState.status` is
`'active'` — phase banner, per-player resource/hand-count strip, claimed
achievements, an event-log tail, and a phase-specific panel:
`selectCards` (pick a card from hand), `actions` (pick one of the chosen
card's unit-kind actions, then — for `create`/`convert`/an `adj`-location
`transform`/`move` — assign a target hex per acting unit by clicking the
board, reusing a shared `HexBoard`), `decline` (move a card from hand/
discard to decline, once per card owed), `purchase` (buy a card back
from decline for gold, or pass). A `'completed'` status shows a winner
banner. Legal-target highlighting for the `actions` phase is driven by a
new `src/engine/actionTargeting.ts` (`legalCreateTargets`/
`legalTransformTargets`/`legalConvertTargets`, tested in
`actionTargeting.test.ts`) built from small predicates now exported from
`unitActions.ts` (`isAdjacent`/`crossesCliff`/`unitsAt`/
`hasReachedSupplyCap`, plus a new read-only `canAffordCost`) — the same
predicates `applyUnitActionEffect` itself uses, so the UI's preview can't
drift from what the engine actually allows; `move` targeting reuses
`legalMoveDestinations` directly. `resolveContent.ts` gained
`resolveAchievementContent()` to complete the content-resolver set.

**Still not implemented:**
- Rule 4's no-space/move-tiles search — `placeTile()` currently just
  rejects an illegal placement outright; it doesn't detect "no legal
  placement exists anywhere" and prompt for a minimal tile rearrangement.
- Tile placement in the UI is confined to a padded rectangle around the
  board's current extent (`BoardSetupView.tsx`'s `paddedEmptyCoords`),
  not the fully unconstrained "anywhere on an infinite empty board" the
  engine allows — a deliberate scope cut (an infinite pan/zoom canvas
  felt like overkill for a first pass), not a rules gap.
- None of this UI (board setup or round cycle) has been click-tested
  end-to-end against a live Supabase project — this sandbox has no
  Supabase credentials or working Docker to stand one up locally, so
  only `tsc -b`/`oxlint`/`vitest`/`npm run build` have verified it.

Open questions once further work starts: whether "least tiles moved"
ties (multiple minimal-size rearrangements) need a tiebreak rule or are
just player choice; how the new starting player for unit placement is
actually chosen (currently just reuses `turnOrder[0]`, unconfirmed); and
what happens if a player somehow has no legal spot for a unit they must
place (mirrors the same open question for tiles).

## 8. Unit/event id generation was a cross-client collision bug — fixed

Reported from real 2-player testing: a Ship's "Transform to City" made an
unrelated City belonging to the *other* player vanish. Root cause:
`src/engine/unitActions.ts`'s `applyCreate`/`applyTransform` and
`src/engine/boardSetup.ts`'s `placeUnit` each generated new unit ids from
a **module-level counter** (`let createdUnitCounter = 0`, etc.), and
`src/engine/log.ts` did the same for log event ids. That's fine in a
single process, but this app has no server applying actions — every
player's browser tab runs the engine independently and writes its result
straight to the shared `game_state` row (see `src/lib/gameApi.ts`). Each
tab's counter starts at 0 independently, so the first unit *any* two
players each create/transform in their own tab both get
`created_unit_1`. Once both ids land in the same shared `units` array, a
later `destroySelf` transform's `afterCost.units.filter(u => u.id !==
unit.id)` matches *both* same-id units and removes them both — exactly
the reported symptom, and a page refresh alone (which resets the
module's counter to 0) made it easy to hit even sooner than two separate
players would.

Fix: id generation no longer touches any module-level variable. A new
`idSequence: number` field on `GameState` (start at 0 in
`createNewGame()`) is threaded through every unit-creating call site via
`src/engine/idSequence.ts`'s `nextSequenceId(state, prefix)`, which reads
`state.idSequence`, returns `{id, idSequence}`, and the caller includes
the bumped `idSequence` in the `GameState` it returns — same deterministic-
reducer pattern as everything else in the engine, just no longer capable
of drifting between two independent clients, since it's part of the very
state both clients already agree on via the `version`-guarded write.
Deliberately *not* `state.units.length`-based: a `destroySelf` transform
keeps `units.length` flat (one removed, one added), which would have
silently reused an id on the very next create. Log event ids
(`log.ts`'s `appendLog`) switched to `state.log.length`-derived ids
instead — safe there since the log is genuinely append-only, so no
separate counter field was needed for it.

Regression coverage: `unitActions.test.ts` gained a test asserting the
new unit's id comes from a nonzero starting `idSequence` (not a fresh-
process counter), and a second asserting a `destroySelf` transform
followed by another transform never reuses the removed unit's id despite
`units.length` staying constant across the first one. 222 tests total
(was 220); `tsc -b`/`oxlint`/`npm run build` all clean. Not re-verified
against a live 2-player session — same sandbox limitation as the rest of
the UI work (no Supabase credentials/Docker here) — worth specifically
re-testing the exact reported scenario (Ship → Transform to City) on a
real deployment.

## 9. No unit may be created on Water except Ships — fixed

Reported from real testing: a City's "Create Nomad" action let the Nomad
land on a Water hex. Root cause: `CreateEffect` (`create-nomad`/
`create-merchant`/`create-mountaineer` in `content/units.json`) has no
`targetHex.terrainType` field at all — unlike `TransformEffect`, whose
target terrain content already restricts correctly — so
`applyCreate` in `src/engine/unitActions.ts` never checked the target
hex's terrain, only adjacency/occupancy/cliffs/supply cap.

Fix: a new `isWaterCreationAllowed(targetUnit, terrain)` predicate in
`unitActions.ts` — true unless `terrain === 'water'` and `targetUnit !==
'ship'` — is checked in both `applyCreate` (closing the actual gap) and
`applyTransform` (defense-in-depth on top of its existing `terrainType`
check, so a future content mistake listing `'water'` for a non-Ship
`targetUnit` still can't slip through). Exported and reused by
`src/engine/actionTargeting.ts`'s `legalCreateTargets`/
`legalTransformTargets` so the UI's target-highlighting can't offer
Water as legal either. **Scope note:** this is specifically about the
`create`/`transform` unit-creation mechanic during the round cycle — it
does *not* touch `src/engine/boardSetup.ts`'s starting-unit placement,
which has its own already-confirmed separate ruling ("City and Nomad
anywhere except Glacier, Ship only on Water" — i.e. City/Nomad on Water
*is* legal there). Worth confirming that reading is right if it turns
out not to be.

Added 6 regression tests (2 each in `unitActions.test.ts`'s create/
transform blocks, 3 in `actionTargeting.test.ts`) covering: a plain
create rejected on Water, a Ship create allowed on Water, a transform
rejected on Water even when content's `terrainType` mistakenly allows
it, and the UI-facing legal-targets functions excluding/including Water
the same way. 228 tests total (was 222); `tsc -b`/`oxlint`/
`npm run build` all clean. Not re-verified against a live session.

## 10. Action-choice UX overhaul + a real sequencing bug it exposed

Requested: make picking a unit's action contextual (highlight units that
can still act, click one to get a radial menu of its actions right at
the unit), and add an undo for in-progress choices during the actions
phase. Doing this surfaced a real correctness bug along the way: one
unit's action could change state (e.g. a Nomad producing a resource)
that a *different* unit's action in the *same* submission should be
able to spend (e.g. a second Nomad converting to a City using it) — but
`applyResolveUnitAction` (`src/engine/applyAction.ts`) grouped units by
action id and resolved each group as a batch, so which group ran first
depended on `Map` insertion order of whichever action id was
encountered first in `Object.entries()`, not the order the player
actually intended.

**Engine:** `RESOLVE_UNIT_ACTION`'s payload changed from
`actionIdByUnitId: Record<string,string>` + a separate `targets` map to
an ORDERED array, `unitActions: UnitActionAssignment[]`
(`{unitId, actionId, target?}` — see `src/engine/actions.ts`).
`applyResolveUnitAction` now resolves each assignment fully, one unit at
a time, in exactly that order — calling `applyUnitActionEffect`
(unchanged signature, already supported restricting to one unit id from
the previous per-unit-action fix) once per assignment against the
continuously-updating state. A unit not listed still simply does
nothing. This is what actually fixes the bug: resolution order is now
explicit and player-controlled instead of implicit grouping order.

**UI (`src/components/RoundView.tsx` + `HexBoard.tsx`):** during the
actions phase, units that can still act (mine, of the played card's
kind, not yet assigned) get a pulsing amber ring (`UnitMarker.
highlighted`, new). Clicking one opens a radial menu of its actions
drawn directly in the SVG around that hex (`HexBoard`'s new
`actionMenu` prop — a ring of clickable circles + connecting lines,
positioned via the same axial-to-pixel math the board already uses, so
it stays correctly placed regardless of zoom/viewBox scaling). Picking
an action either appends the assignment immediately (no-target actions)
or switches to target-picking mode reusing the existing legal-target
ghost-cell highlighting; the *order* assignments land in the list is
exactly the order the player clicked things — which is also the
resolution order sent to the engine. `ActionsPanel` shows that list
live ("resolves in this order: 1. City at (0,0) → Generate Income;
2. ..."), plus an "Undo last" button (pops the last assignment,
returning that unit to available/highlighted) and "Resolve actions"
(submits the array as-is — nothing is sent to the engine until this
click, so undo is pure local UI state, not an engine-level rollback).

Regression coverage: two new tests in `applyAction.test.ts` build a
2-Nomad scenario (one produces wood, one spends wood transforming to a
City) and assert it succeeds in the produce-then-spend order and fails
(silently no-ops, stays a Nomad) in the reverse order — proving
resolution order is real and player-controlled, not incidental. 230
tests total (was 228); `tsc -b`/`oxlint`/`npm run build` all clean. Not
click-tested in a browser — same sandbox limitation as all prior UI
work here (no Supabase credentials/Docker) — the radial-menu
positioning and highlight styling especially are worth a visual check
on a real deployment.

## 11. Event sourcing — full action history + a derivable final state

Requested: `GameState` should carry its complete action history (board
setup included), not just the current snapshot. Discussed the design
before building it — specifically whether the log should live in a
separate DB table (needing a migration and, for real consistency, an
atomic Postgres function so the log and the live snapshot can never
drift apart) or be embedded directly in `GameState` itself. Went with
**embedding it in state**: `GameState.actionHistory: LoggedAction[]`
(`src/engine/actions.ts` — `{action, turn, timestamp}`). This sidesteps
the whole dual-write consistency problem outright — there's only ever
one write (the existing `game_state` row, via the same
`writeGameState`/`insertGameState` calls already in `gameApi.ts`), so
**no migration, no new table, no changes to the persistence layer at
all** were needed; `actionHistory` is just another field that rides
along in the same JSONB blob.

Mechanics: `applyAction()` (`src/engine/applyAction.ts`) is now a thin
wrapper — the original dispatch logic moved to a private
`dispatchAction()`, and on success the wrapper appends the just-applied
`action` to the returned state's `actionHistory` in one place, so every
action type gets this for free without touching each individual
`apply*` handler. Because `PLACE_TILE`/`PLACE_UNIT` already flow through
this same `applyAction()` entry point (established back in the
board-setup wiring work), board setup is covered automatically — "this
includes the map building phase" didn't need any separate handling.
Only genuinely player-dispatched actions are logged — not derived
bookkeeping (phase transitions, achievement claims, elimination,
round-end) — since `applyAction()` is already a pure, deterministic
reducer that reconstructs all of that from the logged actions alone. The
game's genesis (`createNewGame()` + `startGame()`, which auto-seeds
starting water tiles) isn't itself a logged entry — it's deterministic
from the player roster + current content, so replay just calls those
directly and folds the history on top.

New `src/engine/replay.ts`'s `replayActions(genesis, history, content...)`
folds `applyAction()` over a logged history and returns the resulting
state — proof that "the final state" is always derivable from "the
history", not just asserted. Throws if any logged entry is rejected
(a corrupted or mismatched history).

Tested in a new `replay.test.ts`: one flow drives real `PLACE_TILE`/
`PLACE_UNIT` actions through board setup and confirms `replayActions`
reconstructs an identical state (modulo wall-clock timestamps, which
were never meant to replay byte-for-byte — same pre-existing caveat as
`GameEvent.timestamp` in the human-readable log); one does the same for
`CHOOSE_CARD`/`RESOLVE_UNIT_ACTION` in the round cycle; one confirms
replaying a reordered/tampered history throws instead of silently
producing the wrong state. 233 tests total (was 230); `tsc -b`/
`oxlint`/`npm run build` all clean.

**Scope note:** no history-viewer UI was built — just the data model
(the log lives in every `GameState`, so it's already flowing to
Supabase and back on every read/write) and the `replayActions()`
capability, per the explicit decision to keep this data-layer-only for
now.

## 12. Map templates (skip interactive tile placement) + a starting-unit Water bug it surfaced — fixed

Requested: let a game start from a pre-made map instead of building one
tile-by-tile in board setup. Added `src/content/mapTemplates.json`
(+ schema) holding one template today (`classic`, captured from a real
finished game's board), resolved via `resolveMapTemplateBoard()`/
`listMapTemplates()` in `content/resolveContent.ts`. Engine side:
`beginBoardSetupWithPresetBoard()`/`startGameWithPresetBoard()`
(`boardSetup.ts`/`createGame.ts`) parallel `beginBoardSetup()`/
`startGame()` but use the given `Board` as-is with an empty
`tileTierQueue`, skipping straight to the existing starting-unit
placement sub-phase — placement itself (`placeUnit`, turn cycling,
transition to `active`) is untouched and still runs normally. Wired
through a new nullable `games.map_template_id` column
(`supabase/migrations/0002_map_template.sql`), a `MapTemplateSelector`
on `HomePage.tsx`'s create-game form, and a branch in
`LobbyPage.tsx`'s `handleStart()`.

Testing this for real (a live hotseat game) surfaced a genuine bug
flagged but left unconfirmed back in #7/#9: `isLegalStartingUnitPlacement`
read "City and Nomad anywhere except Glacier" as *including* Water, so a
Nomad could be placed on a Water hex — and then never move, since Water
isn't in its `movement.terrains`. Confirmed the correct rule: only Ship
may start on Water; City and Nomad are now also excluded from Water, not
just Glacier. One-line fix in `boardSetup.ts`. Updated `replay.test.ts`'s
fixture (it had a City placed on a seeded starting-water tile, now
illegal) and added a direct regression test for City/Nomad rejected on
Water in `boardSetup.test.ts`. 236 tests total (was 235); `tsc -b`/
`oxlint`/`npm run build` all clean.

## 13. Purchase phase auto-skip for empty decline + radial menu full text — fixed

Two requested fixes.

**Auto-advance the purchase phase.** A player with nothing in their
`declineCardIds` has no meaningful choice in round step 4 (buy back a
card or pass) — passing was their only option, but it still required an
explicit `PASS_PURCHASE` click. Added `skipEmptyDeclinePurchasers()`
(`round.ts`): repeatedly drops whoever's at the front of the
purchase-phase queue if their decline is empty (logging "had nothing to
purchase back" for each), until it finds someone with cards to consider
or empties the queue outright — the common case, since most rounds
nobody has declined anything yet, so the whole phase now completes
automatically with no player action at all. Called from
`beginPurchasePhase()` (so it can also fire the moment the phase starts)
and from `applyPurchaseCard`/`applyPassPurchase` (so it also fires after
each real decision). This meant `beginPurchasePhase`/`beginDeclinePhase`/
`beginPostActionsPhase` needed an `achievementContent` param threaded
through (default `EMPTY_ACHIEVEMENT_CONTENT`, same pattern as
`finishRound`) — `beginPurchasePhase` can now trigger `finishRound`
directly, not just the `PURCHASE_CARD`/`PASS_PURCHASE` handlers. Six
`round.test.ts` cases that manually called `PASS_PURCHASE` for players
with nothing in decline needed updating (the phase now auto-completes
before those calls would even apply), plus a new regression test for the
mixed case: one player auto-skipped, the other still correctly waited on.

**Full action text in the radial menu.** `RoundView.tsx`'s per-unit
action picker (`HexBoard.tsx`'s `actionMenu`) drew each option as a tiny
circle with a 2-letter abbreviation (e.g. "GE" for "Generate Income"),
full name only visible via hover tooltip — reported unusable, since you
had to hover every option to find out what it did. Replaced the
circle+abbreviation with an SVG `<foreignObject>` box showing the full
action name directly (`ActionMenuOption.label` is now the full name, no
`title` tooltip needed). Box placement radius now scales with option
count (`actionMenuRadius()`) so it stays legible up to Merchant's 7
options (the most of any unit kind) without the boxes overlapping.

237 tests total (was 236); `tsc -b`/`oxlint`/`npm run build` all clean.
Not click-tested in a browser — same sandbox limitation as all prior UI
work here (no Supabase credentials/Docker) — the radial-menu spacing at
high option counts is especially worth a visual check on a real
deployment.

## 14. Undo button — any player, any time — built on the existing action history

Requested: now that `GameState.actionHistory` exists (#11), let any player
undo the most recent action, at any time. The engine's event-sourcing
design made this cheap: "step back one action" is just `replayActions`
(`replay.ts`) over `actionHistory.slice(0, -1)` instead of the full
history — no separate undo stack needed.

The one missing piece was genesis: `replayActions` needs a starting
`GameState` to replay onto, but genesis was never persisted anywhere
(only the current, already-folded state lives in the `game_state` row).
Fixed by making genesis *reconstructible* instead of stored: new
`src/lib/gameGenesis.ts`'s `buildGenesisState(game, players)` rebuilds it
deterministically from the `games` row + seated players (seat order is
fixed at creation, so it's always the same original turn order) —
exactly the logic `LobbyPage.tsx`'s `handleStart()` already had inline,
now factored out and reused by both call sites (`handleStart()` was
simplified to a single `buildGenesisState()` call in the process).

`GamePage.tsx`'s new "Undo last action" button: disabled when there's
nothing to undo (`actionHistory` empty) or the user isn't seated;
otherwise rebuilds genesis, replays history minus the last entry,
appends one *display-log-only* note ("Player X undid the last action:
Player Y <what>") so the log doesn't just silently lose an entry with no
explanation — deliberately not itself a logged action (doesn't re-enter
`actionHistory`), so an undo can't recursively undo itself. Writes back
through the same `writeGameState`/optimistic-`version` path as every
other action, so a race with someone else acting first is handled the
same way (refetch + retry prompt).

No new engine code at all — this is entirely `replayActions` (already
tested in #11) plus the new genesis-rebuilding helper, which got its own
test file (`src/lib/__tests__/gameGenesis.test.ts`): determinism (same
inputs -> byte-identical genesis, modulo timestamps), the interactive-vs-
preset-map branch, an unknown-template-id throw, seat-order-as-turn-order,
and an end-to-end undo check (place a unit, rebuild genesis fresh, replay
the trimmed history, confirm the unit's gone and the board matches
genesis exactly). 243 tests total (was 237); `tsc -b`/`oxlint`/
`npm run build` all clean. Not click-tested in a browser — same sandbox
limitation as all prior UI work here.

## 15. Hex marking: white dot instead of green highlight + illegal hexes no longer invite a click

Two requested UI fixes, both in `HexBoard.tsx`.

**White dot instead of green highlight.** A legal `GhostCell` (used for
tile-placement preview, starting-unit placement candidates, and action
targeting alike) used to render as a translucent green hex overlay
(fill + stroke). Now renders as a small white dot centered on the hex
instead. Illegal ghost cells are unchanged (still a red hex overlay —
only asked to replace the green one).

**Bug: Glacier looked highlighted/clickable during City/Nomad starting
placement, even though it's illegal there.** Root cause wasn't the
legality rule itself — `isLegalStartingUnitPlacement` (`boardSetup.ts`)
has excluded Glacier since it was first written, confirmed via `git log`.
It was that `HexBoard`'s `interactive` flag applies the
`cursor-pointer hover:opacity-80` styling (and wires up `onHexClick`) to
*every* hex uniformly, legal or not — so hovering/clicking Glacier looked
exactly as inviting as a legal hex, even though clicking it would just
get rejected server-side. Added a new `clickableCoords?: Coordinate[]`
prop: when given, only listed hexes get the hover/pointer treatment and
fire `onHexClick`; omitted (the default), every hex stays clickable,
which is still correct for tile placement (any hex, tiled or not, can
become a new anchor — there's no fixed "legal anchor list" to restrict
to). `BoardSetupView.tsx`'s starting-unit panel now passes its legal-
placement coords as `clickableCoords`, so Glacier (or any other illegal
hex) is inert during City/Nomad placement — no hover affordance, no
click.

Scope note: `RoundView.tsx`'s action-targeting board clicks already
gated the actual dispatch in JS (`legalTargets.some(...)` before
committing) — only the CSS hover affordance was ever imprecise there too,
same underlying issue — but only the reported unit-placement case was
fixed; `RoundView` wasn't touched, since it wasn't what was reported and
this keeps the change minimal.

No engine changes, no test changes — purely `HexBoard.tsx`/
`BoardSetupView.tsx` rendering. `tsc -b`/`oxlint`/`npm run build`/full
vitest suite (243 tests, unaffected) all clean. Not click-tested in a
browser — same sandbox limitation as all prior UI work here.

## 16. No unit but Mountaineer may be created/transformed onto Glacier — fixed

Reported from real testing: a City's "Create Nomad" placed the Nomad on
a Glacier hex. Root cause was the same shape as #9's Water bug, just for
a different terrain: `CreateEffect` has no `targetHex.terrainType` field
in content at all (unlike `TransformEffect`), so `applyCreate` never
checked the target hex's terrain beyond the Water-only guard added in
#9 (`isWaterCreationAllowed`) — Glacier sailed straight through.

Fix: generalized `isWaterCreationAllowed` into `isCreationAllowedOnTerrain`
(`unitActions.ts`), backed by a small `SOLE_CREATABLE_KIND_BY_TERRAIN`
table (`water: 'ship'`, `glacier: 'mountaineer'`) instead of a single
hardcoded water check — same call sites as before (`applyCreate`,
`applyTransform`, and `actionTargeting.ts`'s `legalCreateTargets`/
`legalTransformTargets` for the UI's target highlighting), so both the
hard rule and the UI stay in sync automatically. Movement
(`legalMoveDestinations`) and starting-unit placement
(`isLegalStartingUnitPlacement`) already correctly restricted Glacier to
Mountaineer-only (confirmed via `git log` — never buggy), so this closes
the one remaining gap.

Mirrored every Water regression test for Glacier/Mountaineer (create
allowed/disallowed, transform disallowed even with a mistaken content
`terrainType`, `legalCreateTargets`/`legalTransformTargets` include/
exclude). Caught a subtlety while writing them: Plain(level 1) next to
Glacier(level 4) is *also* a cliff edge (diff > 1), which independently
blocks creation there — so a naive Plain-adjacent-to-Glacier test board
would "pass" for the wrong reason. Used Mountain(level 3) next to
Glacier(diff 1, no cliff) instead, so each new test isolates the Glacier/
Mountaineer rule from the unrelated cliff rule. 249 tests total (was
243); `tsc -b`/`oxlint`/`npm run build` all clean.

## 17. Immediate per-unit action resolution + a Pass button, replacing the batch "Resolve actions" submit

Two related requests, both about the `actions` phase (round step 2).

**Drop the "Resolve actions" button — resolve each unit's choice
immediately.** Previously a player staged an ordered list of per-unit
assignments client-side (`RoundView.tsx`'s local `ui.assignments`) and
submitted the whole batch in one `RESOLVE_UNIT_ACTION` dispatch, which
also happened to be what ended their turn. Now that global Undo (#14)
covers "I misclicked," there's no need for that staging — each pick
(after any needed target click) dispatches its own `RESOLVE_UNIT_ACTION`
immediately, applied and logged right away. This also makes cross-unit
visibility more honest: a Nomad's Produce Resource is now visibly applied
to `resources` *before* the player even opens the next Nomad's menu to
decide what it does with the result, rather than only after a blind
batch submit.

**Add a Pass button for whichever units didn't get an action.** Splitting
resolution out per-unit meant something else had to take over "end my
turn" — added a new `PASS_ACTIONS` action (`actions.ts`/`applyAction.ts`):
moves the chosen card hand → currentlyPlayed → discard and advances
`pendingPlayerIds`, same bookkeeping `RESOLVE_UNIT_ACTION` used to do
unconditionally on every call. Whatever units weren't individually
resolved simply do nothing this round — already every unit's default
outcome, so Pass doesn't need to enumerate them — and it's exactly **one**
`actionHistory`/log entry regardless of how many units it leaves idle, as
requested.

Engine mechanics: `RESOLVE_UNIT_ACTION` (`applyResolveUnitAction` in
`applyAction.ts`) no longer touches `pendingPlayerIds` or card zones at
all — it only applies the given unit(s)' effects, records them in a new
`GameState.resolvedUnitIdsThisTurn: string[]` (reset in
`beginActionsPhase` for the first player, in the new `applyPassActions`
for each next one), and checks achievement claims. A unit already in
`resolvedUnitIdsThisTurn` is skipped (can't act twice), and the call is
rejected outright if nothing in the list actually resolved — "do nothing"
is Pass's job now, not a vacuous `unitActions: []` dispatch that used to
silently end the turn. `unitActions` stays a list (ordering/multi-unit
support intact, still exercised by the existing "resolution order is
real" tests) even though the UI only ever submits one assignment at a
time now.

UI: `RoundView.tsx`'s `ActionsPanel` dropped its local assignment list,
`onUndo`/`onResolve` props, and the ordered "resolves in this order"
preview — replaced by one `onPassActions` prop and a live count read
straight from `state.resolvedUnitIdsThisTurn` ("2 of 3 units still need
one"). `RoundView`'s top-level UI state shrank from `{assignments, mode}`
to just `mode` (the radial-menu/targeting interaction state, which still
needs to exist client-side since a targeted action needs a second click
before it can dispatch).

Test fallout was concentrated in `round.test.ts`: every test there used
to call `RESOLVE_UNIT_ACTION` with an empty `unitActions: []` purely as a
"pass through this turn" placeholder (relying on the old
always-ends-the-turn behavior) — all 12 such call-pairs became direct
`PASS_ACTIONS` dispatches instead, which is both simpler and a more
faithful description of what those tests actually needed. Added a new
`applyAction.test.ts` describe block with direct coverage of the split:
resolving one unit applies immediately without ending the turn, re-
resolving the same unit twice is rejected, an empty/fully-already-
resolved list is rejected, `PASS_ACTIONS` moves the card and advances
`pendingPlayerIds`, and it's exactly one `actionHistory` entry no matter
how many units it left idle. 256 tests total (was 249); `tsc -b`/
`oxlint`/`npm run build` all clean. Not click-tested in a browser — same
sandbox limitation as all prior UI work here; the live cross-unit-
visibility behavior (seeing an earlier unit's resource gain before
choosing a later unit's action) is especially worth a manual check on a
real deployment.

## 18. "Second player has to refresh to choose their card" — fixed by retrying instead of erroring on write conflicts

Reported: during the simultaneous select-cards phase, once one player
chose their card, the other player couldn't choose theirs without a
manual browser refresh.

Investigated without live Supabase access (same sandbox limitation noted
throughout this file), so this is a best-diagnosis fix, not a confirmed-
by-reproduction one — worth a real 2-browser check. Realtime sync itself
already has to work for the game to be playable at all up through board
setup (both players place tiles/units turn by turn, which the earlier
playtest log this session started from proves happened), so a wholesale
"Realtime is broken" theory didn't fit a bug reported specifically at
select-cards. What does fit: `game_state.version`-guarded writes
(`writeGameState` in `gameApi.ts`) are optimistic concurrency, and two
players choosing their own, entirely independent cards in the same
simultaneous phase is the textbook case where both writes land close
together — whichever arrives second loses the version race even though
it's not actually in conflict with the first (each player is only ever
writing their own choice). `GamePage.tsx`'s old `submitAction` treated
that loss as terminal: refetch, show "someone else acted first, please
try again," stop — leaving the second player's own valid click needing
to be manually retried (or, from a confused player's perspective, "just
refresh the page").

Fix: replaced the single-attempt write in both `submitAction` and
`handleUndo` with a shared `writeWithRetry()` — recomputes the action
against freshly refetched state and writes again, up to
`MAX_WRITE_RETRIES` (3) times, only surfacing an error if it keeps
losing that many times in a row. For `handleUndo` specifically, this
meant recomputing "genesis + history minus last" fresh on *each* retry
attempt (not once up front), since a retry is replaying against newer
state than what was on screen when the button was clicked — correct
anyway, since "undo the last action" should mean whatever's actually
last right now. No engine changes; this is purely `GamePage.tsx`'s
write-orchestration layer. `tsc -b`/`oxlint`/`npm run build`/full vitest
suite (256 tests, unaffected — no test coverage exists for this file,
consistent with the rest of the UI layer) all clean.

## 19. Turn ends automatically once every unit has acted — no Pass click needed

Requested: once a player has resolved an action for every one of their
acting units (kind matching the played card), there's nothing left to
decide, so the turn should end on its own instead of still requiring a
Pass click.

Factored the turn-ending bookkeeping (card hand -> currentlyPlayed ->
discard, advance `pendingPlayerIds`, reset `resolvedUnitIdsThisTurn`,
possibly cascade into decline/purchase) out of `applyPassActions` into a
shared `finishActionsTurn()` (`applyAction.ts`). `applyResolveUnitAction`
now calls it itself, right after resolving, whenever every one of the
player's units of the played kind is in `resolvedUnitIdsThisTurn` —
still exactly one `actionHistory` entry either way (this is the same
`RESOLVE_UNIT_ACTION` dispatch simply also finishing the turn, not a
separate logged action), and PASS_ACTIONS remains available for the
"leave some units idle on purpose" case #17 was actually about.

No UI changes needed: `RoundView.tsx`'s `ActionsPanel` already renders
"Waiting for the other player" the moment `pendingPlayerIds[0]` isn't the
current player, so once the engine auto-advances the turn, the Pass
button disappears on its own along with the rest of that player's
actions-phase UI — the reactive `state` → render pipeline from #17 just
handles it.

Added direct coverage: resolving a player's last unassigned unit ends
the turn without any `PASS_ACTIONS` dispatch (card discarded, next
player up, still one `actionHistory` entry); a player with only one
acting unit has their whole turn end the moment they resolve it, even
cascading all the way to finishing the actions phase when they were the
last player pending. 258 tests total (was 256); `tsc -b`/`oxlint`/
`npm run build` all clean.

## 20. Cliff hexsides rendered on the board — black, wide

Cliff edges (`isCliffEdge` in `src/engine/cliffs.ts` — a hexside between
two tiles whose terrain elevation levels differ by more than 1) affect
movement/adjacency for every unit except those with `canCrossCliffs`,
but were never actually drawn anywhere — `HexBoard.tsx` had no cliff
rendering at all. Requested: draw them, black and wide, so they're
actually visible during play.

Added directly to `HexBoard.tsx`: a `TERRAIN_LEVEL` lookup mirroring
content/terrain.json's `level` field (same "just enough for this one
rendering decision" role `TERRAIN_COLOR` already plays in this file, so
no new prop/plumbing through every caller). For each tile, checks 3 of
its 6 axial neighbor directions (`CLIFF_CHECK_DIRECTIONS` — half of
`HEX_DIRECTIONS`, enough to visit every undirected hex-to-hex edge
exactly once across the whole board, since each of the other 3
directions is some neighboring tile's mirror of one of these) and, where
`isCliffEdge` is true, draws the shared edge as a black (`#000000`),
4px-wide line — noticeably heavier than every other stroke already on
the board (hex borders at 1-2px, ghost-cell/selection outlines at 2px).
The edge geometry (`hexEdgeSegment`) is derived from the two hex
centers: perpendicular to the line between them, centered on its
midpoint, with the same length as one hex's own side (a regular
hexagon's side length equals its circumradius).

Verified with a standalone HTML/SVG reproduction of the same math (this
sandbox can't run the real app against live Supabase, so this is the
closest available check) — a mountain hex ringed by water on one side
and plain on the other, screenshotted via a locally-installed
`playwright-core` pointed at the pre-installed Chromium — confirmed all
6 surrounding edges render as cliffs (mountain-water: levels 3 vs 0,
diff 3; mountain-plain: levels 3 vs 1, diff 2 — both `> 1`), including a
first read that undercounted them at low screenshot resolution before a
zoomed-in crop confirmed the thick black line really is present on every
cliff edge, not just the visually-higher-contrast water ones. `tsc -b`/
`oxlint`/`npm run build`/full vitest suite (258 tests, unaffected) all
clean.

## 21. A played card for a kind with no units left could get recycled back into hand — fixed

Reported: a player with no Ship units still had the Ship card offered as
a choosable option in the select-cards phase.

Root cause was an interaction between two already-correct-in-isolation
pieces. `syncCardZonesWithBoard` (rules 5/6, `cards.ts`) deliberately
leaves a card alone while it's in `discard` — a just-played card sitting
there is normal, mid-round-cycle, regardless of whether its owner still
has a unit of that kind; only the next recycle or play should move it.
`finishRound`'s round-10/11 recycle (`round.ts`) does exactly that: once
a player's hand is empty, their whole discard pile deals back into hand
verbatim — but "verbatim" was the bug. If one of those discarded cards
belonged to a kind the player no longer has any units of (e.g. they
played their Ship's card, and that Ship was transformed/converted away
before round end), the blind recycle dealt it straight into hand as a
choosable option, in violation of rule 5/6, since nothing re-validated
it against the board on the way.

Fix: `finishRound` now calls `syncCardZonesWithBoard` immediately after
the recycle step, whenever anything was recycled. Any wrongly-recycled
card (kind with no backing unit) gets corrected straight back to supply;
every correctly-recycled card (kind the player still has units of) is
left in hand, untouched — same function already used everywhere else in
the engine for this exact rule, just not previously reached from this
call site.

Added a direct regression test reproducing the reported shape: a player
with real units for every kind except City, whose hand (including a
discarded City card) empties out at round end — confirms the City card
lands in supply, not hand, while every other kind's card is correctly
recycled into hand as normal. Had to fix an unrelated test along the
way: `round.test.ts`'s existing recycle test happened to pick the City
card as its "played card" too, on a fixture where neither player has a
City unit — exactly the bug this fixes, so its old "stays in hand"
assertion was actually asserting the bug. Switched it to a Ship card
(a kind the fixture's players do have) so it tests what it always meant
to: recycle + first-player rotation, not this interaction. 259 tests
total (was 258); `tsc -b`/`oxlint`/`npm run build` all clean.

## 22. An unaffordable/illegal unit action was silently accepted as the unit's turn — fixed, and the radial menu now disables actions that can't be taken

Reported: a Nomad was chosen to Transform to City with insufficient
resources. No City was created, but the engine still treated it as the
Nomad's action for the turn — it was marked resolved and even appeared
in the log, exactly as if the transform had actually happened.

Root cause: `applyCreate`/`applyTransform`/`applyConvert`/
`applyTradeResource`/`applyMove` (`unitActions.ts`) were all written to
fail *silently* — every guard clause (can't afford the cost, no legal
target, adjacency/terrain/supply-cap/cliff violation) just does
`return state` unchanged, on the assumption that a caller resolving a
whole kind's worth of units at once (`applyUnitActionEffect`'s normal
multi-unit mode) wants the other units to keep acting even if one of
them has nothing legal to do. But `applyResolveUnitAction`
(`applyAction.ts`) — the immediate-resolve path introduced by entry
`#4`/`#5` above — was treating "the call returned *some* state" as proof
an action happened, unconditionally pushing the unit into
`resolvedUnitIdsThisTurn` and the log regardless of whether anything
about the state actually changed.

Fix, in two parts:
- `applyUnitActionEffect` now returns its input `state` completely
  unchanged (same object reference) when nothing about it changed —
  previously it always ran the loop's result through
  `syncCardZonesWithBoard`, which unconditionally rebuilds `players` via
  `.map` and so always returned a *new* object even on a total no-op,
  masking the no-op from any caller trying to detect one by reference
  equality. Skipping that call when nothing changed is safe: sync only
  ever reacts to a change in `state.units`, so if nothing changed there's
  nothing for it to correct anyway.
- `applyResolveUnitAction` now compares state before/after each
  assignment by reference. For `create`/`transform`/`convert`/
  `trade-resource`/`move` — the action types with a real precondition
  (a cost, a required target, an adjacency/terrain/supply-cap rule) that
  can make them genuinely impossible — an unchanged reference means the
  action didn't happen, so that assignment is left out of
  `resolvedUnitIds` (and thus out of the log) entirely, same as if the
  unit id or action id had been invalid. `income`/`produce`/`trade` are
  deliberately exempted from this check: they have no cost and no
  required target, so they always succeed even when their numeric payout
  happens to be zero (e.g. an Income action with no qualifying adjacent
  units) — that's a legitimate resolved turn, not a failure, and forcing
  it to fail would risk soft-locking a player with nothing else to pick.
  If a `RESOLVE_UNIT_ACTION` ends up resolving nothing at all this way,
  the whole dispatch is rejected exactly like the pre-existing
  "already acted / not a legal action" case — no partial log entry, no
  actionHistory entry, the unit remains free to act.

Better yet (per the follow-up request): the radial action menu
(`HexBoard.tsx`/`RoundView.tsx`) now disables options the clicked unit
can't currently take, instead of only rejecting them after the fact. A
new `isActionAvailableForUnit` (`actionTargeting.ts`) reuses the exact
same legal-target queries the UI's target-highlighting already calls
(`legalCreateTargets`/`legalTransformTargets`/`legalConvertTargets`),
adds the equivalent checks for `trade-resource` (afford the gold to buy,
or hold the resource to sell) and `move` (at least one legal
destination via `legalMoveDestinations`), and reports `income`/
`produce`/`trade` as always available — mirroring
`ACTION_TYPES_WITH_PRECONDITIONS` on the engine side so the UI and the
engine agree on which action types can even be unavailable.
`RoundView.tsx` computes this per option when building the menu and
passes a new `ActionMenuOption.disabled` flag through to `HexBoard.tsx`;
`selectAction` also re-checks it before dispatching, as defense in depth
against a stale menu. Per the explicit constraint that "disablement
can't be marked with an opacity": a disabled option renders with a
distinct dashed red border, dark neutral background, and dimmed-but-
still-solid (not translucent) text, a dashed connector line instead of
solid, `cursor-not-allowed` instead of `cursor-pointer`, and no
`onClick` — a different visual language from the normal indigo box
entirely, rather than the same box faded out.

Added regression coverage: `applyAction.test.ts` now has a Nomad fixture
where Transform-to-City costs more wood than the player has, confirming
the whole `RESOLVE_UNIT_ACTION` is rejected with no unit created, no log
entry, and `resolvedUnitIdsThisTurn` untouched; a companion test
confirms the identical action succeeds once funded; and a third confirms
Income with a legitimately-zero payout is still accepted, not
mistakenly rejected by the same logic. `actionTargeting.test.ts` gained
a new `isActionAvailableForUnit` describe block covering all of
income/produce/trade (always true), create/transform (mirrors legal
targets), trade-resource (buy/sell affordability), and move (legal
destinations exist). 266 tests total (was 259); `tsc -b`/`oxlint`/
`npm run build` all clean.

## 23. Verified entry #22's fix against the exact reported shape (Nomad → Temple, real content) and pinned it with a real-content regression test

Follow-up report: "I was able to transform a nomad to temple in the
first [round] (although the transformation did not occur). This should
be an error" — the same silent-no-op shape as `#22`, but against the
real Temple action rather than a synthetic fixture.

Reproduced it directly against `content/units.json`'s real Transform to
Temple effect (`cost: { stone: 2 }`, self-location, Plain/Mountain only)
with a fresh round-1 Nomad at the real starting 0/0/0 resources: both
`applyResolveUnitAction` (rejects with `ok: false`, no Temple created,
`resolvedUnitIdsThisTurn` untouched) and `isActionAvailableForUnit`
(reports the option unavailable, so the radial menu renders it disabled)
already behave correctly — entry `#22`'s fix, generic across every
create/transform/convert/trade-resource/move action rather than
special-cased to the originally-reported Nomad→City case, already
covers this. No engine or UI change was needed.

Added a permanent regression test anyway
(`unitActions.realContent.test.ts`), since the previous entry's coverage
only exercised this shape through hand-built fixture content, not the
real JSON — confirms `applyUnitActionEffect` returns the *exact same
state reference* (not just an equivalent one) for a real, unaffordable
Transform to Temple, which is the specific property
`applyResolveUnitAction` depends on to detect the no-op. 267 tests total
(was 266); `tsc -b`/`oxlint`/`npm run build` all clean.

## 24. Richer log messages, City's "Create Merchant/Mountaineer" rule fix, and distinct Merchant/Mountaineer icons

Three requests in one message:

**1. Log detail.** A resolved action's log line only ever named the
action ("Player p1's ship resolved Trade"), never what it actually
produced — no gold amount for a Trade, no resource for a Nomad's Produce
Resource. Fix: `describeResourceDelta` (`resources.ts`) compares a
player's resources before/after the whole `RESOLVE_UNIT_ACTION`
dispatch and renders whatever changed as a suffix, e.g. "Player p1's
ship resolved Trade (+5 gold)" or "Player p1's nomad resolved Produce
Resource (+1 wood)". Deliberately compares actual before/after values
rather than the effect's nominal amount, so a gain clamped by a
resource cap still logs the true amount, and covers every resource-
touching action type (income/produce/trade/trade-resource, and now
convert/create/transform's costs too) via one general mechanism instead
of special-casing per action type. `applyAction.ts` wires this into
`applyResolveUnitAction`'s existing log line.

**2. Rule fix (per correction — the previous description of these
actions was wrong): City's "Create Merchant" and "Create Mountaineer"
don't conjure a unit from nothing on an empty adjacent hex.** They
convert an adjacent Nomad the player already owns into the target unit,
at the same gold cost as before (2 gold, 1 gold). City's "Create Nomad"
is unaffected — a City can still raise a fresh Nomad from nothing;
only the Merchant/Mountaineer actions were wrong.

`ConvertEffect` (`unitContent.ts`) gained two optional fields:
`targetOwner` now accepts `'own'` in addition to the existing `'enemy'`
(Temple's Convert Enemy Unit is unchanged — still `'enemy'`,
kind-preserving), `requiredTargetKind` restricts which kind may be
targeted (`'nomad'`, so a City can't "convert" an adjacent Merchant or
Ship), and `resultUnit` changes the target's kind on conversion instead
of only its ownership. `applyConvert` (`unitActions.ts`) and
`legalConvertTargets` (`actionTargeting.ts`) both grew the matching
branch — same adjacency/cliff/cost/supply-cap rules as any other
convert, just filtering by owner+kind instead of "any enemy unit" and
rewriting the target's `kind`/`movement` in place instead of only its
`ownerId`. `content/units.json`'s `create-merchant`/`create-mountaineer`
actions were rewritten to this shape (ids kept as-is so old
`actionHistory` entries still resolve on replay; only name/description/
effect changed). Entry `#22`'s no-op rejection already covers this
automatically — an unaffordable or illegal City conversion is rejected
outright, not silently accepted, with no extra work.

**3. Mountaineer and Merchant rendered as the same on-board icon** — both
kinds' first letter is 'M', and unit markers were labeled by first
letter alone. New `unitKindLabel()` (`components/unitKindLabel.ts`, its
own module so `HexBoard.tsx` still exports only components, keeping Fast
Refresh working) gives every kind an explicit, unambiguous label:
city 'C', temple 'T', nomad 'N', ship 'S', merchant 'Mr', mountaineer
'Mt' — the pair that collided are the only two-letter ones. `HexBoard`'s
unit-marker text shrinks slightly for two-letter labels so they still
fit inside the marker circle. `RoundView.tsx` and `BoardSetupView.tsx`
(the two places unit markers are built) both switched from
`kind.slice(0, 1).toUpperCase()` to this shared helper.

Added regression coverage: a new `applyUnitActionEffect — convert,
'own'` describe block in `unitActions.test.ts` (converts the right
adjacent unit in place; rejects a wrong-kind adjacent own unit, an
adjacent enemy Nomad, an unaffordable cost, and a full supply cap); a
matching `legalConvertTargets, targetOwner: 'own'` block in
`actionTargeting.test.ts`; a real-content regression in
`unitActions.realContent.test.ts` converting a real Nomad into a real
Merchant via the real `create-merchant` action/cost; and an
`applyAction.test.ts` test asserting a resolved Income's log entry
contains both the action name and "+3 gold". 279 tests total (was 267);
`tsc -b`/`oxlint`/`npm run build` all clean.

## 25. Player status shows hand contents, plus a full achievements display and the current decline buyback price

Two UX requests: show which units a player still has in hand (not just
a count), and add a display for achievements (all of them, not just
claimed ones) and the current gold price to buy a card back from
decline.

`PlayersStrip` (`RoundView.tsx`) now resolves each player's
`handCardIds` to their card's `kind` (via `state.cards`) and renders
"Hand: Nomad, Ship" instead of "Hand 2" — "Hand: empty" once nothing's
left. This is exactly the information a player needs to plan around:
which kinds they can still choose to play this round-cycle, not merely
how many.

The old `AchievementsStrip` (claimed achievements only, shown as raw
id-derived text like "city-mastery → Bob") is replaced by
`AchievementsPanel`, always visible, listing every achievement in the
game — a new `listAchievements()` (`content/resolveContent.ts`) exposes
name/description/unitId/victoryPoints for display, since
`AchievementContent` (the engine's content input) deliberately only
carries what the rules engine itself needs (id→unitId/VP), not display
text. Each achievement renders its name, VP value, and either who
claimed it or "unclaimed"; hovering shows its description via a native
`title` tooltip. The panel also shows the current decline buyback price
(`calculatePurchaseCost` against `state.claimedByAchievementId`'s
count) up front, always — previously this was only computed inside
`PurchasePanel` and only visible to the active player during their own
purchase-phase turn.

Added `src/components/__tests__/RoundView.test.tsx` — this is the
project's first component-level test, using `@testing-library/react`
(already a devDependency, previously unused) against `jsdom` to
actually render `RoundView` and assert on the real DOM output, rather
than relying on an eyeballed dev-server check that this sandbox can't
run (no live Supabase). Confirms both players' hand-kind lists render
correctly and that the achievements panel shows a claimed achievement
with its claimer, an unclaimed one labeled as such, and the correct
buyback price for the given claim count. 281 tests total (was 279);
`tsc -b`/`oxlint`/`npm run build` all clean.

## 26. Unit markers now render a pictogram instead of a letter, with City/Temple as a rectangle

Design work first, drafted and reviewed as a standalone Artifact mockup
before touching any code: every unit kind's on-board marker used to be
a colour disc with a one/two-letter text label (Merchant/Mountaineer
had just been disambiguated to "Mr"/"Mt" in entry `#24`, but it was
still letters to parse, not shapes to recognize). Iterated on a
silhouette-based alternative in that mockup — including a redraw of the
Nomad glyph after the first version (a plain bowed triangle) tested as
too generic at 14px, fixed by cutting a doorway notch into it — then,
once approved, wired the final set into the real app:

- `components/unitIcons.ts` (new): `UNIT_ICONS`, one small array of
  basic shapes (polygon/rect/path/circle) per unit kind on a shared
  24×24 grid — City a battlement block, Temple a pediment over
  columns, Nomad a tent with a door cutout, Merchant a drawstring coin
  bag, Mountaineer twin peaks with a summit flag, Ship a hull with an
  off-centre sail. Kept in its own module (not `HexBoard.tsx`, which
  only exports components) so React Fast Refresh isn't disabled for
  that file — same reasoning as `unitKindLabel.ts` before it, which
  this entry deletes now that nothing reads it.
- `HexBoard.tsx`: unit markers now draw a rectangle (rounded corners)
  for City/Temple and a circle for the four mobile kinds — `STATIC_UNIT_KINDS`
  in `unitIcons.ts` — so the marker's own outline says "this is a
  building" before the glyph inside it does. Each glyph renders twice
  (a white copy scaled up from center behind, the ink-black glyph on
  top) to build a soft halo that stays legible against any player
  colour without per-icon color tuning — proportional to icon size
  rather than a fixed stroke width, so it holds up from a 40px marker
  down to 14px. `UnitMarker.label: string` is now `UnitMarker.kind:
  string`, since the marker no longer needs pre-formatted text — just
  the raw unit kind, same value `RoundView.tsx`/`BoardSetupView.tsx`
  already had on hand.
- Follow-up request: "make the whole glyph larger" — the icon now
  fills 82% of the marker's own diameter (was ~62% in the first
  in-app pass), leaving just enough margin that it doesn't touch the
  marker's ring.

Added `components/__tests__/HexBoard.test.tsx` (new — this file had no
tests of its own before): confirms City/Temple render as a rounded
`<rect>` and the other four kinds as a `<circle>`, confirms each unit
gets exactly one nested icon-glyph `<svg viewBox="0 0 24 24">`, and
confirms an unrecognized kind renders an empty glyph rather than
throwing (`UNIT_ICONS[kind] ?? []`). Also visually spot-checked outside
the test suite via `react-dom/server` + the sandbox's Chromium, since
this sandbox has no live app to click through — confirmed the glyphs,
halo, and rectangle/circle split all render correctly at both the
default in-game size and zoomed in. 284 tests total (was 281); `tsc -b`/
`oxlint`/`npm run build` all clean.

Unrelated to this entry: pulled in three content-only commits pushed
directly to `main` outside this session (`7f33839`, `ba49750`,
`28e416e`) updating `achievements.json`/`units.json`'s `victoryPoints`
— real score tuning, no code changes, nothing to reconcile.

## 27. Unit markers weren't clear enough — dropped the player-colour fill for a fixed neutral plate + a colour bar underneath; redesigned the Nomad icon

Feedback on entry `#26`'s pictograms: still not clear enough. Root
cause: the marker's own shape was filled with the *player's* colour,
and the glyph sat directly on top of it — against a light colour
(yellow) the black glyph still worked, but there was no guarantee of
that in general, and mixing "which shape" (rect/circle) with "which
colour" (player) and "which glyph" (kind) all on the same surface made
the marker busier to parse than it needed to be.

Fix: ownership and legibility are now two separate visual layers.
- The marker's own shape (rectangle for City/Temple, circle for the
  rest) is always filled with a fixed neutral off-white
  (`UNIT_PLATE_COLOR`, `#f2f2ef`) — never the player's colour — and the
  glyph is always the same fixed ink colour (`UNIT_GLYPH_COLOR`,
  `#14161a`) on top of it. Black-on-near-white is close to maximum
  contrast, and it no longer depends on which of the four player
  colours or which terrain the marker happens to sit on — so the old
  white-halo-behind-black-ink trick (entry `#26`) is gone too; it was
  solving exactly this problem for a variable-coloured backdrop, and
  there isn't one anymore.
- The player's colour moved to a small rounded bar beneath the plate,
  narrower than the plate itself — per the request, the glyph (drawn at
  the same size as the plate) visibly spans past the bar's edges rather
  than being contained by it.

Also redesigned the Nomad glyph, per request ("a horse or a wagon
icon") — replaced the tent (already a strange fit for a unit that's
never NOT moving) with a covered wagon at first, but on the round
mobile-unit plate a dome-shaped canopy sitting right above two wheels
read as a face (round head, two "ears") rather than a wagon — tried
adding more margin between the canopy and the plate edge first, which
didn't fix the misread, so switched to a wagon *wheel* instead: a rim,
a hub, and four spokes, all radially symmetric so there's no way to
mistake it for a face, and bold enough to hold up at 14px.

Updated `HexBoard.test.tsx`'s marker tests for the new plate/bar split
(plate is always the neutral colour; the player's colour now appears
exactly once, as a `<rect>` bar, regardless of the marker's own shape).
Visually spot-checked again via `react-dom/server` + the sandbox's
Chromium — every kind × every one of the four real player colours ×
alternating Plain/Glacier terrain (the lightest terrain, the hardest
contrast case) — before wiring in for real. 285 tests total (was 284);
`tsc -b`/`oxlint`/`npm run build` all clean.

## 28. Nomad glyph, take four: a donkey

Follow-up request: change the wagon-wheel Nomad glyph (entry `#27`) to
a donkey. Side profile: body, a neck rising to a head with two long
upright ears (the feature that reads "donkey" rather than "horse"),
two merged leg blocks (one shape per side rather than four separate
thin legs, which would have vanished at 14px), and a small tail — eight
simple axis-aligned shapes, no freehand curve-tracing, so the geometry
stayed predictable without needing visual iteration to get right this
time. Spot-checked via the same `react-dom/server` + Chromium
screenshot process as every icon before it — reads clearly as a
standing quadruped with donkey ears from a 14px marker up through a
60px zoomed-in one, across all four player colours. No test changes
needed: `HexBoard.test.tsx`'s marker tests check glyph count/plate
colour/shape, not any kind's specific geometry. `tsc -b`/`oxlint`/
`npm run build` all clean, 285 tests still passing.

## 29. Two reported bugs investigated — neither reproduces against current `main`; added permanent regression tests for both anyway

1. "Can't undo a pass on purchasing a card from decline."
2. "City can't transform Nomad into Mountaineer or Merchant — choosing
   the action doesn't lead to a follow-up selection of which unit to
   transform."

Neither reproduced. For each, built the most faithful reproduction the
sandbox allows (no live Supabase, so no way to click through the actual
deployed app) and it worked correctly both times:

- **(1)**: drove a real 2-player game through `applyAction` — both
  choose their City card, both pass actions, land in the purchase phase
  with p1 owing a real decision (a card already sitting in their
  decline), p1 passes purchasing. Since p2 has nothing in decline they
  auto-skip (`skipEmptyDeclinePurchasers`), so p1's `PASS_PURCHASE` is
  also the action that closes out the round. Simulated exactly what
  `GamePage.tsx`'s `handleUndo` does — `replayActions(genesis,
  actionHistory.slice(0, -1))` — and it reconstructs the exact
  pre-pass purchase-phase state with no replay error.
- **(2)**: rendered the real `RoundView` (not a synthetic fixture — the
  real `content/units.json` actions) with a City adjacent to the
  player's own Nomad and enough gold, and simulated actual clicks:
  City → "Convert to Merchant" in the radial menu → confirmed a ghost
  dot appears over the Nomad's hex and `onResolveUnit` is *not* called
  yet (i.e. targeting mode was entered, not an immediate resolve) →
  clicked the Nomad's hex → confirmed `onResolveUnit('city1',
  'create-merchant', { q: 1, r: 0 })` fires. The full click-through
  works exactly as designed.

Added both as permanent regression tests anyway, since they're real
coverage of scenarios that weren't exercised before (`replay.test.ts`
had no test undoing a round-*ending* action; `RoundView.test.tsx` had
no test simulating actual clicks through the City's own-Nomad convert
flow end to end) — `replay.test.ts`'s new `round phase` test and
`RoundView.test.tsx`'s new describe block. 287 tests total (was 285);
`tsc -b`/`oxlint`/`npm run build` all clean.

Since neither bug reproduces on `main`, the likely explanation is a
stale build (the reporter testing an older deployed version, or a
cached bundle) rather than a live defect — flagged back to the user
rather than guessing at a speculative fix for code that already behaves
correctly under test.

## 30. Player status summary: remaining unit supply, live score, and the achievements panel moved to the bottom

Three requests: show each player's remaining unit supply (not just
which kinds are still in hand), show each player's current score
(previously only computed once at game end), and move the achievements
panel out from the top of the page.

`PlayersStrip` (`RoundView.tsx`) gained two things per player:
- **Remaining**: for each of the six kinds (`UNIT_KINDS`, `cards.ts`),
  `unitSupplyCaps[kind] − (that player's units of that kind currently
  on the board)` — how many more of that kind they could still build
  before hitting their personal supply cap. Skips a kind entirely if
  `unitContent` doesn't define a cap for it (matches `EMPTY_UNIT_CONTENT`
  gracefully — no "Remaining" line rendered at all rather than a row of
  zeros).
- **Score**: a new `currentScoreByPlayerId` sums the same three VP
  sources `finishRound` already uses for the end-of-game winner check
  (`calculateAchievementVP`, `calculateBoardCountVP`,
  `calculateTerrainControlVP`, combined via `sumVP`) — computed live off
  the current `GameState` on every render, not just once when the game
  ends, so players can track their standing mid-game.

`AchievementsPanel` moved from right after `PlayersStrip` (top of the
page) to the very last element in `RoundView`, after the board and the
log — it's reference material a player checks occasionally, not
something that needs to compete with the phase-specific action panel
for top-of-page attention every render.

Added three new tests to `RoundView.test.tsx`: remaining-supply text
matches cap-minus-on-board per kind per player; score text reflects a
claimed achievement's VP value (and 0 for a player with nothing
claimed); and a DOM-order assertion that the achievements panel is the
very last child of the page, after the board. 290 tests total (was
287); `tsc -b`/`oxlint`/`npm run build` all clean.

## 31. "Show history" toggle: review what happened on the board since a player's last turn

Requested: a button to reveal what opponents did between a player's own
turns — movement as arrows, new units in a green halo, resource
gathering in red, income generation in gold (with the amount shown),
merchant trades with both resource and gold deltas shown, conversions
in purple, and the net resource/gold change per player surfaced in the
player strip.

Nothing about "what happened last turn" was previously stored, so it's
derived on demand from the existing `actionHistory: LoggedAction[]`
event log rather than adding new persisted state. New module
`engine/turnReview.ts`: `findReviewWindowStart(actionHistory, playerId)`
walks backward to find the index right after that player's own most
recent action (0 if they haven't acted yet this game); `buildTurnReview`
then replays only the actions in that window starting from the state as
of that point, extracting a flat list of per-unit events plus a
per-player aggregate resource/gold delta.

Event extraction for `RESOLVE_UNIT_ACTION` needed two parallel passes
per unit assignment: the real `applyAction` call advances the
authoritative state so later actions in the window see the world
exactly as it really unfolded (achievement claims, eliminations, etc.),
while a second, throwaway `applyUnitActionEffect` call on just that
assignment produces a clean before/after pair to diff for events. Diffing
only `assignment.unitId` (the acting unit) turned out to be wrong for
three of the six event types: a `create` effect lands on a brand-new
unit id, a self-destroying `transform` effect leaves the acting unit
gone with the replacement under a new id, and `convert` changes a unit
that isn't the acting one at all (the adjacent target). Fixed by
scanning every unit present in either the before or after state map,
not just the acting unit's id, and only using the acting unit's id
specifically to attribute the resource delta (produced/income/traded)
once it's computed.

`HexBoard.tsx` renders the review: `HistoryArrow` draws a short
sky-blue line with an arrowhead from a unit's prior hex to its new one;
`historyHalos` draws one stroke-only ring per event type around a
unit's marker plate (green=created, red=produced, gold=income,
purple=converted; a unit can carry more than one, e.g. built-and-moved
in the same turn), stacked at increasing radius with a `<title>` for
hover text; `historyLabel` renders a small pill (e.g. `"+2 Wood"` or
`"+1 Wood, -5 Gold"`) offset above-right of the marker. A unit's label
can sit far enough right of its hex to clip past the board's edge —
caught in a screenshot during visual QA — so the SVG `viewBox` bounds
calculation now includes an extra bounds point at each label's far
corner, the same way it already accounts for the action-menu overlay.

`RoundView.tsx` adds the toggle button (disabled when there's nothing
to show), a `summarizeUnitHistory` helper that groups the flat event
list by unit into halos/label/moves for `HexBoard`, and passes
`resourceDeltaByPlayerId` through to `PlayersStrip` so each player's
Gold/Wood/Stone figures show a `(+N)`/`(−N)` suffix while history is
visible. `GamePage.tsx` wires it up: replays from genesis to the
review-window start, builds the review via a `useMemo` keyed on action-
history length, and fails quiet (returns `null`) if anything's
inconsistent rather than throwing.

14 new engine tests (`turnReview.test.ts`) covering the window-start
boundary, each event type individually (including the destroySelf-
transform and both convert variants — City-owns-Nomad and Temple-
steals-enemy), multi-assignment attribution, and cross-action aggregate
deltas; 5 new `RoundView.test.tsx` tests for the toggle's enabled state,
click behaviour, halo/label rendering, hidden-by-default behaviour, and
the player-strip deltas. Verified end-to-end with a real 2-player replay
rendered through the sandbox's headless screenshot pipeline before and
after the bounds fix. 309 tests total (was 290); `tsc -b`/`oxlint`/
`npm run build` all clean.

## 32. Bug fix: Ship's Trade only counted Cities on its own hex, not the whole sea area

Reported: Trade should pay out for every City adjacent to any part of the
sea the Ship is sailing in — a contiguous stretch of connected water
hexes — not just the single hex the Ship happens to occupy, and that
includes a City across a cliff edge from the water.

`applyTrade` (`unitActions.ts`) previously called the same
`adjacentUnits` helper every other adjacency-based effect uses, scoped
to just `unit.coord` — correct for "adjacent to this one hex" effects
like income, but wrong for Trade, which the rules describe in terms of
the sea itself, not the Ship's exact position in it. Added
`connectedTerrainRegion(board, start)` to `board.ts` — a same-terrain
BFS flood fill (reused the existing `neighborCoords` helper, no cliff
check needed since a cliff is by definition a boundary between two
*different* terrain levels and can't occur between same-terrain
neighbors) — and rewrote `applyTrade` to flood-fill the Ship's sea area
first, then union the adjacent units across every hex in that area,
deduping by unit id so a City touching two sea hexes at once is still
only paid once. Cliffs were never checked against the target City in
either the old or new code, so a City across a cliff edge from the
water already counted correctly; added a regression test to lock that
in given it was explicitly called out in the report.

Four new tests in `unitActions.test.ts`: a City reachable only through
a second water hex now counts; a City across a cliff edge from the
water counts; a City next to a *disconnected* second sea area (land gap
breaks the flood fill) does not count; a City bordering two hexes of
the same sea area is only paid once. 313 tests total (was 309); `tsc
-b`/`oxlint`/`npm run build` all clean.

## 33. Removed `GameState.log` — the history panel is now derived from `actionHistory`, like everything else event-sourced

Requested: stop persisting the running narration log as its own
ever-growing field on `GameState` (and therefore in every
`game_state` row written to Supabase), since it duplicates information
`actionHistory` already has; regenerate it from the action log instead,
the same way `turnReview.ts` already regenerates "what happened since
my last turn" on demand rather than storing it.

Every one of the ~20 `appendLog(state, playerId, message)` call sites
scattered across `applyAction.ts`, `boardSetup.ts`, `round.ts`,
`achievements.ts`, `elimination.ts`, and `cards.ts` wrote its message
straight into `state.log` as a side effect of the mutation that
triggered it — a City generating income, a round closing, an
achievement being claimed, and so on. Removing `log` from `GameState`
meant none of that context (card names, resource deltas, which unit
kind resolved what) was available to reconstruct after the fact from a
bare `LoggedAction` alone.

New `engine/gameLog.ts`'s `buildGameLog(genesis, actionHistory, ...)`
solves this the same way `buildTurnReview` already does: replay each
logged action for real via `applyAction` (so every phase transition,
achievement claim, and elimination actually happens, exactly as it did
live) and derive the display line(s) from the *before/after state
pair*, not from a value threaded through the mutation itself.
`describePrimaryAction` covers the one-line-per-action-type case
(reading the action's own payload plus a cheap before/after lookup —
e.g. a placed tile's terrain comes from which board hex's terrain
*changed*, not which hex is new, since a placed tile usually overwrites
an already-tracked seeded-water hex rather than adding a fresh one).
`describeCascade` covers everything that used to fire as a nested side
effect of a single dispatched action — achievement claims, eliminations,
a card resyncing between supply and hand, a new round beginning, the
game ending — generically, by diffing the relevant GameState slices,
since the same cascade (e.g. a round closing) can be triggered from
several different action types once every nested phase-transition
function has run its course.

Two cascade lines didn't survive the move to pure before/after diffing
and were dropped rather than faked: "player had nothing to purchase
back" (an auto-skip that can silently skip several players inside one
dispatch, with no reliable way to recover exactly who from just the
outer snapshot pair) and "a player's discard was recycled into their
hand" (indistinguishable, after the fact, from "this player's discard
was simply always empty" once later steps in the same cascade have
already cleared it). A related bug surfaced by the same before/after
approach: a "turn ends" line was firing off `pendingPlayerIds`, but
when the SAME dispatch also closed out the whole round, the *next*
round's select-cards phase had already reset `pendingPlayerIds` back to
include this player — so the check silently produced a false negative.
Fixed by skipping that line whenever the round also turned over in the
same dispatch (the "Round N begins" line already implies the turn
ended, so it's not a loss).

`RoundView`'s `LogPanel` now takes a `gameLog: GameEvent[]` prop
instead of reading `state.log`; `GamePage.tsx` computes it via a
`useMemo` alongside the existing `turnReview` one, replaying from
genesis on every `actionHistory` length change. Undo (`handleUndo`)
dropped its special "player X undid action Y" annotation entirely —
previously a synthetic log line that didn't itself re-enter
`actionHistory` (so it couldn't itself be undone); now the log is
derived fresh from whatever `actionHistory` remains after the undo, so
it just naturally narrates one fewer step with no annotation needed.

Also added: a "Copy JSON" button next to the existing "Show game state
JSON" debug toggle, writing the pretty-printed state to the clipboard
via `navigator.clipboard.writeText` — small, unrelated-to-the-log
request bundled into the same pass since it touches the same debug
panel.

New `gameLog.test.ts` (9 tests) covers the primary per-action messages,
the resource-delta suffix, the turn-ends/round-begins interaction bug
above, achievement-claim and card-zone-sync cascades, and the
board-setup-begins/tile-placed messages. Every test elsewhere that
asserted against `.log` text directly was ported to assert against the
underlying state change instead (achievements/elimination) or simply
dropped where it was purely redundant with an existing state assertion
(round.ts's purchase-skip test). `log.ts` and `GameEvent`'s old
"persisted forever" doc comment are gone; 319 tests total (was 313);
`tsc -b`/`oxlint`/`npm run build` all clean.

## 34. Real hotseat: multiple local players, pass-and-play, on one signed-in device

Requested: play hotseat with several players sharing a single browser —
add players without each needing their own login, and handle
simultaneous phases (choosing cards, declining) sensibly on one shared
screen. Chose to fix `hotseat` mode's actual behavior rather than add a
fourth `PlayMode` — it already existed as a selectable option and had
its own row in `games.play_mode`'s check constraint, but was
mechanically identical to `live`/`async` under the hood: every physical
player still needed their own Discord login, even sharing one device,
because `players` had `unique (game_id, user_id)` — one seat per auth
identity, full stop.

`supabase/migrations/0003_hotseat_local_players.sql` drops that
constraint (`unique (game_id, seat_index)` alone still guarantees no
two players occupy the same seat) and adds a `delete` RLS policy for
`players` (there wasn't one at all before — removing a mis-added local
player was silently denied) scoped to `user_id = auth.uid()`, same
self-only pattern as the existing insert/update policies.

New `gameApi.ts` functions: `addLocalPlayer(game, hostUserId,
displayName)` seats another player under the *host's own* user_id — no
separate sign-in, which is the entire point — validated against
`play_mode === 'hotseat'`, `status === 'lobby'`, and `max_players`, same
checks `joinGame` already made. `removePlayer(playerId)` undoes a
mis-added one pre-start. Both needed a real "next free seat" calculation
instead of `existingPlayers.length` — once a seat can be removed,
indices aren't contiguous, and reusing `.length` after a removal
collides with a still-taken higher seat_index. Pulled that into its own
`lib/seatIndex.ts` purely so `nextSeatIndex` could be unit tested at
all: `gameApi.ts` imports the live Supabase client at module load, which
throws in the test environment without a real project config (`.env.local`
isn't set for `vitest run` here), so anything meant to be testable in
isolation can't live in that file.

`LobbyPage.tsx`: hotseat games show a "Local player name" + Add button
(host only, pre-start) instead of the live/async "Join this game"
button, plus a Remove link per seated player. The generic "(host)"
badge is suppressed for hotseat, since every seat there shares the same
`user_id` and the badge would otherwise show on all of them.

`GamePage.tsx`'s actual pass-and-play mechanic: new `engine/turnOrder.ts`
exports `currentActorId(state)`, unifying board-setup's existing
`currentTilePlacerId`/`currentUnitPlacerId` with the round cycle's
`pendingPlayerIds[0]` into one "who must act right now, regardless of
game status" answer. GamePage tracks a separate `hotseatActivePlayerId`
(who the device is currently handed to — nothing to do with auth
identity) and shows a full-screen "Pass the device to <Name> — I'm
ready, continue" gate instead of the board/hand UI whenever
`currentActorId` differs from it, for every phase alike — simultaneous
ones (selectCards, decline) naturally get handled the same way as
turn-order ones, one player at a time, since `pendingPlayerIds[0]`
already means "next to act" either way; no phase-specific gating logic
needed. `me` (which `PlayerRow` the UI acts as) resolves from
`hotseatActivePlayerId` for hotseat instead of the auth-derived lookup
every other mode uses. This game has no hidden information by design
(see `GameEvent`'s doc comment) — the gate is a deliberate hand-off
courtesy for a shared physical device, not information hiding, so it
needed no engine changes at all: multiple `PlayerRow`s sharing one
`authUserId` was already fine at that layer (`Player.id` is the seat's
own uuid, `authUserId` is purely informational — see gameGenesis.ts).

6 new tests: `turnOrder.test.ts` (`currentActorId` across boardSetup's
two sub-phases, every active-status phase via `pendingPlayerIds`, the
`activePlayerId` fallback, and lobby/completed) and `seatIndex.test.ts`
(`nextSeatIndex` — contiguous roster, a gap left by a removed seat,
order-independence). 329 tests total (was 319); `tsc -b`/`oxlint`/`npm
run build` all clean; visually confirmed the pass-the-device gate and
lobby's add/remove-player UI via a screenshot.

**Not done by me**: the new migration (`0003_hotseat_local_players.sql`)
needs to actually be applied to the live Supabase project — I can't run
`supabase db push` or reach the SQL editor from here. Until it's
applied, adding a second local player to a hotseat game will fail
against the still-live `unique (game_id, user_id)` constraint.

## 35. Bug fix: a Nomad could "Produce Resource" on Plain (and City "Generate Income"/Ship "Trade" likewise) for zero payout, consuming its turn for nothing

Reported: a Nomad standing on Plain could pick Produce Resource even
though Plain isn't one of its producing terrains (`resourceByTerrain`
in content/units.json only has `forest`/`mountain` entries) — the
action was offered, and resolving it "succeeded" (ended the unit's
turn) despite producing nothing.

Root cause: `isActionAvailableForUnit` (actionTargeting.ts, gates which
options the radial action menu offers) treated `income`/`produce`/
`trade` as unconditionally available, on the reasoning that — unlike
create/transform/convert/trade-resource/move — they have no cost or
required target that could make them illegal. True, but incomplete:
their *terrain or adjacency* can still make them pay out nothing, which
is exactly as much a precondition as an unaffordable cost is for the
other action types. `applyResolveUnitAction` (applyAction.ts) mirrored
the same gap: a zero-payout produce/income/trade still counted as
"resolved" instead of being rejected like a failed create/transform
already was.

Fixed both ends by computing the real payout instead of just asking
"is this legal": pulled `applyIncome`/`applyProduce`/`applyTrade`'s
arithmetic out into three exported pure functions in unitActions.ts —
`computeIncomeGold`, `computeProduceAmounts`, `computeTradeGold` — used
by both the real apply functions (unchanged behavior there) and by
`isActionAvailableForUnit`, which now returns available only when the
computed payout is actually nonzero. On the dispatch side, this made
`ACTION_TYPES_WITH_PRECONDITIONS` (the set of action types eligible for
the "did this actually change the state?" rejection check) cover every
single action type there is — all 8 members of `UnitActionEffect` — so
the set itself became dead weight; removed it and made the "state
didn't change → not resolved" check unconditional instead. Verified
this doesn't accidentally start rejecting a resource-capped gain (e.g.
producing wood while already at the cap): `creditResource` only
short-circuits to the *same* state reference when the nominal amount is
`<= 0` — a capped-but-positive gain still returns a new (if
numerically-unchanged) state object, so it still correctly resolves,
matching the existing "a capped gain isn't lost, just clamped" design.

Both engine test files that had explicitly encoded the old "always
available"/"always succeeds" behavior got rewritten to assert the
opposite, plus new coverage for the "available/succeeds once the
terrain or adjacency actually pays out" side: `actionTargeting.test.ts`
now has separate income/produce/trade cases instead of one combined
"always true" one; `applyAction.test.ts` replaces its "does NOT reject
income for zero payout" test with one confirming it now IS rejected,
plus a new one confirming the same income succeeds normally once the
unit is standing on a producing terrain. 332 tests total (was 329);
`tsc -b`/`oxlint`/`npm run build` all clean.

## 36. Hotseat: option at game creation to skip the "pass the device" gate every turn

Requested: some hotseat groups don't want the "Pass the device to
`<Name>`" confirmation tap between every local player's turn (#34) —
add a creation-time option to skip it.

New `games.skip_hotseat_pass_gate` boolean column
(`0004_hotseat_skip_pass_gate.sql`, defaults `false` so existing/new
games keep today's behavior unless opted out), set via a checkbox in
`HomePage.tsx` that only appears once "Hotseat" is the selected play
mode, threaded through `createGame`'s new `skipHotseatPassGate` param.

`GamePage.tsx`'s gate logic (`needsHotseatGate`) now also requires
`!skip_hotseat_pass_gate`; when the setting IS on, `me` resolves
straight from `currentActorId(gameState)` (engine/turnOrder.ts) instead
of the separately-tracked, tap-to-confirm `hotseatActivePlayerId` —
every render just shows whoever must act next, with no confirmation
step to bypass. The board/hand UI itself needed no changes: it already
only cares which `PlayerRow` id `me` resolves to.

`tsc -b`/`oxlint`/`npm run build`/332 tests all clean (no test changes
needed — this only affects two GamePage.tsx-local derived values and a
HomePage.tsx-local form field, neither under existing test coverage,
consistent with how the rest of the hotseat pass-and-play flow was
built in #34); visually confirmed the new checkbox via a screenshot.

**Not done by me**: like #34's migration, `0004_hotseat_skip_pass_gate.sql`
still needs to be applied to the live Supabase project before the
checkbox actually works end-to-end — I can't reach the SQL editor or
run `supabase db push` from here.

## 37. Bug fix: a history-review resource-delta label ("+3 Gold" etc.) rendered as an unreadable dark bar instead of a pill

Reported: "the income generation label is not visible - only a small
part of the top shows." Reproduced via a real headless-browser
screenshot (not just unit tests, which don't catch layout bugs like
this) of a City that had just generated income with history review
turned on: the `historyLabel` badge rendered as a wide, dark,
rounded-rectangle bar overlapping the unit's own halo/glyph, with only
a thin sliver of the "+3 Gold" text peeking out — not the intended
small pill floating above the unit.

Root cause: the label's inner `<div>` (inside an SVG `<foreignObject>`)
used `inline-flex w-fit` to shrink-wrap tightly around its own text,
relying on CSS `fit-content` sizing. That doesn't reliably compute
inside a `foreignObject` in Chromium — instead of shrinking to the text,
the div expanded to fill the entire foreignObject's declared width
(`size * 3.4`, generously sized to fit worst-case text like "+1 Wood,
-5 Gold"), producing the oversized dark bar, with the actually-narrow
text left near one edge instead of centered — which is what "only a
small part... shows" was describing.

Fixed by not fighting the browser's foreignObject quirks: dropped
`w-fit`/`inline-flex` and made the div `h-full w-full` with
`items-center justify-center`, filling the foreignObject's already-sized
box exactly and centering the text within it — the identical, proven
pattern the action-menu radial option boxes a few lines below already
use for the same "text inside a fixed-size foreignObject" problem.
Also dropped the now-redundant `py-0.5` vertical padding, since
`h-full` + centering handles vertical spacing without it (that padding
had left uncomfortably little headroom against the label's other own
box's fixed height budget, a second near-miss worth closing while in
here even though it wasn't the reported bug's actual cause).

No unit test changes: nothing in the existing suite asserted on the
label's specific CSS classes, and RTL/jsdom doesn't run real CSS layout
(`fit-content` sizing, `foreignObject` clipping) — this class of bug is
invisible to the existing test infra by construction, which is exactly
why it shipped unnoticed. Verified only by real rendering: a fresh
headless-Chromium screenshot of both a short label ("+3 Gold") and the
longest realistic one ("-5 Gold, +1 Wood") confirmed both now render as
a normal, fully-legible pill. 332 tests unchanged; `tsc -b`/`oxlint`/
`npm run build` all clean.

## 38. Bug fix: a Convert action's legal-target indicator was invisible; mountain/plain terrain colors

Reported: picking a City's Convert action didn't show which hex was
targetable. Root cause: the "legal target" indicator was a small white
dot drawn in a hex's center — fine for Create/Transform, whose targets
are always empty hexes, but Convert's target is, by definition, a hex
with a unit already standing on it. Units render *after* ghost cells in
HexBoard's draw order, so the unit's own plate (also a light,
near-white color) painted directly over the dot, hiding it completely
rather than just making it hard to see.

Fixed per the report's own suggestion: replaced the center dot with a
whole-hex highlight (translucent green fill + green stroke), mirroring
the illegal-target hex highlight (red) that already existed right next
to it. Since a hexagon's corners extend well past a unit's circular
plate, the highlight stays visible around the unit regardless of
whatever's drawn on top of it in the center — confirmed via a
headless-browser screenshot of a City with a Nomad standing on the only
legal Convert target, showing a clearly visible green-outlined hex with
the Nomad still legible inside it. `RoundView.test.tsx`'s existing
Convert-targeting test updated to look for the new green hex
(`polygon[fill="rgba(34,197,94,0.25)"]`) instead of the old white dot.

Also requested: mountain terrain recolored to a clean grey (`#57534e`,
a warm stone tone easy to mistake for muddy, → `#71717a`, unambiguous
grey) and plain recolored to a lighter green (`#3f6212`, a dark
olive, → `#65a30d`, same hue family, clearly lighter/more vivid) — both
single-line changes in `HexBoard.tsx`'s `TERRAIN_COLOR` map, the only
place terrain colors are defined. Verified with a side-by-side
screenshot of all five terrains.

No test changes needed for the color swap (nothing asserts on the
literal hex values). 332 tests total (unchanged); `tsc -b`/`oxlint`/
`npm run build` all clean.

**Investigated, not changed**: a third report — "decline seems to have
triggered for a unit that was completely placed on the board; it
should only trigger when an achievement is claimed" — turned out not to
be a bug. `isDeclineTriggered` (`engine/decline.ts`) fires per rule 1/2:
*any* player reaching their per-kind unit supply limit, independent of
achievements — achievement claims only affect a separate rule (5): how
many cards a pending player must decline *that round*
(`beginDeclinePhase`'s `Math.max(1, achievementsClaimedThisRound)`), not
whether decline triggers at all. The pasted game state confirms this
fired correctly: player `0a2152ea...` has exactly 8 Nomads on the
board, matching `unitLimits.nomad: 8` — the same supply-cap threshold
that also happens to be what `nomad-mastery` claims against
(`claimedByAchievementId` shows exactly that), which is presumably what
made the two look connected. Both `decline.ts`'s own doc comment and
`todo.md` #5 (multi-card decline) describe this as intentional,
existing, tested behavior (`decline.test.ts`), so left as-is — flagged
back to the user rather than "fixing" documented, deliberate game rules
without confirming that's actually what's wanted.

## 39. Rules change: decline now triggers only on an achievement claim, not a unit-supply limit

Following up on #38's investigation — confirmed as a deliberate rule
change, not a misunderstanding this time: `isDeclineTriggered`
(`engine/decline.ts`) no longer checks whether any player reached a
per-kind unit supply limit (rule 1/2's original trigger); it now simply
checks `state.achievementsClaimedThisRound > 0`. Since achievements can
each only ever be claimed once for the whole game
(`claimedByAchievementId`) and `achievementsClaimedThisRound` resets to
0 every round, this can never re-trigger off the same claim twice,
matching the request.

This made `GameState.unitLimits` entirely dead: it existed solely to
feed the old trigger check, nothing else ever read it (the *real*
per-kind creation cap enforced during play is a separate value,
`UnitContent.unitSupplyCaps`, resolved independently and passed to
`applyCreate`/`applyConvert` — same source JSON, different pipeline).
Removed it end to end rather than leaving unused scaffolding: the field
itself off `GameState`, `createNewGame`'s `unitLimits` param,
`gameGenesis.ts`'s call into it, and `resolveContent.ts`'s
`resolveUnitLimits` (now nothing calls it). `decline.ts` lost
`getUnitLimit`/`countUnitsOfKind` alongside the old trigger logic — the
whole file is now four lines.

`decline.test.ts` rewritten from scratch around the new one-line rule
(was/still is 3 tests, now about `achievementsClaimedThisRound`
directly rather than constructing units at a supply cap).
`round.test.ts`'s three decline-phase tests that used to manufacture a
triggering condition via `cityUnits` at a fake `unitLimits` cap now just
set `achievementsClaimedThisRound` directly on the fixture state — one
of them already needed to for the *card-count* rule (5) and gets
simpler for losing the now-redundant unit-limit setup entirely. Every
other test file's fixture just drops the now-nonexistent `unitLimits:
{}` field (mechanical, no behavior asserted). 328 tests total (was
332 — decline.test.ts is 3 tests instead of the old file's 7, nothing
else changed count); `tsc -b`/`oxlint`/`npm run build` all clean.

## 40. Board generation rule 4 (no-space), simplified: reject instead of relocating tiles

Per ruling (requested simplification): rather than the original
no-space rule — when a tile can't legally be placed anywhere, move one
or more already-placed *uncovered* tiles elsewhere to open up room,
using the fewest tiles moved — `placeTile()` now just checks, right
after applying a placement, whether every one of the tier's own
*remaining* tiles (same shape, same `placesOn`) would still have
*somewhere* legal to go. If not, the whole placement is rejected
outright (same "illegal placement" outcome as any other rejected
`PLACE_TILE`) and the player has to choose a different anchor/rotation
instead — no tile-relocation search needed at all.

New `hasAnyLegalPlacement(board, shapeCells, placesOn)` in
`boardGeneration.ts`: every legal placement's own anchor cell (local
`{0,0}` — every real shape in `content/terrain.json` follows this
convention, confirmed by inspection) must itself land on a hex the
shape is allowed to cover, so the search only needs to try anchoring
each cell of each of the 6 rotations onto each currently-tiled hex with
a qualifying terrain — no need to search the otherwise-unbounded plane
of empty coordinates. `placesOn: null` (water) is the one terrain with
no such hexes to anchor against, but the board is unbounded, so there's
always room somewhere for it and the function short-circuits to `true`
without searching. `placeTile()` (`boardSetup.ts`) calls this with the
*post*-placement board (matching "after a tile is placed..." from the
request) and only when the tier has tiles left to place afterward — the
very last tile in a tier obviously doesn't need to leave room for
itself.

One pre-existing `boardSetup.test.ts` fixture broke under the new check
and needed a fix, not a new bug: a test asserting a single placement
*succeeds* had `tilesRemainingInTier: 3` (2 more owed afterward) but a
board with only exactly enough water for the one placement being made —
previously harmless, since nothing checked ahead; now correctly caught
as "would strand the other 2." Fixed by giving it a second disjoint
water pair elsewhere on the board, preserving everything the test
actually asserts.

7 new tests: `boardGeneration.test.ts` covers `hasAnyLegalPlacement`
directly (always-true for `placesOn: null`, false with no qualifying
hexes at all, false with qualifying hexes present but none adjacent to
each other, true with a legal spot available, and true for a placement
that only fits after rotation); `boardSetup.test.ts` covers the
integration — `placeTile` rejecting a placement that would strand the
tier's last tile, and allowing the same shape/tier when a legal spot
remains. 335 tests total (was 328); `tsc -b`/`oxlint`/`npm run build`
all clean. Also updated `PROJECT_PLAN.md`'s stale "not yet built" note
on this exact item to reflect the simplified rule now shipped.

## 41. Investigated: terrain scoring values aren't in place yet; the player-display score math is correct

Asked whether terrain scoring values were in place, and flagged the
player display's score as possibly not accounting for terrain control.

**Values: not in place.** `content/terrain.json`'s `victoryPoints` is
`0` for all five terrains (`water`/`plain`/`forest`/`mountain`/
`glacier`) — still the section-1 placeholder `PROJECT_PLAN.md` already
calls out ("the real per-unit/per-terrain/per-achievement VP numbers
are still placeholders — the rule itself is settled"). Only
`scoresAs` (Glacier merging into Mountain for region purposes) has a
real, non-default value. Didn't invent numbers to fill this in — that's
a game-balance decision for the user to make, not something to guess at.

**Display math: correct, not the bug.** Traced the whole path —
`RoundView.tsx`'s `currentScoreByPlayerId` calls
`calculateTerrainControlVP(state.board, state.units,
achievementContent.terrainVictoryPoints, achievementContent.terrainScoresAs)`
exactly as `victoryPoints.ts`'s `sumVP` expects, and
`resolveAchievementContent()` (`content/resolveContent.ts`) does read
`terrainType.victoryPoints`/`terrainType.scoresAs` for every terrain
into `AchievementContent`. Confirmed this actually works end to end
(not just by reading the code) with a new RTL test: a real 2-hex Plain
region, a 2-unit majority for one player, and `terrainVictoryPoints: {
plain: 3 }` — the displayed score correctly comes out to `6`
(3 VP × 2 hexes). With every terrain's real VP at 0, that same
calculation still runs correctly — it just always contributes 0, which
reads identically to "not accounting for terrain control" without
actually being that.

Caught a mislabeled existing test in the process: an existing "computed
live from achievements/board-count/terrain-control" test never actually
exercised the terrain-control or board-count terms at all — its board
was `createEmptyBoard('hex')` with zero units, so those terms always
had nothing to compute over. Retitled it to what it actually covers
(achievements only) rather than leaving a misleadingly-broad claim
sitting next to a test that now genuinely covers the terrain-control
case. 336 tests total (was 335); `tsc -b`/`oxlint`/`npm run build` all
clean.

## 42. Real terrain victory-point values

Filled in `content/terrain.json`'s per-terrain `victoryPoints`
(previously all `0` placeholders — see #41): Plain 1, Water 2, Forest
3, Mountain 4. Glacier's own `victoryPoints` is never actually read for
scoring (`scoresAs: "mountain"` merges Glacier hexes into Mountain
regions, which score at Mountain's rate — see `scoring.ts`'s
`calculateTerrainControlVP`/`effectiveTerrain`), but set it to 4 to
match anyway rather than leave a stale, misleading `0` sitting next to
a field that says "treated as mountain."

No test changes — #41 already added real regression coverage for the
terrain-control scoring path (`RoundView.test.tsx`) using synthetic
values, and no existing test asserts on `terrain.json`'s literal
numbers. Verified end-to-end with a one-off script calling
`resolveAchievementContent()` against the real file and confirming
`terrainVictoryPoints`/`terrainScoresAs` come out as `{ water: 2,
plain: 1, forest: 3, mountain: 4, glacier: 4 }` / `{ ..., glacier:
"mountain" }`. 336 tests unchanged; `tsc -b`/`oxlint`/`npm run build`
all clean.

## 43. Fixed: rule 4's no-space check only looked one tile ahead, not all of them

Bug report with a real game state: `boardSetup.tilesRemainingInTier: 2`,
and the only legal placement left on the board got rejected — meaning a
tile should have already been rejected earlier, not this one.

Confirmed against the real board data and the real Plain "wedge" shape
(`content/terrain.json`) with a one-off script using the actual engine
functions: exactly one legal placement existed, and using it would leave
the board's very last Plain tile with nowhere to go — a genuine
zero-legal-moves deadlock.

**Root cause:** `hasAnyLegalPlacement()` (added for #40's rule 4) only
checked whether *one more* tile could still be placed after the current
one, not whether *all* of the tier's remaining tiles could. A placement
can pass that shallow check (one spot remains right after it) while still
leaving too little room for the tiles still owed beyond that — the
shortfall doesn't surface until whichever placement is the one that
actually runs out of room, which can be the *only* legal move left, with
nothing else to fall back on.

**Fix:** replaced `hasAnyLegalPlacement()` with `canPlaceRemainingTiles()`
(`src/engine/boardGeneration.ts`), which greedily finds a legal placement,
applies it to a working copy of the board, and repeats once per remaining
tile — rejecting the whole placement if any iteration comes up empty.
`boardSetup.ts`'s `placeTile()` now passes the tier's actual
`tilesRemainingInTier` count through instead of implicitly checking for
just one. This is a greedy approximation (a different placement order
could in principle find room this doesn't) rather than an exhaustive
search, matching the ruling's own "make sure all other tiles of the same
terrain type are placeable."

This fixes the check going forward for new games. It can't repair a save
that already reached this exact deadlock, though — the damage (an earlier
placement that the old shallow check should have rejected but didn't) is
already baked into that game's `actionHistory`; the corrected check, run
against the reported state, agrees there is no longer any legal move at
all. That specific game needs a board-setup restart, not a check fix.

Added direct coverage for `canPlaceRemainingTiles()` in
`boardGeneration.test.ts` (including a case where an earlier virtual
placement's terrain conversion changes what's still available for a
later one) and an integration case in `boardSetup.test.ts` reproducing
the reported bug's shape: a placement that leaves room for only one of
two still-owed tiles is now rejected, where it previously wasn't. 340
tests total (was 336); `tsc -b`/`oxlint`/`npm run build` all clean.

## 44. Auto-place a tier's remaining tiles once there's only one legal way left

Follow-up to #43: "if a tile is placed and after that there is only a
single way all other tiles from the terrain can be placed, just fast
forward the placement (skipping players' decisions, but respecting
player order)."

**`findForcedPlacement()`** (`src/engine/boardGeneration.ts`) answers
"is there exactly one way left to place all of this tier's remaining
tiles" — not just whether room exists (that's `canPlaceRemainingTiles()`
from #43), but whether the *set* of hexes each remaining tile ends up
covering is uniquely determined. It enumerates every distinct legal
placement (deduped by covered cell-set, since a symmetric shape can
reach the same cells via more than one rotation), then backtracks for
disjoint combinations of `count` of them, stopping the moment a second
combo turns up — "is it unique" only needs telling one apart from more
than one, never a full enumeration. Capped at 60 distinct legal
placements before attempting that search: a shape with that much open
room essentially never turns out forced anyway, so the cap just skips
paying for the search in the case where it wouldn't have found anything,
without changing the answer for any board small enough to plausibly be
forced.

**Wiring this into live play needed a real design fix, not just a call
site.** The obvious approach — cascade inside `applyAction()` itself,
logging each auto-placement as its own `actionHistory` entry via a
recursive `applyAction()` call — breaks event sourcing: `replayActions()`
(`src/engine/replay.ts`) calls `applyAction()` once per already-logged
entry, so replaying a fast-forwarded entry would trigger the cascade
*again* and collide with the next real logged entry (the hexes it tries
to place on are already covered). Caught this by tracing through what
replay would actually do with the resulting log, not just by running the
new tests.

Fixed by keeping `applyAction()` a pure one-action-in/one-log-entry-out
reducer (unchanged from before this todo item) and adding a new wrapper,
`applyActionAndFastForwardTiles()`, that live callers use instead: it
calls `applyAction()` for the real submitted action, then — only for
PLACE_TILE — keeps asking `findForcedPlacement()` what's forced next and
submitting *that* through `applyAction()` too (attributed to
`currentTilePlacerId()`, so turn order still advances correctly through
the skipped decisions), until nothing's forced anymore. Every placement,
human or auto, still lands its own ordinary `actionHistory` entry;
replay just replays that flat list of entries with the plain
`applyAction()`, no cascading needed since there's nothing left to
decide by the time replay gets there. `GamePage.tsx`'s `submitAction`
now calls this wrapper instead of `applyAction()` directly; nothing else
(replay, undo, the round-mechanics call sites) changed.

Added `findForcedPlacement()` coverage in `boardGeneration.test.ts`
(unique vs. ambiguous single-tile and 2-tile cases, including the
shared-cell-chain shape from #43's tests) and `applyActionAndFastForwardTiles()`
integration coverage in `applyAction.test.ts`: a manual placement that
makes the rest of the tier forced correctly cascades through both
remaining tiles with the right player attribution and turn order, and a
manual placement that leaves real ambiguity (3 independent pairs, 2
tiles owed) correctly does *not* auto-place anything. 347 tests total
(was 340); `tsc -b`/`oxlint`/`npm run build` all clean.

## 45. Two more starting-water-placement rules: touch 2 Sea tiles, never enclose empty space

"There are two additional rules related to the initial water placement:
the added Sea tile must touch at least 2 Sea tiles already present in the
World. You cannot close off a zone containing empty spaces."

Both are new checks in `src/engine/boardGeneration.ts`, wired into
`boardSetup.ts`'s `placeTile()` only when `tierContent.placesOn === null`
(only Water's expansion tier lands on untiled holes at all — every other
tier's normal covering rule already implies contiguity with what's below
it, so these don't apply there):

- **`touchesEnoughExistingTerrain(board, placedCells, terrain, minCount)`**
  counts the distinct existing hexes of `terrain` adjacent to
  `placedCells` (cells inside the new placement itself don't count — they're
  still holes) and checks it against `minCount`. `boardSetup.ts` calls it
  with `minCount: 2` via a new `WATER_EXPANSION_MIN_TOUCHING` constant.
- **`wouldEncloseEmptyHexes(board, placedCells)`** answers "you cannot
  close off a zone containing empty spaces" exactly, not heuristically:
  it takes the bounding box of every tiled hex (existing + the new
  placement) expanded by one hex of margin — that margin ring is
  guaranteed tile-free by construction, so it's genuinely connected to
  the true, infinite exterior — then flood-fills untiled hexes inward
  from the margin. Any untiled hex inside the box the flood fill never
  reaches is sealed off with nowhere to go, and the placement is
  rejected.

Fixed a pre-existing doc/implementation drift while updating
`content/README.md`'s board-generation section for these two new rules:
its "No-space rule" paragraph still described the *original*
already-placed-tiles-get-relocated design, even though #43 had already
replaced that with the simplified outright-rejection version. Reworded
it to match what `canPlaceRemainingTiles()` actually does, and added a
line about #44's forced-placement fast-forwarding too, which the doc
was also missing.

The existing end-to-end real-content test in `boardSetup.test.ts`
("runs a small real board-setup sequence...") placed its two
water-expansion tiles deliberately far from the seeded starting water,
specifically *to avoid* interacting with other tiles — that placement is
now illegal under the new touching rule. Replaced it with a small
brute-force search helper (`findAnyValidWaterExpansionPlacement`) that
finds any placement satisfying all the real rules near the seeded water,
instead of hand-computing exact hourglass-shape coordinates.

Added direct coverage for both new functions in `boardGeneration.test.ts`
(minimum-touching-count edge cases, a ring-closing single-hex enclosure,
and a ring left open with a gap) and `placeTile()` integration coverage
in `boardSetup.test.ts` (reject for too few touching Sea tiles, reject
for sealing off an empty pocket, allow a placement satisfying both).
357 tests total (was 347); `tsc -b`/`oxlint`/`npm run build` all clean.

## 46. Fixed: placement ghost showed green even when illegal (e.g. #45's touching rule)

Bug report: during board setup, the to-be-placed tile preview showed
green (legal) even when it couldn't actually be placed — e.g. when it
didn't touch 2 existing Sea tiles.

Root cause: `BoardSetupView.tsx`'s ghost-legality check only called
`isLegalTilePlacement()` (the basic covering/holes rule) — it never knew
about #43's rule 4 (room for the rest of the tier) or #45's two
Sea-only rules (touching, enclosure), so any placement that failed one
of *those* but passed basic covering rendered green and had its Confirm
button enabled, even though submitting it would just bounce off
`placeTile()`'s rejection.

Fixed by extracting `placeTile()`'s legality checks (everything before
it actually mutates the board) into a new exported
`checkTilePlacementLegality(state, anchor, rotationSteps, content)` in
`boardSetup.ts`, returning the same error string `placeTile()` would (or
`null` if legal) — `placeTile()` now calls it too, so there's exactly
one place these rules live instead of two copies that could drift out
of sync again. `BoardSetupView.tsx` uses it for the ghost/Confirm-button
legality instead of the narrower one-rule check, and now also surfaces
the specific rejection reason as text next to the Confirm button (e.g.
"A new Sea tile must touch at least 2 Sea tiles already on the board")
instead of just a disabled button with no explanation.

Also added `data-coord`/`data-ghost-coord` attributes to `HexBoard.tsx`'s
hex and ghost `<polygon>` elements — small, non-behavioral, but needed to
click a specific hex and assert a specific ghost's color in an RTL test;
worth keeping since any future board-setup UI test will want the same
hook.

Added `checkTilePlacementLegality()` coverage in `boardSetup.test.ts`
(mirroring each of `placeTile()`'s own rejection cases, plus confirming
it doesn't gate on whose turn it is) and a new
`BoardSetupView.test.tsx`: clicking a hex that fails the touching rule
renders both covered ghost cells red with the Confirm button disabled
and the reason visible; a placement satisfying every rule renders green
with Confirm enabled. 365 tests total (was 357); `tsc -b`/`oxlint`/`npm run build` all clean.

## 47. Fixed: "touch 2 Sea tiles" was counting hexes, not physical tiles

Bug report with a real game state: a Sea tile got placed touching only
one earlier tile — via 2 of *that one tile's* hexes, both adjacent to a
single cell of the new tile.

Traced the exact reported placement (anchor `(8,0)`) against the real
board and confirmed `touchesEnoughExistingTerrain()` was working exactly
as built: it counted 2 distinct *hexes* (`(6,1)`/`(6,2)`), not noticing
both belonged to the same earlier tile placement. Asked which reading of
"touch at least 2 Sea tiles" was intended — 2 distinct hexes (current
behavior) vs. 2 distinct physical tile pieces vs. 2 of the new tile's own
cells each independently touching something — user confirmed: 2 distinct
physical tiles. Two adjacent hexes of one earlier Sea tile should only
count as touching that one tile, not two.

This needed real data: the board had no memory of which hexes came from
the same placement. Added `Tile.placementId?: string` (`types.ts`) — set
by `applyTilePlacement()`/`seedStartingWaterTiles()`
(`boardGeneration.ts`) whenever a tile is actually placed, `undefined`
for a hex from before this field existed or built directly with
`setTile()` in a test. `setTile()`/`applyTilePlacement()` both take an
optional `placementId` — omitted for rule 4's virtual/hypothetical
placements (never read there, since those never touch the water tier at
all — it always short-circuits). `seedStartingWaterTiles()` doesn't have
`GameState`/`idSequence` access (it builds a fresh board from scratch,
before anything else exists), so it just tags each hourglass with a
simple per-anchor index (`seed_0`, `seed_1`, ...) — no collision risk
since nothing else exists yet to collide with. `boardSetup.ts`'s
`placeTile()` generates a real one via `nextSequenceId()` for every real
placement (any tier, not just water — simpler than special-casing, and
harmless since nothing reads it outside water).

`touchesEnoughExistingTerrain()` (renamed internally to
`adjacentExistingTilePlacementCount`) now counts distinct
`placementId`s among the new placement's neighboring hexes of the target
terrain, falling back to a hex's own coordinate as a standalone
single-hex "tile" when `placementId` is `undefined` — so an
already-persisted game (or a test board built with raw `setTile()`) still
gets a sane, non-crashing count instead of every untagged hex wrongly
merging into one.

Added coverage in `boardGeneration.test.ts`: `applyTilePlacement()`
tags/doesn't tag hexes as expected, `seedStartingWaterTiles()` gives each
hourglass its own distinct id, and — the core fix —
`touchesEnoughExistingTerrain()` now correctly tells "2 hexes, 1 tile"
(false) apart from "2 hexes, 2 tiles" (true). Added an integration test
in `boardSetup.test.ts` that places a real tile via `placeTile()` (a real
generated `placementId`), then attempts a second real placement touching
2 hexes of that same tile — reproducing the exact reported bug end to
end. 371 tests total (was 365); `tsc -b`/`oxlint`/`npm run build` all clean.

## 48. Fixed: Undo/replay could falsely reject an already-accepted placement (rule 4's greedy check was too weak)

Bug report: Undo didn't work on a real in-progress game.

Traced it with the real reported game state: `GamePage.tsx`'s Undo
rebuilds state by replaying `actionHistory` from genesis
(`replayActions`, one `applyAction()` call per logged entry — see
`gameGenesis.ts`). Reconstructing this exact game from genesis and
replaying its real history (using the real `content/terrain.json` and
`resolveBoardGenerationContent()`) failed partway through — not just for
the N-1 replay Undo needs, but for the *full* N-action replay too: one
of the game's own already-accepted Plain-tile placements got rejected by
rule 4 (`canPlaceRemainingTiles`, `This placement would leave no legal
spot for the rest of this tier`) on replay, even though it's in the
game's own persisted history, meaning it really was accepted live.

Since `applyAction()` is a pure, deterministic function of state, the
same action replayed against the same preceding history must evaluate
identically to how it did live — so this wasn't a "rules changed
between live play and now" question, it was a real determinism/
correctness bug. Proved it with a brute-force search: at that exact
point, 8 more Plain tiles were genuinely still placeable somewhere on
the board (found a valid arrangement in 10 search steps), but
`canPlaceRemainingTiles`'s old implementation — greedily taking
whichever legal spot `Object.values(board.tiles)` iteration found
*first*, applying it, and repeating — committed to a first choice that
stranded 3 of the 8, and never backtracked to try a different one. This
matches the doc comment I'd already written for it ("a different choice
of which legal spot to fill first could leave room where this doesn't")
— confirmed here as a real, reproducible false rejection, not just a
theoretical caveat.

Replaced the naive greedy loop with real backtracking: `findAllLegalPlacements()`
+ `findDisjointCombos()` (already built for #44's `findForcedPlacement`)
now answer `canPlaceRemainingTiles` too — "does at least one combination
of `count` pairwise-disjoint placements exist," found via actual search
rather than a single greedy pass, capped by a shared step budget
(`COMBO_SEARCH_STEP_BUDGET`, 200k) so a pathological board can't hang
the check; running out of budget conservatively reports "no room,"
matching rule 4's existing bias toward rejecting when unsure. Dropped
`canPlaceRemainingTiles`'s now-unused `terrain` parameter (the old
implementation needed it to apply virtual placements to a working board;
the new one only checks cell-disjointness, never touches terrain) and
updated its one call site (`boardSetup.ts`).

Added a synthetic counterexample in `boardGeneration.test.ts` that
deliberately reproduces the failure mode (a 4-hex chain inserted so the
first-found placement is the *middle* edge, stranding both ends) and a
real-data regression test in `boardSetup.test.ts` replaying the actual
reported game's first 14 actions end to end through `applyAction()` with
real `content/terrain.json` — the 14th placement, which used to fail on
replay, now succeeds. 373 tests total (was 371); `tsc -b`/`oxlint`/`npm run build`
all clean.

## 49. Fixed: Produce Resource stayed clickable (and wasted a turn) once already at the Wood/Stone cap

Bug report: "the produce resources option should be disabled if resource
limit is hit."

`actionTargeting.ts`'s `isActionAvailableForUnit()` — which both disables
an action's radial-menu option and gates whether `RESOLVE_UNIT_ACTION`
even attempts it — only checked whether Produce's *nominal* effect amount
was nonzero for the unit's terrain (already fixed for the "wrong
terrain" case a while back). It never checked whether the player could
actually receive it: once Wood or Stone is at its player cap (5, per
`content/resources.json`), or the shared bank is out, `gainResource()`
(`resources.ts`) silently clamps the real gain to 0 — so Produce stayed
enabled and clickable, consuming the unit's turn for nothing.

This turned out to be a real engine-level gap too, not just a UI one:
`applyResolveUnitAction` (`applyAction.ts`) detects a no-op action via
state *reference* equality (`nextState === beforeState`) so it doesn't
get marked resolved — but `creditResource()` (`unitActions.ts`) always
built a new state object via spreads whenever the *nominal* amount was
positive, even when the *actual* gain clamped to 0. A fully-capped
credit was therefore a value-identical-but-distinct object, silently
slipping past the no-op check and getting marked resolved anyway. Same
gap for Income, Trade, and Trade-Resource's buy mode (all pay through
the same `creditResource`), though only Produce and buying Wood/Stone
can actually hit a *player* cap today (Gold's `playerCap` is `null`) —
bank depletion is the more general case, which mattered in practice too
(the reported game's `resourceBank` was down to `wood: 10, stone: 10`).

Fixed at the root: added `wouldGainResource()` (`resources.ts`, next to
`gainResource()`) — true only if crediting would actually move something
(positive amount, bank has some, player isn't already at cap).
`creditResource()` now short-circuits to the *same* state reference when
`wouldGainResource()` is false, so the existing reference-equality no-op
check catches every one of these cases uniformly, not just Produce.
`isActionAvailableForUnit()`'s income/produce/trade/trade-resource(buy)
cases now use the same `wouldGainResource()` check (with the player's
actual resources/bank/cap), so the UI and the engine always agree on
what "would actually pay out" means.

Added `wouldGainResource()` unit coverage in `resources.test.ts`,
`isActionAvailableForUnit()` coverage in `actionTargeting.test.ts`
(Produce disabled at the Wood cap and once the bank is empty,
Trade-Resource's buy mode disabled at cap despite being affordable), a
reference-equality regression test in `unitActions.test.ts` confirming a
fully-capped Produce returns the exact same state object, and an
end-to-end `RESOLVE_UNIT_ACTION` regression in `applyAction.test.ts`
mirroring the existing "unaffordable Transform"/"zero-payout Income"
tests. 384 tests total (was 373); `tsc -b`/`oxlint`/`npm run build` all
clean.

## 50. Fixed: history-review labels overlapping; "Show history" wrongly disabled at the start of a round

Two UI bug reports from the same board-view code.

**Overlapping labels.** `HexBoard.tsx` drew each unit's history-review
label (e.g. "+1 Wood") at a fixed offset from its own hex, independent
of every other unit — but a label (`size * 3.4` wide) is wider than the
gap between adjacent hexes, so two nearby units with labels always drew
right on top of each other. Added `computeHistoryLabelPositions()`: each
labeled unit greedily claims the first vertical slot, stacked downward
in label-height steps, that doesn't overlap a slot an earlier unit
already claimed nearby — not a general layout solver, but enough to
separate the common case of two or three units near each other. The
board's own bounding-box calculation now accounts for the stacked
position too, so a bumped-down label can't get clipped off the bottom
of the SVG.

**"Show history" disabled in the choose-card phase.** `RoundView.tsx`
disabled the button whenever the computed review had zero events, not
just when it failed to compute at all. `findReviewWindowStart()`
(`turnReview.ts`) anchors the reviewed window at "since I myself last
acted" — which is empty precisely when *I* am the most recent entry in
`actionHistory`, i.e. right after finishing the last action of a round.
Since finishing a round always drops the game into the next round's
`selectCards` phase, whoever acted last every round would find the
button disabled the moment they saw that phase — not a rare edge case,
but true once a round for whichever player wraps it up. Changed the
button to only disable on `!turnReview` (review couldn't be computed at
all, e.g. very start of the game); a real, empty review is still
clickable, now showing "Nothing since your last turn." instead of
silently doing nothing.

Added `computeHistoryLabelPositions()` coverage in `HexBoard.test.tsx`
(two adjacent units get staggered apart, two far-apart units don't get
staggered, no label element at all for a unit with none) and updated/
added `RoundView.test.tsx` coverage for the button's corrected disabled
condition and the new empty-review hint text. 388 tests total (was
384); `tsc -b`/`oxlint`/`npm run build` all clean.

Also reported in the same message: "mountaineer is not able to go on
water." Traced `legalMoveDestinations()` (`movement.ts`) against the
real `content/units.json` movement profile (`terrains` included
`water`, `canCrossCliffs: true`) with a script reproducing the exact
board + full unit list from the report — a Mountaineer next to a Water
hex had that hex as a legal move destination, which read as the engine
working correctly. Asked the user what specifically happened when they
tried it, expecting a UI-level repro — the actual answer flipped the
diagnosis entirely: "Mountaineers are not allowed to be on water" is the
*rule*, and the engine allowing it was the bug. `content/units.json`'s
mountaineer `movement.terrains` had `"water"` in it, which was simply
wrong content, not an engine logic error — removed it (now
`["plain", "forest", "mountain", "glacier"]`). Added a real-content
regression in `unitActions.realContent.test.ts` confirming a Mountaineer
can no longer move onto Water but still can onto every other terrain in
its list. 389 tests total (was 388); `tsc -b`/`oxlint`/`npm run build`
all clean.

## 51. Temple's Convert Enemy Unit now costs gold, varying by the target's kind

User supplied the real costs: 2 gold for a Nomad, 3 for a Mountaineer, 5
for a Merchant or Ship. Previously flat-costed at `{gold:0,wood:0,stone:0}`
(a placeholder).

`ConvertEffect.cost` (`unitContent.ts`) is a single flat `ActionCost` —
fine for City's "own" upgrade conversions (always the same cost
regardless of which Nomad gets upgraded), but Temple's "enemy" steal
needs a different cost per *target* kind. Added an optional
`costByTargetKind?: Record<string, ActionCost>` alongside it, checked
first and falling back to `cost` when the target's kind has no entry.

This meant `legalConvertTargets()`'s affordability check
(`actionTargeting.ts`) could no longer happen once, up front, for the
whole action — it now has to run per candidate hex, after the target
(and therefore its cost) is known, so a target the player can't afford
correctly drops out of the legal-target list while an affordable one
right next to it doesn't. `applyConvert()` (`unitActions.ts`) resolves
the same per-target cost before paying it.

`content/units.json`'s `convert-enemy-unit` now sets
`costByTargetKind: { nomad: 2, mountaineer: 3, merchant: 5, ship: 5 }`
(all gold) — `targetMobileOnly: true` means these 4 kinds are the only
ones this action can ever target, so the table is exhaustive; `cost`
stays as an unused fallback.

Added coverage in `unitActions.test.ts` (charges the per-kind cost, not
the flat fallback; rejects when affordable overall but not for this
specific target), `actionTargeting.test.ts` (per-target affordability
filtering, not a single up-front check), and a real-content regression
in `unitActions.realContent.test.ts` converting one of each of the 4
real target kinds in sequence and checking the exact gold balance after
each. 393 tests total (was 389); `tsc -b`/`oxlint`/`npm run build` all
clean.

## 52. Gold now counts toward victory points (4th VP source)

Bug report: "I am pretty sure gold is not counted as part of the
victory point display." Confirmed — `currentScoreByPlayerId()`
(`RoundView.tsx`) and `finishRound()`'s end-of-game total
(`round.ts`) both only ever summed 3 sources (achievements,
board-count, terrain-control); gold never factored in anywhere, and
there was no placeholder field for it either (unlike terrain/
achievement VP, which had real `0`s waiting to be filled — this was a
genuinely missing source). Asked the user for the exact conversion
rule: 2 gold = 1 VP (rounded down).

Added `goldVictoryPoints.goldPerPoint` to `achievements.json` (and its
schema) — `2`, matching the same content-driven pattern every other VP
source already uses. `AchievementContent.goldPerVictoryPoint` (`number
| null`, `null` = gold doesn't count, matching `EMPTY_ACHIEVEMENT_CONTENT`'s
safe-default convention) is resolved from it in `resolveContent.ts`.
New `calculateGoldVP(players, goldPerVictoryPoint)` in
`victoryPoints.ts` — `Math.floor(gold / goldPerVictoryPoint)` per
player, `{}` (0 for everyone) when `null`. Wired into both places that
were missing it: `round.ts`'s `finishRound()` (the real win check) and
`RoundView.tsx`'s `currentScoreByPlayerId()` (the live score shown
during play) — both now sum all 4 sources via the same `sumVP()`.

Corrected a few other stale "three VP sources" references found while
touching this (`types.ts`'s `winnerPlayerIds` doc comment,
`content/README.md`'s achievements.json section, `PROJECT_PLAN.md` —
the latter also still claimed VP numbers were placeholders and there
was no real board yet, both no longer true since `todo.md` #41/#42 and
the board-generation work).

Added `calculateGoldVP()` coverage in `victoryPoints.test.ts` (rounds
down, scores 0 gold as 0 not omitted, `null` scores everyone 0), an
end-of-game integration test in `round.test.ts` (gold VP tips an
achievement-VP tie into an outright win — only possible if gold is
really being counted), and a live-score test in `RoundView.test.tsx`
mirroring the existing achievement/terrain-control score tests. 399
tests total (was 393); `tsc -b`/`oxlint`/`npm run build` all clean.

## 53. Real end-of-game screen: every player's final VP and its breakdown

Feature request: "Work on end game screen, Show all players, their
final VPs, and the breakdown of their VPs." Previously `GamePage.tsx`
only rendered a bare "Winner(s): name" banner once `status ===
'completed'` — no per-player scores, no indication of *why* anyone
won.

Added `calculateVPBreakdown(state, achievementContent)` to
`victoryPoints.ts` — the one place that combines all four VP sources
(achievements/board-count/terrain-control/gold) per player into a
`{ achievements, boardCount, terrainControl, gold, total }` record,
covering every player in `state.players` even at all-0 (unlike the
individual `calculate*VP` functions, which omit a 0-scoring player
entirely). `round.ts`'s `finishRound()` (the real win check) and
`RoundView.tsx`'s `currentScoreByPlayerId()` (the live score shown
during play) were both re-implementing this same four-source sum
inline — refactored both to call the shared function instead, so the
combination now lives in exactly one place.

New `EndGameView.tsx` component: every player, ranked by total VP
descending, in a table with one column per VP source plus the total;
winner(s) — per `state.winnerPlayerIds`, no tiebreaker — get a trophy
and highlighted styling; eliminated players are marked. Wired into
`GamePage.tsx` in place of the old bare banner.

Added `calculateVPBreakdown` coverage in `victoryPoints.test.ts`
(combines all four sources with a correct total, includes a
0-everything player, includes every player even with no achievement
content supplied) and a new `EndGameView.test.tsx` (ranks players by
total VP, shows the per-source breakdown, highlights the winner(s)
with a trophy, handles a multi-winner tie). 405 tests total (was 399);
`tsc -b`/`oxlint`/`npm run build` all clean.

## 54. Click a player's status chip for their full breakdown

Feature request: "Allow pressing on a player's info panel to get more
information about: their full VP breakdown, cards and their locations,
unit counts, resources." The in-round `PlayersStrip` chip already
summarized a few of these (current score total, gold/wood/stone, hand
kinds), but had no room for more without cluttering the always-visible
strip.

Turned each player's chip into a click-to-expand toggle (state kept
locally in `PlayersStrip` — clicking the same player again, or clicking
a different player, closes/switches it; only one open at a time). The
expanded `PlayerDetailPanel` shows: the full VP breakdown by source
(achievements/board-count/terrain-control/gold — via the existing
`calculateVPBreakdown`, not just the total on the chip), every card
zone by unit kind (hand, currently-played, discard, decline, supply —
new `cardKindsInZone()` helper), on-board unit counts per kind, and
full resources (gold/wood/stone).

Added `RoundView.test.tsx` coverage: the panel starts collapsed and
appears with the right breakdown/cards/units/resources on click,
collapses again on a second click, and switching to a different
player's chip replaces (rather than stacks) the open panel. 407 tests
total (was 405); `tsc -b`/`oxlint`/`vitest run`/`npm run build` all
clean. Not manually verified in a live browser session — reaching an
active round requires a Supabase-backed game in progress, so this
relies on the RTL coverage above (which exercises the exact click
interaction and rendered content) rather than a screenshot.

## 55. Undo stopped working once the game ended

Feature request: "Make undoing possible even if the game ended." The
Undo button (`GamePage.tsx`) was gated on `me` (`disabled={!me || ...}`)
even though `handleUndo`'s own doc comment says "any player, at any
time" — `me` is really "which specific player is this action
submission on behalf of," which every other button on the page needs
(CHOOSE_CARD, RESOLVE_UNIT_ACTION, etc. all dispatch `{ playerId:
me.id }`) but Undo never used at all; it only guarded on it.

That mismatch broke Undo specifically once `gameState.status ===
'completed'`: for skip-gate hotseat games, `me` follows
`currentActorId(gameState)`, which is `null` once nobody's turn is
next (`turnOrder.test.ts` already covered this for `currentActorId`
itself) — so `me` went `undefined` the instant the game ended. For
gated hotseat games it was worse: a *fresh page load* of an
already-completed game never shows the pass-device gate at all (it
only shows when there's a `pendingActorId` to hand the device to), so
`hotseatActivePlayerId` — and therefore `me` — stayed `null`
permanently, with no way to trigger it. Live/async games were
unaffected (`me` there just matches the signed-in session to a seated
`players` row, independent of game status).

Fix: dropped the `!me` guard from both `handleUndo` and the button's
`disabled` condition — Undo doesn't submit a player-attributed action,
so it has no use for `me`. The write stays safe without the client-side
gate: RLS ("seated players can update game state",
0001_init_schema.sql) already requires the authenticated user to be a
seated player of this game before any game_state write lands, so a
signed-in stranger who isn't seated can click the now-always-enabled
button but their write simply won't land (surfaces the existing
"couldn't sync" retry-exhausted error).

Also confirmed the underlying engine invariant Undo depends on:
dropping the game-ending action from `actionHistory` and replaying
(`replayActions`) reverts `status` from `'completed'` back to
`'active'`, since `status` is just another field on the replayed
state, not tracked separately — added
`replay.test.ts`'s "undoing the action that ended the game reverts
status from completed back to active" covering a full genesis ->
CHOOSE_CARD -> RESOLVE_UNIT_ACTION (claims the achievement that hits
`gameLength`) -> decline -> purchase sequence ending the game, then
replaying everything but the closing action. 408 tests total (was
407); `tsc -b`/`oxlint`/`vitest run`/`npm run build` all clean. No
`GamePage.tsx` test exists (no page in this codebase has Supabase-
wiring test coverage — engine/component tests only), so this specific
fix is verified by code reading plus the engine-level replay
invariant it relies on, not a dedicated UI test.

## 56. A game with only one player left never finished

Bug report: "there is only one player remaining, but the game didn't
finish." `eliminatePlayer()` (elimination.ts) marked a player
eliminated but never checked how many players that left — a 2+ player
game where every other player got eliminated (rule: no card to
choose/decline) just carried on with the sole survivor taking turns
forever, `status` stuck `'active'`.

Fixed at the one real chokepoint: `eliminatePlayer()` now ends the
game the instant an elimination leaves at most one player standing —
`status: 'completed'`, `winnerPlayerIds` set to whoever's left (the
sole survivor trivially wins outright, no VP comparison needed; the
degenerate simultaneous-elimination-of-everyone case ends the game
with no winner, `winnerPlayerIds: []`, rather than not at all). Its
three callers that chain straight into the next round phase once every
pending player is resolved — `beginSelectCardsPhase`/`beginDeclinePhase`
(round.ts) and `applyMoveToDecline` (applyAction.ts) — each needed a
`status !== 'completed'` guard added to their "advance to the next
phase" check, since a just-completed game must stop there, not
chain forward as if the phase had merely finished normally.

This exposed a widespread test-fixture pattern across the suite: many
fixtures deliberately gave only one of two seated players any real
units/cards, relying on the OTHER player being harmlessly
auto-eliminated at genesis (empty hand, "no card to choose") to get a
cheap single-active-player state for testing. That auto-elimination
now also ends the game, which broke 27 tests across 5 files
(`applyAction.test.ts`, `boardSetup.test.ts`, `gameLog.test.ts`,
`turnReview.test.ts`, `RoundView.test.tsx`) whose whole point was
everything AFTER that setup step. Fixed each fixture to either give
the second player a real placeholder unit, or (for fixtures that
never wanted a second real participant at all) exclude them up front
— `turnOrder: ['p1']`, marked `eliminated: true` from the start —
rather than let the engine eliminate them into game-ending territory.

Added dedicated coverage in `elimination.test.ts`: the last-player-
standing win at select-cards-phase start, the same at decline-phase
start (both `beginSelectCardsPhase`/`beginDeclinePhase`'s own initial
elimination pass), the everyone-eliminated-simultaneously edge case
(no winner) at both those same phase starts, and the
`applyMoveToDecline` per-card elimination cascade — each confirming
`status`/`winnerPlayerIds` land correctly AND that the state does NOT
chain into the next round phase once completed. 409 tests total (was
408); `tsc -b`/`oxlint`/`vitest run`/`npm run build` all clean.

## 57. End-of-game breakdown: what each player has, not just the VP number

Feature request: "The game over screen should present a full summary
of the player score in the format of What the player have: the VP —
for example '4 forest: 12 points'." `EndGameView.tsx` (todo.md #53)
already broke score down by source (achievements/board-count/
terrain-control/gold) as four numbers, but not by the underlying thing
each number came from — no way to tell "12 terrain-control points"
apart from "controls 4 Forest hexes at 3 VP each" vs. "controls 2
Mountain hexes at 6 VP each."

Added itemized counterparts to each `calculate*VP` source function,
alongside the existing summed ones (which `finishRound()`'s win check
and the live in-round score still use unchanged): `calculateAchievementDetail`
(one entry per claimed achievement), `calculateBoardCountDetail` (one
entry per unit kind present), and `calculateTerrainControlDetail`
(scoring.ts — one entry per effective terrain type controlled, summing
hexCount/vp across every separate region of that terrain the player
holds a majority in, e.g. two disconnected Forest regions become one
"Forest" line). Combined via new `calculateVPDetail(state,
achievementContent)` in victoryPoints.ts, `EndGameView`'s new single
source of truth — its `total` is summed directly from the itemized
entries (not delegated to `calculateVPBreakdown`/`sumVP`) so the
displayed list and the displayed total can never drift apart from each
other.

Added `listTerrainTypes()` to `content/resolveContent.ts` (mirroring
the existing `listAchievements()`) so `EndGameView` can resolve a
terrain id to its display name ("forest" -> "Forest") the same way it
already resolves achievement ids to names — the engine itself still
never sees display names, only ids (see `calculateAchievementDetail`'s
doc comment).

Rewrote `EndGameView.tsx` from a fixed-column table (one column per
source, one number each) to a per-player card with a bulleted list of
"<what they have>: <N> points" lines — e.g. "City Mastery: 5 points",
"3 City: 4 points", "4 Forest: 12 points", "10 Gold: 5 points" — built
from `calculateVPDetail`. A source the player has nothing in
contributes no line at all (no "0 Gold: 0 points" clutter); a source
they DO have something in still gets a line even at 0 points, since
the point is showing what they have, not just what scored. A player
with nothing on every source shows "No points scored" instead of an
empty list.

Test coverage: `calculateTerrainControlDetail` in `scoring.test.ts`
(itemizes what `calculateTerrainControlVP` sums, combines multiple
regions of the same terrain, omits a no-majority player, still merges
Glacier into Mountain); `calculateAchievementDetail`/
`calculateBoardCountDetail`/`calculateVPDetail` in
`victoryPoints.test.ts` (itemizes what the corresponding `*VP`
function sums, `calculateVPDetail`'s total matches
`calculateVPBreakdown`'s total on the same fixture); rewrote
`EndGameView.test.tsx`'s assertions for the new card/list layout
instead of a table. 422 tests total (was 409); `tsc -b`/`oxlint`/
`vitest run`/`npm run build` all clean.

## 58. Two units on one hex: the second one's icon fully hid the first

Bug report, two parts: "merchant can't move on water" and "when
merchant stops in city, the city icon is blocked. The two icons
should be handled as a special case."

Investigated the water-movement report first, since it looked like a
likely engine bug (a movement-terrains or cliff-crossing mistake).
Traced it at every layer — a direct `legalMoveDestinations()` call
with real `resolveUnitContent()` data, a full City-converts-Nomad-to-
Merchant `applyAction()` flow followed by a legal-destinations check,
and a full `RoundView` RTL click-through (select Merchant, click Move,
confirm the adjacent water hex is highlighted and clicking it calls
`onResolveUnit` with that coordinate) — and Merchant correctly moves
onto water at all three. Could not reproduce it anywhere in the
codebase as it stands; asked the user for a concrete repro (what
terrain the Merchant started on, whether the target water hex had
another unit on it) rather than guess at a fix with no failing case to
verify against.

The second part reproduced immediately by inspection: `HexBoard.tsx`
drew every entry in `units` at its hex's exact pixel center with no
awareness of any other unit sharing that hex — two units on the same
hex (currently only possible one way: a mobile unit like Merchant
landing on an immobile one like City, via `canEndMoveOnUnitTypes`,
./movement.ts) were drawn one directly on top of the other, the later
one in array order completely covering the earlier one's plate and
glyph.

Added `computeUnitStackPositions()`: hexes with exactly one unit
render exactly as before (unaffected); a hex with more than one (in
practice always exactly two, per the current movement rules) offsets
each unit to its own corner of the hex at a reduced scale, so both
plates and glyphs stay fully visible instead of one hiding the other —
literally the "handle the two icons as a special case" the report
asked for. Degrades gracefully (spreads evenly instead of just two
corners) if more than two ever shared a hex, though nothing in the
current rules can produce that.

Added `HexBoard.test.tsx` coverage: two same-hex units render at
different centers (not sitting exactly on top of each other) and both
glyphs are present in the DOM; a lone unit still renders dead-center
at full size, confirming the single-unit case is untouched. 425 tests
total (was 422); `tsc -b`/`oxlint`/`vitest run`/`npm run build` all
clean.

## 59. Merchant should not be able to move onto Water

Follow-up correction to todo.md #58: the reported "merchant can't move
on water" bug was the opposite of what it sounded like — the user
clarified "Merchant shouldn't be able to walk on water" at all, i.e.
`content/units.json`'s Merchant `movement.terrains` (which included
`"water"`) was itself wrong, not the engine's handling of it (which,
per #58's investigation, correctly honored whatever the content said —
there was nothing to fix there).

Removed `"water"` from Merchant's `movement.terrains` (now `["plain",
"forest", "mountain"]`). Also corrected `unitActions.ts`'s
`SOLE_CREATABLE_KIND_BY_TERRAIN` doc comment, which had explicitly
(and now wrongly) cited "a Merchant can travel onto Water once it
exists, but can't be *built* there" as a supporting example — the
comment's actual load-bearing point (Nomad/City-create needing a hard
stop against landing on Glacier) didn't depend on that aside, so it
was dropped rather than replaced.

Added a test against the real content (not a synthetic movement
profile that could drift from it) in `unitActions.realContent.test.ts`:
confirms Merchant's real `terrains` excludes Water while still
including Plain/Forest/Mountain, and that `legalMoveDestinations`
against real content rejects an adjacent Water tile as a legal Move
target. 426 tests total (was 425); `tsc -b`/`oxlint`/`vitest run`/
`npm run build` all clean.

## 60. Easier-to-paste game state export

The existing "Copy JSON" debug button (todo.md #33) writes the full
pretty-printed state to the clipboard, which for a real game in
progress is tens of KB — awkward to paste into a bug report or chat.
Added a second button, "Copy state export", next to it.

New `src/lib/gameStateExport.ts`: wraps the state in a small envelope
(`{ schema: 'rise-and-fall/game-state-export', version: 1, exportedAt,
gameState }`) so a decoder can recognize and validate a blob before
trusting it and so the encoding can change later without breaking old
exports; serializes it to JSON, gzips it (`CompressionStream`), and
base64-encodes the result behind a short `RAF-STATE-1:` prefix — a
single line, well under half the size of the pretty-printed JSON.
`decodeGameStateExport()` reverses all of it, checking the prefix and
schema before returning the envelope. Both directions stream through
`ReadableStream`/`CompressionStream`/`DecompressionStream` directly
(not `Blob`/`Response`, whose jsdom implementations turned out not to
support `.stream()` — went through a couple of failed approaches
against the test environment before landing here).

`GamePage.tsx`'s new `handleCopyStateExport` calls this and writes the
result to the clipboard, mirroring the existing "Copy JSON" handler's
"Copied!" flash but with its own error surface (clipboard/compression
failures are shown inline rather than silently swallowed).

New `gameStateExport.test.ts` (4 tests) round-trips a real genesis
state through encode/decode, checks the encoded form is under half the
pretty-printed size, and checks both rejection paths (missing prefix,
wrong schema). 430 tests total (was 426); `tsc -b`/`oxlint`/`vitest
run`/`npm run build` all clean.

## 61. The Ports Tale (variant) — first Tale implemented, plus the general "companion piece" engine capability it needed

Requested: implement The Ports, one of the 23 Tales cataloged in
`VARIANTS_PLAN.md` (see that doc's section 5 for the full variant
design). Nothing from the Tales variant existed yet — no content file, no
engine hooks — so this also had to build the first slice of genuinely
reusable Tales infrastructure the plan calls for, not just Ports itself.

**The rule, precisely** (rulebook pp. 20-21, re-extracted with layout
preserved to get the true action ordering — the plain-text extraction
used for `VARIANTS_PLAN.md`'s catalog had jumbled the two-column layout
here): each player keeps one Port in reserve. A Nomad (Plains adjacent to
empty Sea, cost 2 Stone + 1 Wood) or a Ship (adjacent to a Plains space,
same cost) can build one. **A Port has no Civilization card of its own**
— instead, each time its owner plays their Ship card, they may *also*
activate the Port, once each, for one of two actions: Construct a Ship
(1 Wood, only if the Port's own Sea space doesn't already hold a Ship —
that new Ship can act the same turn) or Trade with Ships and Ports (4 GP
per Ship/Port, any owner, anywhere in the Port's Sea Region, including
itself). A Port cannot be activated the turn it's built. Its Sea space
still counts as Sea for any Ship to move through; it can hold exactly one
Ship, but only its own owner's — an opposing Ship can never stop there.

**New reusable engine capability: "companion piece" units.** This is the
first unit kind with no Civilization card at all, activated by a
*different* kind's card — flagged in `VARIANTS_PLAN.md` as needed again
for the Capital and Cathedral Tales, so built generically rather than
special-cased to Ports:
- `UnitContent.companionKindsByCardKind: Record<string, string[]>`
  (`unitContent.ts`) — e.g. `{ ship: ['port'] }`. Populated by merging a
  game's active Tale content on top of the base game's content (see
  below), not hand-authored.
- `GameState.unitsCreatedThisTurn: string[]` (`types.ts`) — every rulebook
  companion piece states "cannot be activated on the turn it is
  constructed"; this is what lets the engine enforce that generically.
  Reset alongside `resolvedUnitIdsThisTurn` (`beginActionsPhase` for the
  first player's turn, `finishActionsTurn` for each next one).
- `applyResolveUnitAction` (`applyAction.ts`) no longer assumes every
  acting unit's kind equals the played card's kind: for each assignment it
  now looks up the actual unit, decides whether it's the card's own kind
  (no restriction) or one of its companions (rejected if the unit id is in
  `unitsCreatedThisTurn`), and pulls that unit's *own* kind's actions —
  not the card's — to resolve against. This is also exactly what makes "a
  Ship built by a Port can act the same turn" fall out for free: that Ship
  isn't a companion at all, its kind already matches the played card, so
  it's simply never subject to the same-turn restriction. The
  turn-auto-end check (`actingUnitIds`/`everyUnitActed`) excludes
  freshly-built companions from what it's waiting on, so a Port built
  mid-turn doesn't stall the rest of that turn from finishing.

**New content layer, mirroring `units.json`'s own conventions:**
`content/tales.json` + `tales.schema.json` — self-contained per Tale (no
`$ref` into `units.schema.json`; nothing in this repo actually runs a
schema validator, so a fragile cross-file reference wasn't worth the
risk) — an `extraUnits` array (new companion kinds, each with its own
`companionOfKind`/movement/supply/actions), `extraActionsByKind` (new
actions appended onto an *existing* kind, e.g. Nomad and Ship both gain
Construct a Port), and `movementOverridesByKind` (e.g. Ship gains
`canEndMoveOnAlliedUnitTypes: ['port']`). `resolveTaleContent(activeTaleIds,
playerCount)` (`resolveContent.ts`) resolves this into a new
`TaleContent` bundle (`taleContent.ts`), and a new pure
`applyTaleModifiers(baseUnitContent, taleContent) -> UnitContent`
(`tales.ts`) merges it on top of `resolveUnitContent()`'s result — same
"engine never imports JSON, takes content as an explicit param" pattern
as every other content bundle. A game with no Tales active never touches
any of this (`EMPTY_TALE_CONTENT`, an `applyTaleModifiers` no-op).

**Two new `UnitActionEffect` variants** (`unitContent.ts`/
`unitActions.ts`), needed because Port's own two actions don't fit any
existing shape:
- `SiteCreateEffect` — creates a unit on the *acting* unit's own hex,
  legal even though that hex is already occupied (by the acting unit
  itself), blocked only if a listed kind is *also* already there (Port's
  Construct a Ship: blocked by an existing `ship`). Existing
  `create`/`transform` both assume the target hex must be empty, which
  can never be true here since the Port itself always occupies it.
- `RegionUnitCountIncomeEffect` — gold per unit of given kinds anywhere in
  the acting unit's whole connected terrain region (Port's Trade with
  Ships and Ports), the region-scan half of Ship's existing `trade`
  reused, the per-adjacent-City counting half dropped in favor of a flat
  region-wide unit count.

**One new condition on the existing `TransformEffect`:**
`requiredAdjacentTerrain?: string[]` — Ship's Construct a Port needs "be
adjacent to a Plains space," which isn't about the target hex (the Ship's
own hex, always Sea, doesn't change) at all, so the existing
`targetHex.terrainType` check can't express it.

**Movement: allied-only landing.** `UnitMovement.
canEndMoveOnAlliedUnitTypes?: string[]` (`types.ts`), alongside the
existing any-owner `canEndMoveOnUnitTypes` — `movement.ts`'s `canLandOn`
now takes the mover's `ownerId` and permits landing if every occupant is
covered by *either* list (any-owner, or same-owner-only). This is also
what enforces "at most one Ship per Port" for free, with no separate
counting logic: a Port hex already holding a Ship has two occupants, and
the Ship occupant's kind isn't itself in either allowed list, so a second
Ship still can't land there.

**Bug found and fixed along the way, in already-shipped base-game code:**
`unitActions.ts`'s `SOLE_CREATABLE_KIND_BY_TERRAIN` (`water: 'ship',
glacier: 'mountaineer'`) was a hard, single-kind-per-terrain guarantee —
written before anything but a Ship could ever legitimately exist on
Water. Port's whole point is a structure built *on* a Sea space, so
Port's Construct a Port actions were silently rejected by this guarantee
until it was generalized to `CREATABLE_KINDS_BY_TERRAIN: Partial<Record
<Terrain, string[]>>` (`water: ['ship', 'port']`) — every other terrain
and kind's behavior is unchanged, this only widens Water's one entry.

**Scope note, matching `VARIANTS_PLAN.md`'s "engine first" framing:** no
lobby/setup UI exists yet to actually turn The Ports on for a real game
(`GameState` has no persisted "which Tales are active" field — the
content-resolution layer already supports it via
`resolveTaleContent(activeTaleIds, playerCount)`'s parameter, but nothing
calls it from `createGame.ts`/`LobbyPage.tsx` yet). This was a deliberate
call: build the rule correctly and test it thoroughly first, wire up
"can a real game actually select this Tale" as a separate follow-up once
more Tales exist to make a real setup screen worth building.

19 new tests in a new `tales.test.ts` (content-merge correctness against
the real `tales.json`/`units.json`; both new effect types in isolation;
`requiredAdjacentTerrain`; allied-only landing including the
one-Ship-per-Port cap; and the companion-dispatch mechanics end-to-end
through `applyAction` — a pre-existing Port acting, a freshly-built Port
correctly rejected, a Ship built by a Port correctly allowed to act, and
a freshly-built companion not blocking its player's turn from ending).
457 tests total (was 438); `tsc -b`/`oxlint`/`vitest run`/`npm run build`
all clean.

## 62. Tales setup UI — choosing which Tales are active for a game

Follow-up to #61, closing the scope note it left open: "no lobby/setup UI
exists yet to actually turn The Ports on for a real game." Mirrors
`map_template_id`'s existing shape (`0002_map_template.sql`) exactly,
since it's the same kind of per-game, creation-time, immutable setting:

- `supabase/migrations/0005_tales_variant.sql`: `games.active_tale_ids`
  (`text[]`, default `'{}'`). `dbTypes.ts`'s `GameRow` gained the matching
  field.
- `gameApi.ts`'s `createGame()` gained an `activeTaleIds?: string[]`
  param, written straight through to the new column.
- New `TaleSelector.tsx`: a checkbox list (from `content/resolveContent.
  ts`'s new `listTales()`) plus a "Randomize" button. Deliberately not
  "draw one per player" (the rulebook default) — player count isn't known
  yet at game-creation time (`HomePage.tsx`, before anyone's joined the
  lobby), and that exact count doesn't mean much while the catalog only
  has one Tale anyway. Randomize instead independently coin-flips each
  Tale's inclusion; checking/unchecking directly (host-picking specific
  Tales) is the primary flow either way, matching the flexibility
  `VARIANTS_PLAN.md`'s decision 7 asked for.
- `HomePage.tsx` wires the selector in next to the existing map-template
  picker and passes the choice to `createGame()`. `LobbyPage.tsx` shows
  which Tales are active in the room header, same spot the map template
  name already shows.
- **The one piece that actually makes Ports *do* anything:**
  `GamePage.tsx`'s `unitContent` memo now merges `resolveTaleContent(game
  .active_tale_ids, players.length)` onto `resolveUnitContent(players.
  length)` via `applyTaleModifiers()` (`src/engine/tales.ts`, from #61) —
  the same effective content flows into every `RESOLVE_UNIT_ACTION`
  dispatch, replay, and undo, since they all already read this one memo.
  A game with `active_tale_ids: []` (every game before this migration,
  and any new one that leaves Tales unchecked) resolves identically to
  before — `applyTaleModifiers` is a no-op on `EMPTY_TALE_CONTENT`.

**Scope note, carried forward:** `RoundView.tsx`'s action-phase panel
still only highlights/offers units whose kind matches the currently
played card — it has no notion of a companion-piece kind (Port) also
becoming available when its companion card (Ship) is played. So a real
game can now select The Ports and its rules are correctly enforced
end-to-end at the data/engine layer, but there's currently no way to
*click* a Port in the UI to actually use it — that needs `RoundView.tsx`
(and probably `HexBoard.tsx`'s radial action menu) taught about
`UnitContent.companionKindsByCardKind`, likely by extending the same
`u.kind === card.kind` filters at `RoundView.tsx`'s lines ~345 and ~488
to also include companion kinds not built this turn. Not done here —
flagged as the next concrete step.

No engine changes in this item — content/`dbTypes.ts`/`gameApi.ts`/new
component/two page tweaks only. 457 tests unaffected (no page-level test
coverage exists in this codebase — see #55's note on the same gap);
`tsc -b`/`oxlint`/`vitest run`/`npm run build` all clean.

## 63. Round-play UI for companion pieces (Port) — closes #62's scope note, plus a stacked-hex rendering bug it surfaced

Two related requests: make a Tale companion piece (Port) actually
clickable/usable in the live round UI (the gap #62 flagged), and fix what
happens visually/interactively when two of the player's own units share a
hex (a Ship docked at its own Port) — raised as "perhaps the radial menu
can be grouped by unit type."

**The companion-piece gap.** `RoundView.tsx`'s action-phase state only
ever considered units whose kind matched the currently played card
(`u.kind === card.kind`) — a Port (kind `'port'`, no card of its own,
companion of Ship) was invisible to it even once #61 made the engine
correctly support it. New `eligibleActingUnits(state, unitContent,
playerId, card)`: card-kind units plus any companion kind
(`unitContent.companionKindsByCardKind`) not built this very turn
(`GameState.unitsCreatedThisTurn` — mirrors the engine's own
`applyResolveUnitAction` rule from #61). Used everywhere `RoundView.tsx`
used to filter by `u.kind === card.kind` alone: the highlighted-units set,
`ActionsPanel`'s "X of Y units still need one" count (which gained a new
`unitContent` prop to compute it), and the menu/targeting state below.

**The stacking problem, which turned out to be two separate bugs.**
Before this, at most one of the player's units could ever occupy a hex —
now a Ship and its own Port legitimately can. That broke two unrelated
assumptions:

1. *Click handling*: `handleBoardClick` found "the" unit at a clicked hex
   via `.find()` — with two units there, the second was simply
   unreachable, no matter how you clicked. Fixed by keying the menu to
   the **hex**, not a single unit: `ActionUiMode`'s `menu` variant now
   carries `coord` instead of `unitId`, and `handleBoardClick` gathers
   *every* available unit at that coord.
2. *The menu itself*: with more than one acting unit at a hex, their
   actions need to appear together, distinguishably. `HexBoard.tsx`'s
   `ActionMenuOption` gained `unitId`/`unitKind` fields and `ActionMenu.
   onSelect` became `(unitId, optionId) => void`; the render groups
   options by contiguous `unitId` runs and, only once there's more than
   one group, shows a small kind label ("SHIP" / "PORT") on each option
   and routes clicks back with the right unit. A single-unit menu (the
   overwhelming common case, unaffected by any of this) renders exactly
   as it did before.

**A real layout bug found via a visual check, not just the unit tests.**
The first version of the grouped angle math gave each group an arc of the
full circle *proportional to its own option count* (e.g. two 2-option
groups each got ~162° of arc, separated by an 18° gap). That's backwards
from what you want: a group's own options end up spread across nearly
the whole circle relative to each other, while the *boundary* between two
different groups — last option of one, first of the next — sits only one
small gap apart, i.e. visually the closest pair of boxes belongs to
*different* units. Confirmed by rendering the actual component to static
SVG (`@testing-library/react`'s `render()`, no Supabase needed) and
screenshotting it with the sandbox's pre-installed Chromium (same
approach as #20's cliff-hexside verification) — the disabled "Port: Trade
with Ships and Ports" box visually collided with "Ship: Move" even though
they belong to different units, while each unit's own two options sat
far apart. Rewrote `computeActionMenuAngles`: options within a group now
use exactly the spacing a single ungrouped ring of that many total
options would use (`360 / totalOptions` per step, unchanged from before
grouping existed), and only the transition *between* groups gets extra
separation (`GROUP_GAP_DEGREES`, additive on top of one step) — re-
screenshotted to confirm all four options render as two clearly separate,
internally tight clusters labeled SHIP/PORT.

**The markers themselves, not just the menu.** Two units at the same hex
previously rendered at the exact same pixel position — one fully hidden
behind the other, with no visual indication a second unit was even
there. New `computeUnitStackOffsets()` (`HexBoard.tsx`, keyed by array
index the same way `computeHistoryLabelPositions` already is) nudges
each unit sharing a hex to its own small offset around the hex center
and shrinks them slightly (`STACKED_UNIT_SCALE`) so a cluster still fits
within the hex; a lone unit on its hex is completely unaffected (offset
`{0,0}`, full size) — verified both units render at different positions
when stacked and that a solo unit's position is byte-identical to before
this existed.

**One more correctness fix, unrelated to the interaction bugs but found
while touching this area:** Port had no entry in `unitIcons.ts`'s
`STATIC_UNIT_KINDS`, so it rendered with the mobile-unit circle marker
shape instead of the immobile-structure rectangle City/Temple use — added
it (Port never moves once built, same as those two).

Also removed `id` as `ActionMenuOption`'s sole identity — with two units'
actions in one menu, colliding action ids across kinds (plausible; e.g.
several kinds share an id like `'move'`) would have silently misattributed
clicks to the wrong unit before the `unitId`/`unitKind` fields existed.

7 new tests: 3 in `RoundView.test.tsx` (grouped menu shows both units'
options labeled by kind; clicking each one's option resolves against
*that* unit, not the other) and 4 in `HexBoard.test.tsx` (stacked markers
offset from each other; a solo marker is unaffected by another unit
elsewhere on the board; a single-group menu shows no kind labels;
options get labeled once more than one unit is involved, with clicks
routed to the right unit id). 464 tests total (was 457); `tsc -b`/
`oxlint`/`vitest run`/`npm run build` all clean. Not click-tested against
a live Supabase-backed game (same sandbox limitation as all prior UI work
in this file) — the static-render screenshot check above is the closest
available substitute, and is what actually caught the angle-math bug a
unit test alone would have missed (the passing HexBoard.test.tsx case
only exercised one option per group, never triggering the multi-option-
per-group spread).

## 64. The Capital Tale (variant, Tale #4) — cluster-consuming transforms, double-activating companions, and Tale-contributed Trophies

Requested: implement The Capital, cataloged as "L" (large) complexity in
`VARIANTS_PLAN.md` section 5.4 — it needed two engine capabilities no
existing Tale (Ports/Banks/Cathedral, #61) had exercised yet: a transform
that consumes more than just the acting unit, and a companion that
activates more than once per turn.

**The rule, precisely:** a City controlling 4 Cities arranged in a
diamond (2 adjacent "spine" Cities plus the 2 Cities adjacent to both of
them) may merge all 4 into the single Capital in the World, placed on the
acting City's own hex. The Capital has no Civilization card of its own —
each time its owner plays their City card, the Capital activates *twice*,
performing 2 City actions (identical or different, per ruling — the
rulebook doesn't require them to differ). Building it earns a real 20 VP
Trophy, exactly like reaching full supply of any base unit kind (the
Capital's own supply cap is 1, so "constructed" and "reached full supply"
are the same event) — including triggering a real Decline phase for every
player, per the rulebook's "Extra Trophies" rule. Per ruling, it also
counts as a normal City for Ship's Trade action (the only concrete
existing City-counting mechanic in the base game today; Merchant/Temple
have no analogous "Trade"/"Taxes" action to extend).

**New engine capability 1: a rhombus-cluster-consuming transform.**
`TransformEffect.requiredAdjacentRhombusOfKind` (`unitContent.ts`) — when
set, the acting unit's own hex must be one corner of a 4-hex rhombus
entirely occupied by the acting player's own units of that kind; all 4 are
removed (not just the acting one), and the new unit lands on the acting
unit's own hex. New `findAdjacentRhombusCluster` (`unitActions.ts`) finds
it: a hex-grid rhombus is two adjacent hexes (the "spine") plus the
(exactly 2, fewer at a board edge) hexes adjacent to both — found via a
new `commonNeighbors` helper. Since the acting hex can be either a spine
or a wing corner, the search tries both roles: each neighbor as the other
spine hex (covers acting-as-spine), then each mutually-adjacent pair of
the acting hex's own neighbors as the spine (covers acting-as-wing, with
the 4th hex being that edge's other common neighbor). Wired into
`applyTransform` and `legalTransformTargets` (`actionTargeting.ts`)
alongside the existing `requiredAdjacentOwnUnitKind`/`requiredOwnKindCount`
condition fields.

**New engine capability 2: a companion that reuses its parent's action
list and activates more than once.** Two new `TaleExtraUnitContent`
fields (`taleContent.ts`): `reusesCompanionActions` (the Capital has no
actions of its own at all — `applyTaleModifiers`, `tales.ts`, resolves its
final action list from `companionOfKind`'s own list, AFTER that kind's own
Tale-added extras, so it picks up e.g. `construct-capital` too) and
`activationsPerTurn` (new `UnitContent.activationsPerTurnByKind`, default
1 for every kind — the Capital sets 2). `applyResolveUnitAction`
(`applyAction.ts`) no longer treats "already acted" as a boolean
(`resolvedUnitIdsThisTurn.includes(unitId)`) — it counts a unit's
occurrences there against its kind's cap, both across prior calls this
turn and within the same batched call. `RoundView.tsx` needed the same
fix in its own two "still needs to act" filters (new
`hasRemainingActivation` helper) — otherwise the live UI would hide the
Capital as fully spent after its first activation.

**New engine capability 3: Tale-contributed real Trophies.** Unlike
Cathedral's `controllableStructures` (a dynamic, game-end-only "who holds
it" bonus), Constructing the Capital is a one-time permanent claim that
must trigger Decline immediately, mid-game — exactly what a base
achievement (`content/achievements.json`) already does via
`updateAchievementClaims`'s "first player to reach full supply of a unit
kind" rule. New `TaleContent.extraAchievements` /
`TaleExtraAchievement` (`taleContent.ts`) plus `applyTaleAchievementModifiers`
(`tales.ts`), merged the same way `applyTaleModifiers` merges unit
content, just onto `AchievementContent` instead — `GamePage.tsx` now
builds `achievementContent` from `applyTaleAchievementModifiers(
resolveAchievementContent(...), taleContent)`. Reusing the existing
claim/decline/game-length/purchase-cost pipeline outright meant Capital's
Trophy needed zero bespoke claim logic — the "generalized Trophy claim
predicate" `VARIANTS_PLAN.md` flagged as still-needed infra (section 6,
item 5) turns out to already exist for any Tale piece with a supply cap,
which the Capital (only one ever) trivially has.

**Content:** `content/tales.json`'s `the-capital` entry (#4, category
`buildable`): the `capital` companion unit (supply cap 1,
`reusesCompanionActions: true`, `activationsPerTurn: 2`), City's new
`construct-capital` action (`requiredAdjacentRhombusOfKind: 'city'`,
`forbiddenIfBoardHasKind: 'capital'`, no separate resource cost beyond the
4 Cities), and the `extraAchievements` entry (20 VP). Schema
(`tales.schema.json`) gained matching optional fields.

**Smaller pieces:** `computeTradeGold` (Ship's Trade) now counts `'capital'`
alongside `'city'` — hardcoded the same way `CREATABLE_KINDS_BY_TERRAIN`
already hardcodes `'port'`, since the base engine doesn't otherwise know
Tale-specific kind ids. A new hand-drawn icon (`unitIcons.ts`): City's own
crenellation, widened and topped with a raised keep + banner — "grander
than a City" through added height, the same idea Cathedral used against
Temple — plus `capital` added to `STATIC_UNIT_KINDS`. `RoundView.tsx`'s
achievements panel renders the Capital's Trophy alongside the base ones
(sourced from `taleContent.extraAchievements` rather than the static
`achievements.json` list, labeled from its unit kind id since Tale
achievements carry no separate display name in `AchievementContent`,
matching that type's existing "names are a display-layer lookup, not
engine content" convention).

14 new tests in `capital.test.ts` (rhombus geometry from both a spine and
a wing starting hex, rejected with only 3 Cities or a non-rhombus line of
4, ignores a mix of two players' Cities; content-merge correctness against
the real `tales.json`/`units.json`; the cluster-consuming transform in
isolation; and, end-to-end through `applyAction`, double activation off
the City card with a rejected 3rd, the Trophy claim triggering a real
Decline phase, and Ship's Trade counting the Capital). Every pre-existing
`UnitContent` test fixture across the suite needed the new
`activationsPerTurnByKind: {}` field (same mechanical update #61 caused
when `companionKindsByCardKind` was introduced). 655 tests total (was
641); `tsc -b`/`oxlint`/`vitest run`/`npm run build` all clean.

**Not done, out of scope for this change:** live-UI click-testing (no
Supabase-backed game available in this sandbox, same limitation as #63);
the base game's `syncCardZonesWithBoard` only tracks a card's own literal
kind on the board, not its companions — a player whose Capital is built
from their *only* 4 Cities would see their City card cycle to supply
until they build a new City elsewhere, same pre-existing characteristic
every companion piece (Port/Bank/Cathedral) already has relative to its
own parent kind, not something newly introduced here.

## 65. Export json improvements

Requested (issue #141): make the game state export easier and more
efficient for debugging real games — a direct "copy" action in the
menu, a real JSON format instead of a custom-prefixed blob, and docs
on how to open/use the exported file.

`src/lib/gameStateExport.ts`'s wire format changed from a
`RAF-STATE-1:<base64>` string (not valid JSON on its own — an envelope
`{schema, version, exportedAt, gameState}` gzipped+base64'd behind a
prefix) to a real JSON object: `{ schema, version, exportedAt,
gameStateZipped }`, where only `gameStateZipped` (the size-dominating
part) is gzip+base64-encoded; `schema`/`version`/`exportedAt` stay
plain, readable fields. `encodeGameStateExport`/`decodeGameStateExport`
keep their existing signatures, so `GamePage.tsx`'s callers didn't
change. Added `src/lib/gameStateExport.schema.json` (JSON Schema,
matching the `src/content/*.schema.json` convention) documenting the
file's shape.

`GamePage.tsx`'s hamburger menu gained a "Copy game export" item that
calls `handleCopyStateExport` directly — previously the only way to
copy an export was to open the "Show game state JSON" panel first and
click a button there. That panel's button is still there (relabeled
"Copy game export" to match) for anyone who already has the panel
open. Since the menu closes immediately after the new item is
clicked, added a transient "Game export copied to clipboard!" banner
(mirrors the existing error banner styling) so there's still feedback
when the panel isn't open.

Updated `gameStateExport.test.ts` for the new format (JSON-parse
assertions instead of prefix checks) and doc comments in
`engine/types.ts`/`gameGenesis.test.ts`/`content/README.md` that
referenced the old `RAF-STATE-1` marker by name. Documented the format
and how to decode it (in-app, via `jq`+`gzip`, or generically) in a new
"Debugging: game state export" section in the top-level `README.md`.
665 tests total; `tsc -b`/`oxlint`/`vitest run`/`npm run build` all
clean.
