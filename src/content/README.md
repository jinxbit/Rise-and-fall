# Game content data

Hand-authored game content, kept separate from `src/engine/` (rules logic)
and `src/lib/` (Supabase/network). Not wired into the engine or UI yet —
these are editable JSON files for you to fill in; the next milestone reads
them and encodes the actual `applyAction()` logic against them.

## `units.json` (validated by `units.schema.json`)

One entry per unit type. `id` matches the engine's `Unit.kind` field
(`src/engine/types.ts`). For each unit:

- `supply.byPlayerCount` — total pieces of this unit type available, i.e. the
  hard cap a player can have in play at once, keyed by player count (same
  value for every player count per the ruling): 8 Cities, 3 Temples, 8
  Nomads, 6 Merchants, 3 Mountaineers, 5 Ships. Doubles as the decline-phase
  trigger limit — see `getUnitLimit`/`isDeclineTriggered` in
  `src/engine/decline.ts`, and `createNewGame`'s `unitLimits` param
  (`src/engine/createGame.ts`), which the caller should resolve from this
  field.
- `movement.isMobile` — `false` for static units like settlements.
- `movement.terrains` — which of the 5 terrain types (see below) this unit
  can move onto.
- `movement.canCrossCliffs` — whether this unit ignores cliff edges, which
  otherwise block movement/adjacency for every other unit.
- `movement.moveDistance` — max hexes a unit can move in one `move` action
  (see below), or the string `"unlimited"` for a unit with no distance cap
  (only Ship today). `"unlimited"` doesn't mean "move anywhere" — a unit's
  move is still restricted to `movement.terrains`, so Ship's unbounded
  search naturally stops at the edge of its connected water region and
  can't reach a disconnected body of water, satisfying "movement allowance
  is infinity, but it can't move out of its water region."
- `movement.blockedByUnits` — whether another unit's presence stops this
  unit from moving *through* a hex at all: `"none"` (never blocked — e.g.
  Ship, which "can cross other player units"), `"enemy"` (blocked only by
  units it doesn't own), or `"all"` (blocked by any unit, friend or foe).
  This governs passing through only, not landing — see the next field.
- `movement.canEndMoveOnUnitTypes` — unit kind ids this unit may *end* its
  move on top of, as an exception to the default rule that a move must end
  on an empty hex. Independent of `blockedByUnits`: a hex can be legal to
  move through (per `blockedByUnits`) without being legal to land on (per
  this field) — e.g. Ship can pass over another player's ship but can't
  stack on top of it, since it has no `canEndMoveOnUnitTypes` entry.
  Implemented as `legalMoveDestinations()` in `src/engine/movement.ts`
  (a breadth-first search from the unit's hex).
- **Movement is a normal action, no exceptions.** Per ruling: every mobile
  unit kind's card includes a `move` action (`actionType: 'move'`) in its
  `actions` list, resolved through `RESOLVE_UNIT_ACTION` exactly like
  create/transform/income/etc. — the only units that can move in a turn are
  of the kind matching the card played. Each acting unit moves to its own
  target hex (`targets`, keyed by unit id → destination), independently,
  same as create/transform/convert's per-unit targets — a unit with no
  target, or an illegal one, simply does nothing that turn. See
  `applyMove()` in `src/engine/unitActions.ts` and `UnitActions.md`'s
  resolved questions #5.
- `victoryPoints.byBoardCount` — the board-control VP scoring curve: index 0
  is the score for having exactly 1 of this unit on the board, index 1 for
  2, etc. (e.g. `[1, 2, 3, 4]` scores 1/2/3/4 units as 1/2/3/4 points). 0
  units always scores 0; a count past the array's length scores the last
  entry. Empty until the real curve is decided.
- `actions` — the list of actions this unit's card can trigger. A card is
  associated with exactly one unit type; playing it lets the player pick,
  independently for each unit of that type they control, one action from
  this list to perform — different units of the same type may perform
  different actions the same round. Each action has an `effect` field — its shape is now typed
  precisely per `actionType` (`create`/`transform`/`convert`/`income`/
  `produce`/`trade-resource`/`trade`/`move`) in `src/engine/unitContent.ts`'s
  `UnitActionEffect`, and implemented in `src/engine/unitActions.ts`. See
  `UnitActions.md` at the repo root for the full per-action checklist and
  its "Resolved questions" section for the rules questions the
  implementation originally rested a documented assumption on.

Pre-filled with the six unit kinds (city, temple, nomad, merchant, ship,
mountaineer). `description` and `victoryPoints.byBoardCount` are still
blank/placeholder where the rules aren't decided yet.

## `terrain.json` (validated by `terrain.schema.json`)

The 5 terrain types (water, plain, forest, mountain, glacier) plus:

- `placesOn` — which terrain type(s) this one may be placed on top of during
  board setup (e.g. `plain.placesOn = ["water"]`). `null` only for water,
  the base terrain.
- `level` — elevation: Water 0, Plain 1, Forest 2, Mountain 3, Glacier 4. A
  hexside is a cliff if the two hexes' levels differ by more than 1 (e.g.
  Water-Plain = 1, not a cliff; Water-Mountain = 3, a cliff). See
  `isCliffEdge`/`isCliffBetweenTerrains` in `src/engine/cliffs.ts`. Cliffs
  block movement/adjacency for every unit except those with
  `movement.canCrossCliffs` (`units.json`).
- `victoryPoints` — VP per hex for territory control: at game end, each
  contiguous region of same-terrain hexes is checked for unit majority: the
  player with more units on hexes in that region than any other player
  scores this value times the region's hex count (e.g. a 5-hex water region
  at `victoryPoints: 1` scores 5). A region with no clear majority scores
  nothing, for anyone. Placeholder `0` until the real value is decided.
  Unused for Glacier — see `scoresAs`.
