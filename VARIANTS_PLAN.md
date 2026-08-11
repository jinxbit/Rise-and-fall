# Rise & Fall — Guilds & Tales Variants: Implementation Plan

Companion to `PROJECT_PLAN.md`/`todo.md`. Scopes the work to implement the
rulebook's two variants — **The Guilds** (24 cards) and **The Tales** (23
numbered elements) — on top of the existing rules engine, plus a
project-specific house rule for Guilds requested for this app: a **Shared
Guild mode**, where one Guild card is chosen at setup (by the host or at
random) and its power applies to every player, instead of each player
getting their own dealt card(s).

Source: the attached rulebook PDF, pages 15–24 (Guilds pp.15–17, Tales
pp.18–24). Base-game rules (pp.1–14) are already implemented — see
`PROJECT_PLAN.md`/`todo.md` for that work.

## 0. Where this sits relative to the base game

The base engine isn't fully built out yet either (real board-generation UI,
some of section 3's UI items are still open per `PROJECT_PLAN.md`). This
plan doesn't assume those gaps are closed first — the engine-side variant
work (sections 3–7 below) is independent of the UI layer and can proceed in
parallel — but the **variant UI** (screens, board rendering of special
tiles/creatures) does depend on the base board/round UI existing, so that
part naturally queues up behind it.

## 1. Design principles

Follow the conventions already established by the base engine, don't invent
a parallel style:

- **Content-driven, schema-validated.** New rules content lives in
  `src/content/guilds.json`/`guilds.schema.json` and
  `src/content/tales.json`/`tales.schema.json`, same pattern as
  `units.json`/`achievements.json`/`terrain.json`. The engine never imports
  JSON directly (`src/content/resolveContent.ts` is the one bridge) — see
  `UNIT_KINDS` in `src/engine/cards.ts` for why.
- **Pure, content-agnostic engine functions.** Every new engine function
  takes its content as an explicit parameter (mirroring `UnitContent`/
  `AchievementContent`/`BoardGenerationContent`), defaults to an "empty"
  no-op content bundle so existing callers/tests are unaffected, and never
  reaches into JSON itself.
- **`GameState` is still the single source of truth**, and `applyAction()`
  is still the only way to mutate it. New variant state is new fields on
  `GameState`/`Player`/`Unit`, not a side-channel.
