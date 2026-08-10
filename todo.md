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
