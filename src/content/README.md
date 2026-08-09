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
- `movement.moveDistance` — max hexes a unit can move in one `MOVE_UNIT`
  action, or the string `"unlimited"` for a unit with no distance cap (only
  Ship today). `"unlimited"` doesn't mean "move anywhere" — a unit's move is
  still restricted to `movement.terrains`, so Ship's unbounded search
  naturally stops at the edge of its connected water region and can't reach
  a disconnected body of water, satisfying "movement allowance is infinity,
  but it can't move out of its water region."
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
  (a breadth-first search from the unit's hex), wired into `MOVE_UNIT` via
  `applyMoveUnit()` in `src/engine/applyAction.ts`.
- `victoryPoints.byBoardCount` — the board-control VP scoring curve: index 0
  is the score for having exactly 1 of this unit on the board, index 1 for
  2, etc. (e.g. `[1, 2, 3, 4]` scores 1/2/3/4 units as 1/2/3/4 points). 0
  units always scores 0; a count past the array's length scores the last
  entry. Empty until the real curve is decided.
- `actions` — the list of actions this unit's card can trigger. A card is
  associated with exactly one unit type; playing it lets the player pick
  one action from this list and apply it to every unit of that type they
  control. Each action has an `effect` field — its shape is now typed
  precisely per `actionType` (`create`/`transform`/`convert`/`income`/
  `produce`/`trade-resource`/`trade`) in `src/engine/unitContent.ts`'s
  `UnitActionEffect`, and implemented in `src/engine/unitActions.ts`. See
  `UnitActions.md` at the repo root for the full per-action checklist and
  the handful of open rules questions the implementation rested a
  documented assumption on.

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
    what "how the hexagons are joined together" becomes in data. Currently
    empty; fill in one entry per distinct tile shape you have.
  - `limits.byPlayerCount` — how many tiles from that group are available
    in the base game, keyed by player count (`"2"`/`"3"`/`"4"`).
  - `limits.modules` — additional tiles contributed by an optional module,
    keyed by module id, additive on top of `byPlayerCount`. Empty until you
    have modules to define.

## `achievements.json` (validated by `achievements.schema.json`)

The achievement pool that drives game length, the purchase-phase gold cost,
and part of final scoring:

- `gameLength` — players agree on a target at game start: how many
  achievements, summed across all players (not per player), must be claimed
  before the game ends. `default` is the standard game (4); `min`/`max`
  bound what players may pick instead. `max` is 6 because each of the 6
  achievements can only ever be claimed once, by one player.
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
  `victoryPoints` is a placeholder `1` for every achievement until the real
  VP scoring rules are given.

Once the target in `gameLength` is reached (by any combination of players),
the round in progress finishes fully and then the game ends, and whoever
has the most **total** VP wins — achievement VP + board-count VP (both
above) + terrain-control VP (`terrain.json`, above) all added together, with
**no tiebreaker** (a tie stands as a shared win). The three VP sources and
the winner-determination itself are implemented as pure functions in
`src/engine/victoryPoints.ts` (`calculateAchievementVP`,
`calculateBoardCountVP`, `sumVP`, `determineWinners`) and tested against
synthetic data, the same way `calculateTerrainControlVP` was — none of this
is wired into `finishRound()` yet (see `todo.md` #3), since `GameState`
doesn't track claimed achievements at all yet, and real board generation
still doesn't exist for the terrain-control piece.

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

## Note on the engine's `Terrain`/`UnitMovement` types (resolved)

`src/engine/types.ts`'s `Terrain` was a 3-value placeholder from the first
milestone (`'land' | 'water' | 'cliff'`) — updated to the real 5 types here.
`UnitMovement` was likewise a simplified placeholder (`domains`/`range`) —
updated to mirror `units.json`'s `movement` object (`isMobile`/`terrains`/
`canCrossCliffs`/`moveDistance`/`blockedByUnits`/`canEndMoveOnUnitTypes`).
Both needed to be real before unit actions (create/transform) could stamp
new units with accurate movement profiles — see `src/engine/unitActions.ts`.