- **Reuse existing mechanisms wherever the rules genuinely match.** Several
  Guild/Tale effects are just parameterized versions of something the
  engine already does (a `TransformEffect` variant, another entry in a
  unit's `actions[]`, another VP source). Where they're *not* — a handful
  of genuinely new capabilities recur across multiple cards (see section
  6's shared-infrastructure list) — build the capability once, generically,
  and let every card/tale that needs it consume it.
- **Prefer "avoid a new player-facing choice" over building one**, when the
  rules leave room. E.g. "double VP for whichever you have most of" or
  "double VP for one Trophy of your choice" can be resolved automatically
  by picking whichever option scores highest for that player, instead of
  adding an explicit decision UI. Flagged per-card below; confirm in
  section 9 before committing to it everywhere.

## 2. Data model additions

New top-level `GameState` fields (`src/engine/types.ts`):

```ts
interface GameState {
  // ...existing fields...
  guildVariant: GuildVariantState | null   // null = variant off
  taleVariant: TaleVariantState | null     // null = variant off
}

type GuildVariantState =
  | { mode: 'perPlayer'; activeGuildIdsByPlayerId: Record<string, string[]> }
  | { mode: 'shared'; activeGuildId: string }

interface TaleVariantState {
  activeTaleIds: string[]              // drawn/chosen at setup, sorted by Tale number for precedence
  claimedSpecialTrophyByTaleId: Record<string, string>   // tale id -> claiming player id
  // + one small per-tale state slice for stateful Tales (creature position,
  //   Volcano active/inactive + orientation, Bank/Port/Capital/Cathedral
  //   presence, laid-down units, etc.) — see section 7.
}
```

`activeGuildIdsByPlayerId` holds 1 entry normally, 2 if a player received a
card from their neighbor (classic per-player mode always deals this way),
3 if the Doppelganger's House Tale is also active. Shared mode collapses
all of that to one id for the whole game — no per-player map needed.

`Unit` gains an optional transient status field for Tale effects that lay
units down (Storm Peak, Typhoon):

```ts
interface Unit {
  // ...existing fields...
  laidDown?: boolean
}
```

## 3. Core mechanism: effective per-player content + a small set of direct hooks

Most Guild powers (and several Tale site-effects) are expressible as a
**delta on `UnitContent`** — the same bundle `applyUnitActionEffect`/
`legalMoveDestinations`/`actionTargeting.ts` already consume:

- "New Action" cards → append an extra `UnitAction` to that kind's
  `actionsByKind[kind]`.
- Movement-changing cards → override/extend that kind's
  `movementByKind[kind]` (terrains, cliff-crossing, distance).
- Cap-changing cards (Collectors) → override `resourceCaps`.

So the integration point is one new pure function:

```ts
// src/engine/guilds.ts
function applyGuildModifiers(
  base: UnitContent,
  activeGuildIds: string[],
  guildContent: GuildContent,
): UnitContent
```

`applyAction()`'s dispatch for `RESOLVE_UNIT_ACTION`/`CHOOSE_CARD`/
targeting resolves this once per acting player (per-player mode) or once
globally (shared mode) and passes the *effective* `UnitContent` through
exactly where it already passes the base one today — no change needed to
`unitActions.ts`'s dispatcher shape itself for this class of card.

That covers roughly two-thirds of the 24 Guild cards. The rest need a
small number of **direct hooks** into specific modules, because they're not
expressible as "this player's available actions/movement changed" — they
change *scoring*, *purchase cost*, *cross-player interactions* (piracy,
theft, attacks, conversion immunity), or *movement blocking based on
another player's units*. Each gets a small, explicit, guild-content-driven
hook:

| Hook point | New param | Consumed by |
|---|---|---|
| `victoryPoints.ts` region-VP calc | per-terrain VP multiplier by active guild | Druids, Farmers |
| `victoryPoints.ts` board-count VP | doubling by active guild (+ auto-pick-best) | Scholars, Travelers |
| `victoryPoints.ts` achievement VP | doubling by active guild (+ auto-pick-best) | Trophy Hunters |
| `victoryPoints.ts` new bonus source | flat/conditional bonus | Capitalists, Collectors |
| `purchaseCost.ts` | discount multiplier by active guild | Archivists |
| `unitActions.ts` `applyConvert` | range + per-distance cost scaling; target-immunity check | Psy-Monks, Shadow Cult |
| `movement.ts` `blocksTransit` | mover's-and-blocker's guild state, not just mover's | Sentinels (+ Winged's exception to it) |

New `UnitActionEffect` variants needed in `src/engine/unitContent.ts` (small,
additive to the existing discriminated union, one new case each in
`unitActions.ts`'s switch):

- `ResourceSwapEffect` — trade one held resource for another with the bank
  (Alchemists; reused by the Tower of the Alchemists Tale).
- `PlayerPaymentEffect` — gain gold paid by another player, not the bank,
  capped at what they actually have (Corsairs' Piracy).
- `StealResourceEffect` — take one resource of choice from an adjacent
  enemy unit's owner, with a once-per-target-per-card-play limiter, similar
  in shape to `resolvedUnitIdsThisTurn` (Thieves' Guild; reused by the Lair
  of the Thieves' Guild Tale).
- `DestroyEffect` — remove an adjacent enemy unit outright, returned to its
  owner's reserve, for a cost (Mercenaries).

## 4. The Guilds variant

### 4.1 Setup: two modes

**Classic per-player mode** (base rulebook rule, p.15): deal 3 Guild cards
to each player from the 24-card deck; each player keeps 1, passes 1
face-down to the player on their left, discards the third back to the box
unseen. Reveal both kept+received cards. Most players end up with 2 active
powers; with 4 players and a 24-card deck, all 24 cards get dealt out (4
players × 3 = 12 hands dealt... — actually the deck is dealt 3-per-player
regardless of player count, so at 2–4 players a chunk of the deck is never
touched; no reshuffling needed mid-game).

**Shared mode (house rule, this request):** one Guild card applies to every
player for the whole game.

- Setup screen: **Off / Classic (per-player) / Shared**. If Shared, a
  second control: pick a specific card from the eligible list, or
  "Randomize."
- Only cards flagged `eligibleInSharedMode: true` in `guilds.json` are
  offered/eligible for random pick — see the table below for the
  recommended flag per card.
- Engine: `beginGuildSetup(state, guildContent, choice)` in a new
  `src/engine/guilds.ts`, called from the same place `beginBoardSetup()` is
  today (`createGame.ts`'s `startGame()`), before board setup — Guild
  powers are known before the world is even built, matching the rulebook's
  own ordering note for Tales ("even before Creating the World").
- **Eligibility recommendation** (data-driven flag, not hardcoded logic —
  a one-line content change if you disagree on any card):
  - **Doppelgangers → ineligible.** Its entire mechanic is "pay 10 GP to
    steal a different opponent's Guild power." With one shared power for
    the whole table, there is no second power to steal — the card has no
    meaning in this mode.
  - **Shadow Cult → ineligible.** Its permanent clause ("none of your
    units may be converted by opponents"), applied to *every* player
    symmetrically, doesn't just buff everyone equally the way the other
    cards do — it deletes the Temple's Convert action for the entire game
    (nobody can ever convert anybody). That's not a variant of the base
    game anymore, it's a different game. Every other card's global version
    is still recognizably a buff; this one is a removal.
  - Everything else is eligible, including a couple flagged **high-impact,
    ship-and-see**: Sentinels (movement-blocking becomes universal, not
    one player's edge) and the three symmetric-threat cards — Corsairs,
    Mercenaries, Thieves' Guild — which feel different when *every* player
    can piracy/attack/steal from every other, rather than one player
    having an edge. Called out as open question 4 in section 9.
- **Random pick fairness** (open question 5, section 9): who resolves the
  random draw, and how, needs a decision before this ships for `async`/
  `hotseat` modes specifically — see section 9.

### 4.2 Card-by-card catalog

24 cards. "Approach" key: **CD** = content-delta only (section 3's
`applyGuildModifiers`); **Hook** = one of section 3's direct hooks; **New**
= needs a new effect type or genuinely new engine capability.

| # | Card | Mechanic (short) | Approach | Complexity | Shared-mode |
|---|---|---|---|---|---|
| 1 | Archivists | Decline purchase at half price (round up) | Hook (purchaseCost) | S | eligible |
| 2 | Capitalists | +25 VP if strongest economy at game end | Hook (VP) | S | eligible |
| 3 | Collectors | Resource cap 10/type; +2 VP per stored resource | CD (cap) + Hook (VP) | S | eligible |
| 4 | Alchemists | Nomad: swap Wood↔Stone | New (`ResourceSwapEffect`) | M | eligible |
| 5 | Corsairs | Ship Piracy: 2 GP per enemy Ship in region, paid by opponents | New (`PlayerPaymentEffect`) | M | eligible (impact flag) |
| 6 | Aquanauts | Nomads can enter/move on Sea (3, cross cliffs in/out); don't block Ships / vice versa | New (composite movement profile) | L | eligible |
| 7 | Doppelgangers | Steal an opponent's Guild power for 10 GP during Recycling | New (round-phase action, `perPlayer`-only) | M | **ineligible** |
| 8 | Lumberjacks | Nomad on Forest produces 2 Wood (not 1) | CD (produce override) | S | eligible |
| 9 | Druids | Nomad can build Temple in Forest; double Forest-region VP | CD + Hook (VP) | M | eligible |
| 10 | Machinists | Ship moves to any Sea space in the World | New (bypass-BFS special case) | M | eligible |
| 11 | Master Jewelers | Nomad/Mountaineer on Mountain: Prospect for 3 GP | CD (extra income action) | S | eligible |
| 12 | Farmers | Triple Plains-region VP | Hook (VP, shares Druids' machinery) | S | eligible |
| 13 | Miners | Nomad on Mountain produces 2 Stone (not 1) | CD | S | eligible |
| 14 | Mercenaries | Nomad attacks adjacent enemy unit for 5 GP, destroys it | New (`DestroyEffect`) | M | eligible (impact flag) |
| 15 | Northerners | Nomad can enter Glacier; build City on Mountain for Stone+Wood | CD + bypass of the hard-coded Glacier-is-Mountaineer-only guard | M–L | eligible |
| 16 | Psy-Monks | Temple conversion range 2 | Hook (convert range) | M | eligible |
| 17 | Snowmen | Mountaineer builds City on Glacier for free; City tax on Glacier = 0 | CD | S | eligible |
| 18 | Scholars | City Education range 2; double VP for Merchants or Mountaineers (choice) | CD + Hook (VP, auto-pick-best) | M | eligible |
| 19 | Shadow Cult | Temple converts adjacent City for 10 GP; your units immune to conversion | New (convert target + immunity) | M | **ineligible** |
| 20 | Sentinels | Opponents' units can't enter/cross your units' spaces; your Merchant/Ship ignore this | Hook (movement blocking, cross-player) | L | eligible (impact flag) |
| 21 | Thieves' Guild | Nomad steals a resource from adjacent enemy City (once/City/card-play) | New (`StealResourceEffect`) | M | eligible (impact flag) |
| 22 | Travelers | Nomad moves 2; City/Temple card can also Abandon (self-transform to Nomad, free); double Nomad-count VP | CD (movement + reuses `TransformEffect` shape) + Hook (VP) | S–M | eligible |
| 23 | Trophy Hunters | Double VP of one claimed Trophy of your choice | Hook (VP, auto-pick-best) | S | eligible |
| 24 | Winged | Nomad moves 2, crosses cliffs/Sea/Glacier/opponents, must land alone on Plains/Forest/Mountain; can pass through Sentinels' units | New (transit-vs-landing terrain split) | L | eligible |

### 4.3 Doppelgangers & the Recycling-phase trade

Only meaningful in `perPlayer` mode (see 4.1). New action type
`TRADE_GUILD_CARD` (playerId, targetPlayerId), valid only during the
Recycling step, spending 10 GP, swapping the Doppelgangers card for the
target's Guild card — the receiving player then holds Doppelgangers, and
per the rulebook can't trade again in the same Recycling phase (a one-shot
flag reset each Recycling step, same shape as
`resolvedUnitIdsThisTurn`). The "note on illegal position" rule (a
converted unit losing a Guild power that put it somewhere illegal must be
forcibly returned/removed) needs its own small legality sweep, run right
after the trade resolves.

### 4.4 Handicap system

The experience-leveling handicap variant (deal 0/1/1/2 Guild cards by
skill level) is a `perPlayer`-mode-only setup convenience, low value versus
effort — recommend deferring unless requested; not scoped further here.

## 5. The Tales variant

### 5.1 Setup

At setup (before Creating the World, same as Guilds), shuffle the 23 Tale
cards and draw one per player (rulebook default) — or, since this is
already a house-rule-friendly project, consider exposing "pick specific
Tales" as an alternative to the blind draw (worth asking, see section 9).
Sort the drawn set by Tale number ascending — this is precedence order for
simultaneous setup/resolution, per the rulebook ("the one with the lowest
number is applied first").

Extra Trophies some Tales grant (Dragon, Majestic Bridge, Capital, Floating
Cities — Leviathan's is ambiguous, see section 9 open question 1) get
added to the Trophy pool at setup; claiming one still counts toward the
game's target Trophy count and still triggers the Decline phase for
everyone, exactly like a base Trophy.

### 5.2 Fantastic Events

New `src/engine/tales.ts`:

```ts
function resolveFantasticEvents(
  state: GameState,
  activeTaleIds: string[],
  taleContent: TaleContent,
): GameState
```

Triggered per rulebook: during the Recycling step, when **two or more
players** must recycle their hand in the same round. Runs each active
Tale's Fantastic Event handler in ascending Tale-number order, resolved by
whoever holds the First Player token *before* recycling; any choices the
event requires (which Ship the Leviathan destroys, which orientation the
Volcano's lava points) are that player's to make.

Wired into `finishRound()` (`round.ts`), right where recycling already
happens — the exact trigger condition ("≥2 players recycled this round")
is already computable from the same `anyRecycled`-style check that
function does today, extended to count *how many* players recycled, not
just whether any did.

### 5.3 Board-setup hooks

Each Tale's special area/creature/piece has an explicit trigger point
("after the last Glacier is placed," "after the last Forest, on a Forest
space," "the next player in turn order places it," "the last player to
place their third starting unit places it"). Rather than one-off special
casing per Tale, extend `boardGeneration.ts`/`boardSetup.ts` with a generic
**setup-hook table**: `Record<SetupTrigger, TaleSetupStep[]>`, where
`SetupTrigger` is one of the handful of distinct trigger points the
rulebook actually uses (`afterLastGlacier`, `afterLastForest`,
`afterLastMountain`, `afterLastPlains`, `afterLastSea`,
`afterStartingUnitsPlaced`), and `boardSetup.ts`'s existing tier-advance
logic fires the matching hooks as each tier completes. A few Tales also
*remove* tiles from the normal pool before placement (Swamp, Typhoon,
Caravansary, Waterfall all reduce the Plains/Mountain/Sea pool by 1) — the
hook table's setup step for those needs to run *before* `resolveContent.ts`
computes `BoardGenerationContent.tiers[...].poolSize`, not after.

### 5.4 Element-by-element catalog

23 elements, grouped by rulebook category. Complexity ratings assume the
shared infrastructure listed at the end of each group already exists.

**Creatures (3)**

| # | Tale | Mechanic (short) | New capability needed | Complexity |
|---|---|---|---|---|
| 1 | Dragon | Placed on Glacier; Fantastic Event destroys adjacent units, then relocates; hunted by 3 same-kind units adjacent + matching card played, claims 20 VP Trophy | Generalized Trophy claim condition (beyond "full unit supply") + stateful creature position | L |
| 2 | Leviathan | Placed on largest Sea region; Fantastic Event destroys/relocates near Ships | Same as Dragon — **claim condition text not found in the extracted rulebook; see open question 1** | L (blocked) |
| 3 | Water Elemental | Placed in busiest coastal Sea region; Fantastic Event floods adjacent coastal Plains into Sea, can merge Sea regions | Mid-game terrain mutation | L |

*Shared infra: generalized Trophy-claim predicates; stateful multi-turn
creature position; mid-game terrain mutation (also needed by Floating
Cities).*

**Buildables (6)**

| # | Tale | Mechanic (short) | New capability needed | Complexity |
|---|---|---|---|---|
| 4 | Capital | Merge 4 adjacent Cities into one Capital (no card of its own); double-activates on City card; 20 VP Trophy | "Companion piece activated by an existing card" pattern | L |
| 5 | Majestic Bridge | 2 aligned Nomads (same terrain, split by Sea) build a bridge spanning the gap; indestructible, unowned, not a Region; 20 VP Trophy | New non-terrain, non-unit traversable construct | L |
| 6 | The Banks | Per-player Bank piece; Nomad builds (cost scales with # in World); City "Increase Taxes" scales with # in World; Fantastic Event Economic Collapse if every player has one | Board-wide unit-count-scaling income effect | M |
| 7 | The Ports | Per-player Port piece; Nomad or Ship builds; Ship-card companion action trades per Ship+Port in region; holds only owner's Ship | Companion-piece pattern (reuse Capital's) + stacking exception | L |
| 8 | The Cathedral | Built once 3 Temples exist, replacing one, single global instance; Temple-card companion action, conversion/tax at range 2; 15 VP if held at game end; rebuildable if destroyed | Companion-piece pattern + range-2 conversion (reuse Psy-Monks guild machinery) | M–L |
| 9 | Floating Cities | Nomad consumes a reserve City to place a tile turning a Sea hex into a City-hosting Plains-equivalent hex; Trophy to most-built when pool exhausted, ties get none | Mid-game terrain mutation (reuse Water Elemental's) | M |

*Shared infra: companion-piece activation (Capital, Ports, Cathedral);
mid-game terrain mutation (Floating Cities, reusing Water Elemental's).*

**Special areas, present from setup (14)**

| # | Tale | Mechanic (short) | New capability needed | Complexity |
|---|---|---|---|---|
| 10 | Dolmens | Blocks its own hex; protects units within 2 spaces from conversion; indestructible | Distance-based conversion immunity (reuse Shadow Cult guild's immunity check, parameterized by range) + no-entry hex | M |
| 11 | Storm Peak | Adjacent Nomad/Ship/Merchant lays down on entry (skips next action until its card is replayed); Mountaineer just stops | Unit status effect ("laid down") | L (built once, reused by #19) |
| 12 | Sunken City | Placed in a deliberately-reserved Sea "hole"; adjacent/on Ship action for a player-chosen reward (5 GP / 1 Wood / 1 Stone); majority-adjacent 20 VP | Board-gen "reserve exactly one hole" constraint + player-choice-of-reward effect shape + majority-control helper | L |
| 13 | Orb of Acceleration | One per player on Sea near Plains; any land unit landing there must move again immediately | Chained/forced follow-up movement resolution | L |
| 14 | Gigantic Cavern | On Mountain; Mountaineer there: free transform to City | Location-gated free action (variant of existing `TransformEffect`) | S–M |
| 15 | The Swamp | 4 no-terrain tiles (0 VP, no Region), placed in place of some Plains + 2 more on Sea; blocks City/Ship, land units pass/stop | **New `Terrain` value** — touches movement, scoring, board-gen `placesOn`, cliff levels | L (widest blast radius of any single Tale) |
| 16 | Monastery of the Psy-Monks | On Glacier; Temples within 3 spaces get range-scaled conversion (1×/2×/3× cost by distance) | Reuses Psy-Monks guild's range machinery, extended with per-distance cost scaling | M |
| 17 | Doppelganger's House | Any unit pays 10 GP to draw 3 unused Guild cards, keep 1, return 2 | "Site action," independent of played card + a live undealt-card draw pile | L, **`perPlayer`-guild-mode-only** |
| 18 | Lair of the Thieves' Guild | Majority-adjacent control grants the Thieves'-Guild Nomad steal action | Reuses Thieves' Guild's `StealResourceEffect` + majority-control helper, dynamic per-turn eligibility | M |
| 19 | The Typhoon | Blocks entry/construction; Fantastic Event lays down all adjacent units, then relocates | Reuses "laid down" (#11) + no-entry hex + a repositionable special tile + scoring's region-split handling | L |
| 20 | The Waterfall | 2 fixed tiles (Forest bottom / Glacier top) by a Mountain; bottom-space unit gets amplified produce; 5 VP per occupied space at game end | Paired-tile setup placement + location-gated produce override + new per-occupied-space VP source | M |
| 21 | Tower of the Alchemists | On Plains; any unit within 1 space can swap Wood↔Stone with the bank | Reuses Alchemists guild's `ResourceSwapEffect`, as a site action rather than kind-gated | M |
| 22 | The Caravansary | On Plains; majority-adjacent-or-on control lets Merchant card grant every Merchant 2 actions instead of 1 | Majority-control helper (reuse #18) + a "double activation" flag threaded into per-unit action resolution | M–L |
| 23 | Worshipers of the Volcano God | Double-sided 3-hex tile on Forest; Fantastic Event flips active/erupts; no unit ever enters its hexes; 30 VP (split on ties) to majority-adjacent control at game end; not part of any Region itself | No-entry hex + active/inactive stateful Fantastic Event cycle (reuse Dragon's shape) + majority-control helper | L |

*Shared infra this group needs, in build-once-reuse-often order: no-entry
hex; unit "laid down" status; majority-adjacent-control helper; site-gated
actions (independent of played card); a new `Terrain` value (Swamp — only
this one card needs it, isolated on purpose).*

## 6. Shared infrastructure — build once, unlock many

Cross-referencing sections 4 and 5, these primitives each unlock multiple
cards/Tales and should be built ahead of the specific cards that need them:

1. **Effective per-player `UnitContent`** (section 3) — unlocks ~16 of the
   24 Guild cards on its own.
2. **New effect types**: `ResourceSwapEffect`, `PlayerPaymentEffect`,
   `StealResourceEffect`, `DestroyEffect` — Alchemists/Corsairs/Thieves'
   Guild/Mercenaries, each reused by a Tale later.
3. **Conversion range + cost scaling, and target immunity** — Psy-Monks +
   Shadow Cult guilds; reused by Dolmens, Monastery of the Psy-Monks, the
   Cathedral.
4. **Generalized Trophy claim predicates** (beyond "reached full unit
   supply") — Dragon, Capital, Majestic Bridge, Floating Cities.
5. **Unit status effect ("laid down")** — Storm Peak, Typhoon.
6. **No-entry / no-construction hex** — Dolmens, Typhoon, Volcano, the
   Majestic Bridge's own space.
7. **Majority-adjacent-control helper** — Lair of the Thieves' Guild, the
   Caravansary, Worshipers of the Volcano God, Sunken City, Dolmens.
8. **"Companion piece activated by an existing card"** — Capital, Ports,
   Cathedral.
9. **Mid-game terrain mutation** — Water Elemental, Floating Cities.
10. **Site-gated actions** (any unit, independent of the card played that
    turn) — Doppelganger's House, Tower of the Alchemists, Gigantic
    Cavern, Sunken City, the Waterfall.
11. **Transit-vs-landing terrain split in movement** — Winged; also
    clarifies Aquanauts/Machinists' special movement.

## 7. Phased roadmap

**Phase 0 — Scaffolding.** `guilds.json`/`tales.json` + schemas (ids/
names/descriptions only), `GameState.guildVariant`/`taleVariant`,
`resolveContent.ts` additions, setup UI (mode pickers), Guild dealing
(classic + shared, with the eligibility flag and host-pick/random flow).
No card effects yet. Tests: setup/dealing only.

**Phase 1 — Guild content-delta infra + the ~11 simplest cards.**
`applyGuildModifiers`, the 4 new effect types, wiring into
`applyAction()`/`actionTargeting.ts`. Cards: Lumberjacks, Miners, Master
Jewelers, Snowmen, Collectors (cap half), Alchemists, Corsairs,
Mercenaries, Thieves' Guild, Machinists, Archivists.

**Phase 2 — Guild scoring hooks.** `victoryPoints.ts`/`scoring.ts`
extension points. Cards: Capitalists, Collectors (VP half), Druids,
Farmers, Scholars, Travelers, Trophy Hunters.

**Phase 3 — Movement engine upgrades.** Transit-vs-landing split,
cross-player blocking hook, composite/bypass movement profiles. Cards:
Winged, Sentinels, Aquanauts, Northerners (+ its Glacier-guard exception).

**Phase 4 — Remaining bespoke guild hooks.** Conversion range/cost/
immunity generalization (built here, reused in Phase 7). Cards: Psy-Monks,
Shadow Cult (data-flagged ineligible for shared mode, but still built for
classic mode), Druids' Temple-in-Forest variant, Doppelgangers' Recycling
trade action.

**Phase 5 — Guild variant checkpoint.** Shared-mode audit of every card
built so far (symmetric-threat balance pass — flagged cards from 4.2),
full regression suite, setup UI polished end-to-end. **Guilds variant is
feature-complete here** — a natural point to ship/playtest before starting
Tales.

**Phase 6 — Tales infra.** Generalized Trophy-claim predicates, Fantastic
Event framework (`tales.ts`), board-setup hook table, "laid down" status,
no-entry hex, majority-control helper, mid-game terrain mutation,
site-gated actions, companion-piece activation.

**Phase 7 — Tale elements**, in this order (each group leans on Phase 6 +
earlier groups' infra):
1. Gigantic Cavern, Tower of the Alchemists, the Waterfall, Monastery of
   the Psy-Monks, Lair of the Thieves' Guild.
2. Storm Peak, the Typhoon, the Dragon, Worshipers of the Volcano God.
3. Water Elemental, Floating Cities, the Sunken City (+ its board-gen
   "reserve a hole" exception).
4. Capital, the Ports, the Cathedral.
5. The Banks, the Majestic Bridge, the Orb of Acceleration, the
   Caravansary, Dolmens.
6. The Swamp (new `Terrain` value — isolated on purpose, touches the most
   files of any single card).
7. Doppelganger's House — only if/once `perPlayer` guild mode + Tales
   together is confirmed in scope (section 9, open question 3).
8. The Leviathan — blocked until its claim condition is confirmed
   (section 9, open question 1).

**Phase 8 — Variant UI.** Guild power display (per-player badges /
shared-mode banner), Tale board rendering (special tiles/creatures on
`HexBoard`), Fantastic Event narration in the game log, both setup
screens.

**Phase 9 — Docs.** Update `content/README.md`, `PROJECT_PLAN.md`,
`todo.md` per the existing conventions once implementation actually
starts (this plan doc records the *design*; those track *progress*, same
split as today).

## 8. Testing strategy

Mirror the existing `src/engine/__tests__/` structure: one test file per
new engine module (`guilds.test.ts`, `tales.test.ts`, plus additions to
`unitActions.test.ts`/`movement.test.ts`/`victoryPoints.test.ts`/
`scoring.test.ts`/`purchaseCost.test.ts` for the direct hooks). Each
card/Tale gets at least one test proving its effect actually fires under
the right condition and doesn't fire without the guild/tale active — same
bar the base game's 258+ tests already hold. Shared-mode-specific tests
should assert the effect applies to *every* player, not just the "owner"
concept per-player mode has.

## 9. Open questions — need your input before/while implementing

1. **Leviathan's Trophy claim condition isn't in the extracted rulebook
   text.** Every other Trophy-Tale (Dragon, Majestic Bridge, Capital,
   Floating Cities) states explicitly how the Trophy is claimed; Leviathan's
   entry (p.19) only has Components/Setup/Fantastic Event. Either the
   physical rulebook has it somewhere this extraction missed, or it needs a
   ruling. Blocks Phase 7's last item either way.
2. **"Double VP for X of your choice" cards** (Scholars, Trophy Hunters):
   recommend auto-picking whichever option scores highest for that player
   at game end, instead of adding an explicit choice UI. Confirm, or do you
   want a real decision moment (and if so, committed once, or re-decidable
   every scoring)?
3. **Doppelgangers (guild) and Doppelganger's House (tale)** are both only
   meaningful in `perPlayer` guild mode. Confirm they're simply
   unavailable/no-op when Tales runs alongside Shared guild mode, rather
   than trying to give them a shared-mode meaning.
4. **Shared-mode "impact flag" cards** — Sentinels, Corsairs, Mercenaries,
   Thieves' Guild — are left eligible but noted as changing the game's feel
   more than most (universal rather than one-sided). Ship them and see how
   they play, or exclude any preemptively?
5. **Random-pick fairness for Shared mode.** Who resolves "Randomize" —
   whichever client clicks "start" (visible client-side RNG, re-rollable by
   just not clicking start until you like the result), or does this need a
   server-side/seeded resolution for `async`/`hotseat` play specifically?
   Needs deciding before Phase 0's setup UI ships.
6. **Sequencing** — this plan recommends finishing Guilds (through Phase 5)
   as a shippable checkpoint before starting Tales (Phase 6+), since
   they're roughly comparable in size and mostly independent. Confirm that
   ordering, or prefer interleaving/prioritizing specific Tales sooner?
7. **Tale draw**: blind draw of one Tale per player count (rulebook
   default) vs. exposing a "pick specific Tales" host control the way
   Shared guild mode does. Worth adding the same flexibility, or keep the
   blind draw for Tales?
