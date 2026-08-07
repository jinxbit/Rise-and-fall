# Game content data

Hand-authored game content, kept separate from `src/engine/` (rules logic)
and `src/lib/` (Supabase/network). Not wired into the engine or UI yet —
these are editable JSON files for you to fill in; the next milestone reads
them and encodes the actual `applyAction()` logic against them.

## `units.json` (validated by `units.schema.json`)

One entry per unit type. `id` matches the engine's `Unit.kind` field
(`src/engine/types.ts`). For each unit:

- `movement.isMobile` — `false` for static units like settlements.
- `movement.terrains` — which of the 5 terrain types (see below) this unit
  can move onto.
- `movement.canCrossCliffs` — whether this unit ignores cliff edges, which
  otherwise block movement/adjacency for every other unit.
- `actions` — the list of actions this unit's card can trigger. A card is
  associated with exactly one unit type; playing it lets the player pick
  one action from this list and apply it to every unit of that type they
  control. Each action has an open-ended `effect` field — put whatever
  notes/parameters make sense (move distance, resource yield, etc.) until
  the exact rule text is locked in.

Pre-filled with the three unit kinds already known from the starting tribe
(settlement, mobile unit, ship) — `name`, `description`, `movement.terrains`,
and `actions` are left blank/empty where the rules aren't decided yet.

## `terrain.json` (validated by `terrain.schema.json`)

The 5 terrain types (water, plain, forest, mountain, glacier) plus:

- `placesOn` — which terrain type(s) this one may be placed on top of during
  board setup (e.g. `plain.placesOn = ["water"]`). `null` only for water,
  the base terrain.
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

## Note on the engine's `Terrain` type

`src/engine/types.ts` still has the placeholder terrain union from the
first milestone (`'land' | 'water' | 'cliff'`). It needs updating to the 5
types here (and cliffs reworked as a per-unit `canCrossCliffs` capability
rather than a terrain type) once board generation is built — flagged so it
doesn't get missed, not changed yet since these content files were the ask.
