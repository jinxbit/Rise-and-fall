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