- `scoresAs` — which terrain id this terrain's hexes count as for territory
  scoring only. Every terrain is `scoresAs` itself except Glacier, which is
  `"mountain"`: Glacier hexes don't form their own regions or score on
  their own — they're simply part of whatever Mountain region they're
  attached to (and don't break one apart). Implemented as
  `calculateTerrainControlVP`'s `terrainScoresAs` param in
  `src/engine/scoring.ts`.
- `shapeGroups` — distinct tile pools for that terrain type. Every terrain
  type has a single `standard` group except water, which has `initial`
  (placed at game setup) and `expansion` (placed later by players) — two
  physically different tile sets.
  - `shapes` — the distinct multi-hex tile pieces available in that group.
    Each shape's `cells` array lists the relative `{q, r}` axial offset of
    every hex the piece covers (first cell is always `{0, 0}`) — this is
    what "how the hexagons are joined together" becomes in data. Filled in
    per ruling: water/`initial` is an 8-hex "hourglass" (rows of 3-2-3),
    water/`expansion` a 7-hex "flower" (rows of 2-3-2, one hex ringed by
    6), plain a 6-hex "wedge" (rows of 1-2-3), forest a 4-hex "rhombus"
    (a straight 2x2 block), mountain a 3-hex mutually-adjacent triangle,
    glacier a 2-hex domino. Rotation is allowed at placement (not
    reflection), so only one canonical orientation is stored per shape.
  - `limits.byPlayerCount` — how many tiles from that group are available
    in the base game, keyed by player count (`"2"`/`"3"`/`"4"`). Filled in
    per ruling: water/`initial` is one hourglass tile per player
    (2/3/4); every other group follows the same hierarchy order
    (water/`expansion`, plain, forest, mountain, glacier) at
    12/10/8/6/2 (2p), 15/14/11/8/3 (3p), 19/17/15/11/4 (4p) — the pool
    shrinks at each tier, since (see board generation below) each tier
    only ever covers *part* of the tier beneath it.
  - `limits.modules` — additional tiles contributed by an optional module,
    keyed by module id, additive on top of `byPlayerCount`. Empty until you
    have modules to define.

### Board generation (phase 1 — rules settled, engine done, first UI in place)

Per ruling, the very first phase of a game builds the map, then places
starting units.

**1a. Seed the board** with the `initial` water shapeGroup's hourglass
tiles — one per player. For 2 players, the two hourglasses are placed
adjacent, connected along one tile's `{q:2,r:0}`/`{q:1,r:1}`/`{q:1,r:2}`
edge (in that tile's own local coordinates) to the second tile's
mirror-image edge, offset by `(dq:2, dr:1)` — i.e. the second tile is
*not* at the same "height" as the first; it interlocks one row lower.
For 3 players, three hourglasses chain together the same way (each new
tile connected to the previous one via the same `(dq:2, dr:1)` offset).
For 4 players, it's two separate 2-player pairs (not one chain of 4).

**1b. Then, in player turn order, each player places one tile per turn**,
working through the terrain hierarchy in order — first every remaining
water tile (the `expansion` flower shapes) is placed, then every plain
tile, then forest, then mountain, then glacier — fully exhausting one
tier's supply (per `limits.byPlayerCount` above) before the next tier
begins. There's no concept of a player's own territory — any player may
place their tile anywhere on the board that's legal, not just near their
own units/tiles. If a placement leaves only one possible way left for
the rest of the tier's tiles to go, that's not a real decision anymore —
the engine places them automatically instead of making players confirm
a foregone conclusion, still respecting turn order for bookkeeping (see
`findForcedPlacement()`/`applyActionAndFastForwardTiles()`).

**Placement rule:** a tile may only be placed where every hex it covers
is *currently* the one terrain type immediately below it in the
hierarchy (`placesOn` — e.g. every hex a Plain tile covers must
currently be Water). Covering a mix of terrains, or any hex with no
tile at all yet (a "hole"), is illegal. Placing the tile converts every
hex it covers to the new terrain. This is why the pool shrinks tier by
tier: each tier can only ever claim part of the area the tier below it
covered, so the map narrows in area as it rises in elevation — visibly
matching the `level` 0-4 elevation/cliff system above.

**Sea-placement-only rules** (Water's `placesOn: null` is the one tier
that can land on untiled holes at all, so it's the only one these apply
to): a new Sea tile must touch at least 2 *distinct* Sea tiles already on
the board — two hexes bordering the same earlier tile only count once,
so a new tile can't attach along just one existing tile's edge
(`touchesEnoughExistingTerrain()`, using `Tile.placementId` to tell which
hexes came from the same physical placement) — and a placement may never
seal off an area of empty hexes with no path out to the rest of the
unplaced board (`wouldEncloseEmptyHexes()`) — both in
`src/engine/boardGeneration.ts`.

**No-space rule, simplified per ruling:** rather than the original
"relocate a minimal set of already-placed tiles to open up room" search,
a placement that wouldn't leave room for *every* remaining tile of the
tier — not just the next one — is rejected outright, same as any other
illegal placement; the player has to pick a different placement instead
(`canPlaceRemainingTiles()`).

**1c. Unit placement.** Once every tile is placed, a new starting player
is chosen. Starting with them, in turn order, each player places one of
their three starting units — one City, one Nomad, one Ship, in their own
color — choosing which of the three to place each turn (so this repeats
around the table until everyone has placed all three). City and Nomad
may be placed anywhere except Glacier; Ship only on Water. Once a player
has placed a unit, its matching card enters their hand automatically
(the existing rule 5/6 card-zone-sync logic, `syncCardZonesWithBoard` in
`src/engine/cards.ts`, already handles this generically — no new engine
logic needed for that part). Once every player has placed all three
units, the game begins for real (round 1's select-cards phase).

The deterministic pieces (rotation, placement legality/covering, and
seeding the starting water tiles) are implemented in
`src/engine/boardGeneration.ts`. The interactive part — a player actually
choosing where to place each tile/unit, turn by turn — is implemented
too, in `src/engine/boardSetup.ts`: a new `GameStatus` (`'boardSetup'`,
between `lobby` and `active`) and `GameState.boardSetup` track progress,
and new `PLACE_TILE`/`PLACE_UNIT` actions (resolved by
`placeTile()`/`placeUnit()`) handle validation and turn-cycling, with
`beginBoardSetup()` as the `lobby` -> `boardSetup` entry point, and
`createGame.ts`'s `startGame()` is wired to it directly (the old
hardcoded, non-real (`'settlement'`/`'mobile-unit'`/`'ship'`) unit trio
placeholder is gone from production code).

A first UI now drives this too: `src/content/resolveContent.ts` resolves
the JSON content (this file included) into the engine's content-agnostic
input types; `LobbyPage.tsx`'s "start game" calls
`createNewGame()`/`startGame()` for real and persists the result into a
new `game_state` Supabase table row (`src/lib/gameApi.ts`'s
`insertGameState`/`getGameState`/`writeGameState`/`subscribeToGameState`
— `games.status` itself stays the original coarse `lobby`/`active`/
`completed`, no migration needed, since the engine's finer `boardSetup`
status lives only in the `game_state` row); `GamePage.tsx` renders the
new `BoardSetupView`/`HexBoard` components (a real pointy-top axial SVG
hex grid, click/rotate/confirm tile placement, click-to-place starting
units) instead of the old fake `BoardView.tsx` grid, which is deleted.
Once board setup finishes, `GamePage.tsx` switches to
`src/components/RoundView.tsx` for the round cycle itself
(select-cards/actions/decline/purchase), reading achievement content via
`resolveContent.ts`'s new `resolveAchievementContent()`.

See `todo.md` #7 for the full breakdown of what's covered and what's
still open (mainly: the no-space/move-tiles search, and that none of
this UI has been click-tested end-to-end against a live Supabase
project yet). See `PROJECT_PLAN.md` section 2's board
generation item.

## `achievements.json` (validated by `achievements.schema.json`)

The achievement pool that drives game length, the purchase-phase gold cost,
and part of final scoring:

- `gameLength` — players agree on a target at game start: how many
  achievements, summed across all players (not per player), must be claimed
  before the game ends. `default` is the standard game (4); `min`/`max`
  bound what players may pick instead. `max` is 6 because each of the 6
  achievements can only ever be claimed once, by one player. The actual
  choice starts as `games.settings.gameLength` (`0007_game_settings.sql`,
  defaults to 4), set at creation via `CreateGamePage.tsx`'s `GameLengthSelector` (offers
  4/5/6 — 1-3 technically fits `min`/`max` but ends the game too fast to
  bother offering); `buildGenesisState` (`src/lib/gameGenesis.ts`) carries
  it into `GameState.gameLength` at genesis, so once a game is under way
  `GamePage.tsx` reads it from there (`resolveAchievementContent(gameState.
  gameLength)`, `content/resolveContent.ts`, which clamps it back to
  `min`/`max` for safety) rather than the `games` row — same reason
  `activeTaleIds` moved onto `GameState` too, see below. `RoundView.tsx`'s
  achievements panel shows "N of gameLength achievements claimed" and
  marks whichever decline buyback price corresponds to the game-ending
  achievement.
- `purchaseCost.byAchievementCount` — the gold cost to buy a card back from
  decline, indexed the same way as `victoryPoints.byBoardCount` in
  `units.json`: index 0 is the cost once 1 achievement has been claimed in
  total, index 1 once 2 have, etc. (`[5, 10, 20, 40, 60, 80]`). Cost is 0
  before any achievement has been claimed (not priced by the rules).
  Implemented as `calculatePurchaseCost()` in `src/engine/purchaseCost.ts`.
- `achievements` — one entry per unit type (`unitId` matches `units.json`).
  A player claims an achievement the first time they simultaneously control
  their full per-player `supply` of that unit type (see `units.json`). Once
  claimed, that achievement is gone for the rest of the game — no other
  player can claim it, even if they also reach full supply later.
  `victoryPoints` is the real per-achievement value (10-25, see
  `achievements.json`), not a placeholder.
- `goldVictoryPoints.goldPerPoint` — how much held gold is worth 1 victory
  point, rounded down (currently `2`: 5 gold held is worth 2 VP). The
  fourth VP source, alongside achievement/board-count/terrain-control.

Once the target in `gameLength` is reached (by any combination of players),
the round in progress finishes fully and then the game ends, and whoever
has the most **total** VP wins — achievement VP + board-count VP (both
above) + terrain-control VP (`terrain.json`, above) + gold VP (above) all
added together, with **no tiebreaker** (a tie stands as a shared win). The
four VP sources and the winner-determination itself are implemented as
pure functions in `src/engine/victoryPoints.ts` (`calculateAchievementVP`,
`calculateBoardCountVP`, `calculateGoldVP`, `sumVP`, `determineWinners`)
and are now wired into `finishRound()` (`src/engine/round.ts`, see
`todo.md` #3): `GameState.
claimedByAchievementId` tracks claims live, via `updateAchievementClaims()`
in `src/engine/achievements.ts` — called after every `RESOLVE_UNIT_ACTION`,
since create/convert/a destroySelf transform are the only things that can
change how many of a kind a player controls. All the achievement/VP-curve
content this needs is bundled as `AchievementContent`
(`src/engine/achievementContent.ts`, same content-agnostic pattern as
`UnitContent`) and threaded through `applyAction()`'s optional
`achievementContent` param. Caveat: `calculateBoardCountVP`/
`calculateTerrainControlVP` still only have placeholder VP numbers and no
real generated board to run against, so a finished game today is decided
almost entirely by achievement VP — the win-condition wiring itself is
complete and tested.

Claiming an achievement also drives the decline phase's multi-card rule: a
player must decline more than one card if more than one achievement was
claimed during that round. `GameState.achievementsClaimedThisRound` counts
this (reset to 0 at the start of every round), and `beginDeclinePhase`
(`src/engine/round.ts`) sizes every pending player's required decline count
off it (`max(1, achievementsClaimedThisRound)`).

## `resources.json` (validated by `resources.schema.json`)

The 3 resource types (gold, wood, stone):

- `playerCap` — the max a single player can hold at once. `5` for Wood and
  Stone; `null` for Gold, which is uncapped per player.
- `globalSupply.byPlayerCount` — the shared bank's total supply of this
  resource for a game with that many players — the hard cap on how much of
  it can exist across every player's holdings combined at once. Wood and
  Stone are `5 per player` (`10`/`15`/`20` for 2/3/4 players); Gold doesn't
  scale that simply, so it's an explicit table instead (`522`/`722`/`922`).

`Player.resources` / `GameState.resourceBank` (`src/engine/types.ts`) hold
the live numbers during a game — both are the same `Resources` shape, since
a resource only ever moves from one to the other. `gainResource()`/
`spendResource()` in `src/engine/resources.ts` are the only way that should
happen: `gainResource` caps a transfer from the bank into a player's
holding at both `playerCap` and whatever's left in the bank (the
un-transferred remainder just stays in the bank rather than being lost —
the rules don't say gains beyond the cap vanish); `spendResource` moves the
other way and refuses (returns `null`) if the player doesn't have enough.
`createNewGame`'s `resourceBank` param should be `globalSupply.
byPlayerCount` looked up for however many players are in the game — the
engine doesn't import `resources.json` itself (see `UNIT_KINDS` in
`src/engine/cards.ts`), so the caller resolves it; it defaults to an empty
bank (all `0`) if omitted.

An eliminated player's resources are returned to the bank automatically —
see `eliminatePlayer()` in `src/engine/elimination.ts` and `todo.md` #4.

`gainResource`/`spendResource` are called from every unit action that
produces or costs a resource (`income`/`produce`/`trade`/`trade-resource`,
and `create`/`transform`/`convert`'s `cost`) — see `src/engine/unitActions.
ts` and `UnitActions.md` at the repo root.

## `tales.json` (validated by `tales.schema.json`)

The Tales variant's numbered elements (see `VARIANTS_PLAN.md` at the repo
root for the full design across all 23; Tale #6 (The Banks), Tale #7 (The
Ports), and Tale #8 (The Cathedral) are implemented so far — `todo.md`
#56/#57). Unlike every other content file, this one is entirely **opt-in**:
a base game with no Tales active never reads it. Each Tale is
self-contained:

- `extraUnits` — brand-new unit kinds the Tale introduces (e.g. The Ports'
  Port, The Banks' Bank). Each has **no Civilization card of its own** —
  it's a "companion piece," registered against a different, existing
  kind's card (`companionOfKind`, e.g. Port's is `'ship'`, Bank's is
  `'nomad'`). See `UnitContent.companionKindsByCardKind` and
  `applyResolveUnitAction` (`src/engine/applyAction.ts`) for how the
  engine dispatches this, and `GameState.unitsCreatedThisTurn` for the
  "can't activate the turn it's constructed" rule shared by every
  companion piece the rulebook defines (Capital, the Cathedral, and the
  Ports all use this exact wording). A companion with an empty `actions`
  list (e.g. Bank, which only ever changes hands via the City's Increase
  Taxes action and the Nomad's Construct a Bank action, never by acting
  itself) still needs some `companionOfKind` to satisfy the schema, but
  never actually surfaces as choosable since it has nothing to choose.
- `extraActionsByKind` — extra actions appended onto an **existing** unit
  kind's action list (e.g. Nomad and Ship both gain a Construct a Port
  action; Nomad also gains Construct a Bank, and City gains Increase
  Taxes, for The Banks).
- `movementOverridesByKind` — movement field overrides merged onto an
  existing kind's base movement (e.g. Ship gains
  `canEndMoveOnAlliedUnitTypes: ['port']`).
- `fantasticEvents` — Fantastic Events the Tale contributes (e.g. The
  Banks' Economic Collapse), resolved by `finishRound`
  (`src/engine/round.ts`) whenever two or more players must recycle their
  hand in the same round, in ascending Tale-number order. Each event
  triggers when every non-eliminated player currently controls at least
  one unit of `requiredUnitKind`, removing every unit of that kind from
  the board (back to its owner's reserve) when it does. Unlike the three
  fields above, these never touch `UnitContent` — they flow straight from
  `TaleContent.fantasticEvents` to `finishRound`, which now also takes an
  optional `taleContent` parameter (threaded the same way
  `achievementContent` already was, through `applyAction`/
  `applyActionAndFastForwardTiles`/`replayActions`/`buildTurnReview`/
  `buildGameLog`).
- `controllableStructures` — end-of-game "whoever controls this unique
  piece scores N VP" bonuses (e.g. The Cathedral's 15 VP), also bypassing
  `UnitContent` entirely: `TaleContent.controllableStructures` flows
  straight into `calculateControllableStructureVP`
  (`src/engine/victoryPoints.ts`), the 5th VP source alongside
  achievements/board-count/terrain-control/gold, via the same
  `taleContent` parameter now threaded through `calculateVPBreakdown`/
  `calculateVPDetail`. There's no "Tale card" concept in this engine, so
  control is derived live from board state (does a unit of that `kind`
  exist, and who owns it) rather than a permanent claim like a real
  achievement — control can change hands, or the piece can be destroyed
  and rebuilt, and the bonus simply follows. `RoundView.tsx`'s
  achievements panel shows these in their own "Tale bonuses (claimable)"
  section, visually separate from real `content/achievements.json`
  achievements, precisely because they aren't one.

`src/engine/tales.ts`'s `applyTaleModifiers(baseUnitContent, taleContent)`
merges all of the above onto `resolveUnitContent()`'s result — same
content-agnostic, explicit-param pattern as every other engine function
here. `resolveTaleContent(activeTaleIds, playerCount)`
(`content/resolveContent.ts`) resolves this file, filtered to whichever
Tales are active for a given game, into the `TaleContent` bundle
`applyTaleModifiers` consumes; `listTales()` lists every Tale (for the
Tale-selection UI) regardless of which are active anywhere.

**Which Tales are active is a per-game, creation-time choice** — part of
`games.settings` (`src/lib/dbTypes.ts`'s `GameSettings.activeTaleIds`,
consolidated by `supabase/migrations/0007_game_settings.sql`), set via
`CreateGamePage.tsx`'s `TaleSelector` (checkbox list + a "Randomize" shuffle).
That column only matters up through the lobby, though: `buildGenesisState`
(`src/lib/gameGenesis.ts`) carries the chosen
ids into `GameState.activeTaleIds` once the game starts, so from then on
`GamePage.tsx` builds the game's effective `UnitContent` from
`gameState.activeTaleIds` (memoized alongside the base
`resolveUnitContent()` call), not the `games` row — a running game (and
its RAF-STATE-1 export) is self-contained, and Undo/replay naturally stay
consistent since `activeTaleIds` rides along on every replayed state.
Empty (the default) behaves exactly like a game from before this variant
existed.

Two new `UnitActionEffect` variants exist only for Tale-contributed
actions so far (`unitContent.ts`): `SiteCreateEffect` (create a unit on
the *acting* unit's own hex — for a companion piece whose hex it already
occupies, so the normal "target must be empty" rule can't apply) and
`RegionUnitCountIncomeEffect` (gold per unit of given kinds anywhere in
the acting unit's connected terrain region). `TransformEffect` also
gained an optional `requiredAdjacentTerrain` condition, for Tale actions
that depend on nearby terrain the target hex itself doesn't have, plus
(for The Banks) `requiredAdjacentOwnUnitKind` (adjacent to an allied unit
of a given kind, not just terrain — Construct a Bank's "adjacent to at
least one allied City") and `extraCostPerBoardUnitCount` (extra cost per
existing unit of a kind anywhere on the board — Construct a Bank's 5
extra GP per Bank already in the World; see
`computeEffectiveTransformCost` in `src/engine/unitActions.ts`), plus (for
The Cathedral) `requiredOwnKindCount` (the acting player must control at
least N units of a given kind — Construct the Cathedral's "your 3 Temples
present in the World," checked against the acting Temple's own count) and
`forbiddenIfBoardHasKind` (no unit of a given kind may exist anywhere on
the board — "there's only one Cathedral in the game," which also
naturally allows rebuilding one that's ever removed from the board, since
the check is live rather than a permanent flag). `IncomeEffect` similarly
gained `goldByTerrainScaledByBoardUnitCount` for The Banks' Increase Taxes
(rate-per-terrain times 1 + total units of a
kind on the board, gated on the acting player owning at least one
themselves). Finally, `ConvertEffect` and `IncomeEffect` both gained an
optional `maxDistance` (default 1, i.e. adjacent-only, matching every
pre-Tale unit) for The Cathedral's ability to convert enemy units and
collect taxes up to 2 spaces away rather than just 1 — implemented via
`coordsWithinDistance()` (`src/engine/board.ts`, a BFS generalizing the
existing adjacent-only `neighborCoords`) and `isWithinDistance()`/
`unitsWithinDistance()` (`src/engine/unitActions.ts`). The cliff-crossing
rule is skipped entirely once `maxDistance > 1`, since a cliff is only ever
defined between two adjacent hexes. `VARIANTS_PLAN.md` calls out
`maxDistance` as reusable infrastructure a later Tale (the Psy-Monks guild)
will need too.

## Note on the engine's `Terrain`/`UnitMovement` types (resolved)

`src/engine/types.ts`'s `Terrain` was a 3-value placeholder from the first
milestone (`'land' | 'water' | 'cliff'`) — updated to the real 5 types here.
`UnitMovement` was likewise a simplified placeholder (`domains`/`range`) —
updated to mirror `units.json`'s `movement` object (`isMobile`/`terrains`/
`canCrossCliffs`/`moveDistance`/`blockedByUnits`/`canEndMoveOnUnitTypes`).
Both needed to be real before unit actions (create/transform) could stamp
new units with accurate movement profiles — see `src/engine/unitActions.ts`.
