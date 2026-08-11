# Rise & Fall — Guilds & Tales Variants: Implementation Plan

Companion to `PROJECT_PLAN.md`/`todo.md`. Scopes the work to implement the
rulebook's two variants — **The Tales** (23 numbered elements) and **The
Guilds** (24 cards) — on top of the existing rules engine, plus a
project-specific house rule for Guilds requested for this app: a **Shared
Guild mode**, where one Guild card is chosen at setup (by the host or at
random) and its power applies to every player, instead of each player
getting their own dealt card(s).

Source: the attached rulebook PDF, pages 15–24 (Guilds pp.15–17, Tales
pp.18–24). Base-game rules (pp.1–14) are already implemented — see
`PROJECT_PLAN.md`/`todo.md` for that work.

**Build order: Tales first, then Guilds** (confirmed — see the decisions
log below). Sections are ordered to match: Tales (5) before Guilds (4) is
intentionally out of numeric order relative to earlier drafts of this doc,
kept as section 4/5 for stable cross-references, but read section 5 first.

## 0. Where this sits relative to the base game

The base engine isn't fully built out yet either (real board-generation UI,
some of section 3's UI items are still open per `PROJECT_PLAN.md`). This
plan doesn't assume those gaps are closed first — the engine-side variant
work is independent of the UI layer and can proceed in parallel — but the
**variant UI** (screens, board rendering of special tiles/creatures) does
depend on the base board/round UI existing, so that part naturally queues
up behind it.

## 1. Decisions log

Resolved while scoping this plan (dated by conversation, not calendar —
recorded here so the *why* survives, same spirit as `todo.md`'s changelog):

1. **Leviathan has no Trophy.** Re-checked the source PDF with layout
   preserved to rule out a column-order extraction artifact — confirmed
   real: unlike the Dragon and Water Elemental, the Leviathan's
   "Components" line reads **"1 game piece"** only, no Trophy. It's a pure
   hazard creature (Fantastic Event only), not a Trophy-Tale. This isn't a
   house ruling, it's a correction — earlier drafts of this doc mis-copied
   it as having a Trophy. Not blocked; see section 5.4.
2. **"Double VP for X of your choice" cards** (Scholars, Trophy Hunters):
   auto-pick whichever option scores the player the most VP at game end —
   no new choice UI.
3. **Doppelgangers (guild) and Doppelganger's House (tale)**: no-op /
   unavailable whenever Shared guild mode is active. Both mechanics only
   make sense against a per-player-dealt pool of Guild powers.
4. **Sequencing: Tales first, then Guilds** — reversed from this doc's
   original recommendation. Roadmap (section 6) is restructured
   accordingly: shared capabilities that both variants use (conversion
   range/immunity, resource-swap, steal-resource) are now built generically
   *during Tales work*, and the Guild cards that also want them (Psy-Monks,
   Alchemists, Thieves' Guild) reuse what Tales already built, not the
   other way around.
5. **Shared guild mode eligibility — excluded, beyond Doppelgangers/Shadow
   Cult (see section 4.1's original rationale for those two): Sentinels,
   Corsairs, Mercenaries, and Thieves' Guild are also excluded from Shared
   mode**, at least for now. All four turn from "one player's edge" into
   "a universal rule affecting every player identically" when shared,
   which changes the game's feel more than the other 18 cards' shared
   versions do. They're still fully implemented for Classic per-player
   mode — only their `eligibleInSharedMode` content flag is `false`.
6. **Shared mode's "Randomize" resolves client-side**, whoever clicks
   Start — no new server-side/seeded infra for now. Trust-based (a host
   could technically decline to click Start until they like a re-roll),
   accepted as fine for this project's friend-group scale.
7. **Tale selection supports both a blind random draw and host-picking
   specific Tales** — same flexibility as Shared guild mode, not just the
   rulebook's default blind draw.

## 2. Design principles

Follow the conventions already established by the base engine, don't invent
a parallel style:

- **Content-driven, schema-validated.** New rules content lives in
  `src/content/tales.json`/`tales.schema.json` and
  `src/content/guilds.json`/`guilds.schema.json`, same pattern as
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
- **Build shared capabilities generically, where either variant consumes
  them.** A handful of genuinely new engine capabilities are needed by
  both Tales and Guilds (see section 3's table). Since Tales is built
  first (decision 4), these get built as part of Tales work, with no
  Guild-specific assumptions baked in — the Guild cards that want the same
  capability later just consume it.
- **Avoid new player-facing choices where the rules leave room** — decision
  2 is the concrete instance; apply the same instinct elsewhere if a
  similar "of your choice" case shows up during implementation.

## 3. Data model additions

New top-level `GameState` fields (`src/engine/types.ts`):

```ts
interface GameState {
  // ...existing fields...
  taleVariant: TaleVariantState | null     // null = variant off
  guildVariant: GuildVariantState | null   // null = variant off
}

interface TaleVariantState {
  activeTaleIds: string[]              // drawn or chosen at setup, sorted by Tale number for precedence
  claimedSpecialTrophyByTaleId: Record<string, string>   // tale id -> claiming player id
  // + one small per-tale state slice for stateful Tales (creature position,
  //   Volcano active/inactive + orientation, Bank/Port/Capital/Cathedral
  //   presence, laid-down units, etc.) — see section 5.4.
}

type GuildVariantState =
  | { mode: 'perPlayer'; activeGuildIdsByPlayerId: Record<string, string[]> }
  | { mode: 'shared'; activeGuildId: string }
```

`activeGuildIdsByPlayerId` holds 1 entry normally, 2 if a player received a
card from their neighbor (classic per-player mode always deals this way),
3 if the Doppelganger's House Tale is also active (decision 3: not
possible in `shared` mode). Shared mode collapses all of that to one id for
the whole game — no per-player map needed.

`Unit` gains an optional transient status field for Tale effects that lay
units down (Storm Peak, Typhoon):

```ts
interface Unit {
  // ...existing fields...
  laidDown?: boolean
}
```

## 4. The Guilds variant

### 4.1 Setup: two modes

**Classic per-player mode** (base rulebook rule, p.15): deal 3 Guild cards
to each player from the 24-card deck; each player keeps 1, passes 1
face-down to the player on their left, discards the third back to the box
unseen. Reveal both kept+received cards. Most players end up with 2 active
powers; at 2–4 players, a chunk of the 24-card deck is never dealt at all
(3 per player regardless of player count) — no reshuffling needed mid-game.

**Shared mode (house rule, this request):** one Guild card applies to every
player for the whole game.

- Setup screen: **Off / Classic (per-player) / Shared**. If Shared, a
  second control: pick a specific card from the eligible list, or
  "Randomize" (resolved client-side by whoever clicks Start — decision 6).
- Only cards flagged `eligibleInSharedMode: true` in `guilds.json` are
  offered/eligible for random pick.
- Engine: `beginGuildSetup(state, guildContent, choice)` in a new
  `src/engine/guilds.ts`, called from the same place `beginBoardSetup()` is
  today (`createGame.ts`'s `startGame()`), before board setup — Guild
  powers are known before the world is even built, matching the rulebook's
  own ordering note for Tales ("even before Creating the World").
- **Eligibility — 6 of 24 cards excluded** (data-driven flag, not
  hardcoded logic — a one-line content change if this changes later):
  - **Doppelgangers.** Its entire mechanic is "pay 10 GP to steal a
    *different* opponent's Guild power." With one shared power for the
    whole table, there's no second power to steal.
  - **Shadow Cult.** Its permanent clause ("none of your units may be
    converted by opponents"), applied to every player symmetrically,
    doesn't buff everyone the way the other cards do — it deletes the
    Temple's Convert action for the entire game (nobody can ever convert
    anybody). Every other card's shared version is still recognizably a
    buff; this one is a removal.
  - **Sentinels, Corsairs, Mercenaries, Thieves' Guild** (decision 5).
    Each turns from "one player's edge" into a universal rule (nobody's
    land units can ever pass through anybody's units; everyone can
    piracy/attack/steal from everyone) — a bigger shift in the game's feel
    than the other 18 cards' shared versions, so held back from Shared
    mode for now while everything else ships. Still fully built for
    Classic mode.

### 4.2 Card-by-card catalog

24 cards. "Approach" key: **CD** = content-delta only (section 6's
`applyGuildModifiers`); **Hook** = one of section 6's direct hooks; **New**
= needs a new effect type or genuinely new engine capability (built
generically during Tales work per decision 4, where noted).

| # | Card | Mechanic (short) | Approach | Complexity | Shared-mode |
|---|---|---|---|---|---|
| 1 | Archivists | Decline purchase at half price (round up) | Hook (purchaseCost) | S | eligible |
| 2 | Capitalists | +25 VP if strongest economy at game end | Hook (VP) | S | eligible |
| 3 | Collectors | Resource cap 10/type; +2 VP per stored resource | CD (cap) + Hook (VP) | S | eligible |
| 4 | Alchemists | Nomad: swap Wood↔Stone | `ResourceSwapEffect` (built for Tower of the Alchemists tale, reused here) | S once shared, else M | eligible |
| 5 | Corsairs | Ship Piracy: 2 GP per enemy Ship in region, paid by opponents | New (`PlayerPaymentEffect`) | M | **ineligible** |
| 6 | Aquanauts | Nomads can enter/move on Sea (3, cross cliffs in/out); don't block Ships / vice versa | New (composite movement profile) | L | eligible |
| 7 | Doppelgangers | Steal an opponent's Guild power for 10 GP during Recycling | New (round-phase action, `perPlayer`-only) | M | **ineligible** |
| 8 | Lumberjacks | Nomad on Forest produces 2 Wood (not 1) | CD (produce override) | S | eligible |
| 9 | Druids | Nomad can build Temple in Forest; double Forest-region VP | CD + Hook (VP) | M | eligible |
| 10 | Machinists | Ship moves to any Sea space in the World | New (bypass-BFS special case) | M | eligible |
| 11 | Master Jewelers | Nomad/Mountaineer on Mountain: Prospect for 3 GP | CD (extra income action) | S | eligible |
| 12 | Farmers | Triple Plains-region VP | Hook (VP, shares Druids' machinery) | S | eligible |
| 13 | Miners | Nomad on Mountain produces 2 Stone (not 1) | CD | S | eligible |
| 14 | Mercenaries | Nomad attacks adjacent enemy unit for 5 GP, destroys it | New (`DestroyEffect`) | M | **ineligible** |
| 15 | Northerners | Nomad can enter Glacier; build City on Mountain for Stone+Wood | CD + bypass of the hard-coded Glacier-is-Mountaineer-only guard | M–L | eligible |
| 16 | Psy-Monks | Temple conversion range 2 | Conversion-range machinery (built for Monastery of the Psy-Monks tale, reused here) | S once shared, else M | eligible |
| 17 | Snowmen | Mountaineer builds City on Glacier for free; City tax on Glacier = 0 | CD | S | eligible |
| 18 | Scholars | City Education range 2; double VP for Merchants or Mountaineers (auto-picked — decision 2) | CD + Hook (VP) | M | eligible |
| 19 | Shadow Cult | Temple converts adjacent City for 10 GP; your units immune to conversion | Conversion-immunity machinery (built for Dolmens tale, reused here) + new convert target | M | **ineligible** |
| 20 | Sentinels | Opponents' units can't enter/cross your units' spaces; your Merchant/Ship ignore this | Hook (movement blocking, cross-player) | L | **ineligible** |
| 21 | Thieves' Guild | Nomad steals a resource from adjacent enemy City (once/City/card-play) | `StealResourceEffect` (built for Lair of the Thieves' Guild tale, reused here) | S once shared, else M | **ineligible** |
| 22 | Travelers | Nomad moves 2; City/Temple card can also Abandon (self-transform to Nomad, free); double Nomad-count VP | CD (movement + reuses `TransformEffect` shape) + Hook (VP) | S–M | eligible |
| 23 | Trophy Hunters | Double VP of one claimed Trophy of your choice (auto-picked — decision 2) | Hook (VP) | S | eligible |
| 24 | Winged | Nomad moves 2, crosses cliffs/Sea/Glacier/opponents, must land alone on Plains/Forest/Mountain; can pass through Sentinels' units | New (transit-vs-landing terrain split) | L | eligible |

18 of 24 cards eligible for Shared mode; 6 excluded (Doppelgangers, Shadow
Cult, Sentinels, Corsairs, Mercenaries, Thieves' Guild).

### 4.3 Doppelgangers & the Recycling-phase trade

Only meaningful in `perPlayer` mode. New action type `TRADE_GUILD_CARD`
(playerId, targetPlayerId), valid only during the Recycling step, spending
10 GP, swapping the Doppelgangers card for the target's Guild card — the
receiving player then holds Doppelgangers, and per the rulebook can't
trade again in the same Recycling phase (a one-shot flag reset each
Recycling step, same shape as `resolvedUnitIdsThisTurn`). The "note on
illegal position" rule (a converted unit losing a Guild power that put it
somewhere illegal must be forcibly returned/removed) needs its own small
legality sweep, run right after the trade resolves.

### 4.4 Handicap system

The experience-leveling handicap variant (deal 0/1/1/2 Guild cards by
skill level) is a `perPlayer`-mode-only setup convenience, low value versus
effort — recommend deferring unless requested; not scoped further here.

## 5. The Tales variant

### 5.1 Setup

At setup (before Creating the World, same as Guilds), choose the active
Tales (decision 7 — both supported):

- **Blind random draw** (rulebook default): shuffle the 23 Tale cards,
  draw one per player.
- **Host-picks specific Tales**: same UI pattern as Shared guild mode's
  card picker — a list of all 23, host selects exactly `playerCount` of
  them (or, arguably, any count — worth deciding at implementation time
  whether to enforce the rulebook's 1-per-player count or allow any
  number; default to enforcing it, since the Trophy-pool/game-length math
  in `content/achievements.json` assumes a bounded, deliberate set).

Either way, sort the active set by Tale number ascending — this is
precedence order for simultaneous setup/resolution, per the rulebook
("the one with the lowest number is applied first").

Extra Trophies some Tales grant (Dragon, Majestic Bridge, Capital, Floating
Cities — **not** Leviathan, decision 1) get added to the Trophy pool at
setup; claiming one still counts toward the game's target Trophy count and
still triggers the Decline phase for everyone, exactly like a base Trophy.

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
| 2 | Leviathan | Placed on largest Sea region; Fantastic Event destroys/relocates near Ships | Stateful creature position only — **no Trophy, no claim mechanic** (decision 1) | M |
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
| 7 | The Ports | Per-player Port piece; Nomad or Ship builds; Ship-card companion action trades per Ship+Port in region; holds only owner's Ship | Companion-piece pattern (shares Capital's) + stacking exception | L |
| 8 | The Cathedral | Built once 3 Temples exist, replacing one, single global instance; Temple-card companion action, conversion/tax at range 2; 15 VP if held at game end; rebuildable if destroyed | Companion-piece pattern + range-2 conversion (the same conversion-range machinery Psy-Monks guild later reuses) | M–L |
| 9 | Floating Cities | Nomad consumes a reserve City to place a tile turning a Sea hex into a City-hosting Plains-equivalent hex; Trophy to most-built when pool exhausted, ties get none | Mid-game terrain mutation (shares Water Elemental's) | M |

*Shared infra: companion-piece activation (Capital, Ports, Cathedral);
mid-game terrain mutation (Floating Cities, sharing Water Elemental's).*

**Special areas, present from setup (14)**

| # | Tale | Mechanic (short) | New capability needed | Complexity |
|---|---|---|---|---|
| 10 | Dolmens | Blocks its own hex; protects units within 2 spaces from conversion; indestructible | Distance-based conversion immunity (the machinery Shadow Cult guild later reuses, parameterized by range) + no-entry hex | M |
| 11 | Storm Peak | Adjacent Nomad/Ship/Merchant lays down on entry (skips next action until its card is replayed); Mountaineer just stops | Unit status effect ("laid down") | L (built once, reused by #19) |
| 12 | Sunken City | Placed in a deliberately-reserved Sea "hole"; adjacent/on Ship action for a player-chosen reward (5 GP / 1 Wood / 1 Stone); majority-adjacent 20 VP | Board-gen "reserve exactly one hole" constraint + player-choice-of-reward effect shape + majority-control helper | L |
| 13 | Orb of Acceleration | One per player on Sea near Plains; any land unit landing there must move again immediately | Chained/forced follow-up movement resolution | L |
| 14 | Gigantic Cavern | On Mountain; Mountaineer there: free transform to City | Location-gated free action (variant of existing `TransformEffect`) | S–M |
| 15 | The Swamp | 4 no-terrain tiles (0 VP, no Region), placed in place of some Plains + 2 more on Sea; blocks City/Ship, land units pass/stop | **New `Terrain` value** — touches movement, scoring, board-gen `placesOn`, cliff levels | L (widest blast radius of any single Tale) |
| 16 | Monastery of the Psy-Monks | On Glacier; Temples within 3 spaces get range-scaled conversion (1×/2×/3× cost by distance) | Conversion range + per-distance cost scaling — **built here**, generically; Psy-Monks guild card reuses it later | M |
| 17 | Doppelganger's House | Any unit pays 10 GP to draw 3 unused Guild cards, keep 1, return 2 | "Site action," independent of played card + a live undealt-card draw pile | L, **`perPlayer`-guild-mode-only** (decision 3) |
| 18 | Lair of the Thieves' Guild | Majority-adjacent control grants the Thieves'-Guild Nomad steal action | `StealResourceEffect` — **built here**, generically; Thieves' Guild card reuses it later — + majority-control helper | M |
| 19 | The Typhoon | Blocks entry/construction; Fantastic Event lays down all adjacent units, then relocates | Reuses "laid down" (#11) + no-entry hex + a repositionable special tile + scoring's region-split handling | L |
| 20 | The Waterfall | 2 fixed tiles (Forest bottom / Glacier top) by a Mountain; bottom-space unit gets amplified produce; 5 VP per occupied space at game end | Paired-tile setup placement + location-gated produce override + new per-occupied-space VP source | M |
| 21 | Tower of the Alchemists | On Plains; any unit within 1 space can swap Wood↔Stone with the bank | `ResourceSwapEffect` — **built here**, generically, as a site action; Alchemists guild card reuses it later | M |
| 22 | The Caravansary | On Plains; majority-adjacent-or-on control lets Merchant card grant every Merchant 2 actions instead of 1 | Majority-control helper (reuse #18) + a "double activation" flag threaded into per-unit action resolution | M–L |
| 23 | Worshipers of the Volcano God | Double-sided 3-hex tile on Forest; Fantastic Event flips active/erupts; no unit ever enters its hexes; 30 VP (split on ties) to majority-adjacent control at game end; not part of any Region itself | No-entry hex + active/inactive stateful Fantastic Event cycle (reuse Dragon's shape) + majority-control helper | L |

*Shared infra this group needs, in build-once-reuse-often order: no-entry
hex; unit "laid down" status; majority-adjacent-control helper; site-gated
actions (independent of played card); a new `Terrain` value (Swamp — only
this one card needs it, isolated on purpose).*

## 6. Shared infrastructure — build once, unlock many

These primitives each unlock multiple cards/Tales — and, per decision 4,
are built during Tales work first, with the noted Guild cards consuming
them afterward:

1. **Effective per-player `UnitContent`** — `applyGuildModifiers` (section
   4), used purely for the Guild variant; unlocks ~13 of the 24 Guild cards
   on its own once Guilds work starts.
2. **`ResourceSwapEffect`, `StealResourceEffect`** — built generically
   during Tales (Tower of the Alchemists, Lair of the Thieves' Guild);
   reused as-is by Alchemists and Thieves' Guild once Guilds work starts.
3. **`PlayerPaymentEffect`, `DestroyEffect`** — Guild-only (Corsairs,
   Mercenaries — both excluded from Shared mode, decision 5), no Tale
   consumes these, so they're built during the Guilds phase, not Tales.
4. **Conversion range + cost scaling, and target immunity** — built
   generically during Tales (Monastery of the Psy-Monks, the Cathedral,
   Dolmens); reused by Psy-Monks and Shadow Cult once Guilds work starts.
5. **Generalized Trophy claim predicates** (beyond "reached full unit
   supply") — Tales only: Dragon, Capital, Majestic Bridge, Floating
   Cities.
6. **Unit status effect ("laid down")** — Tales only: Storm Peak, Typhoon.
7. **No-entry / no-construction hex** — Tales only: Dolmens, Typhoon,
   Volcano, the Majestic Bridge's own space.
8. **Majority-adjacent-control helper** — Tales only: Lair of the Thieves'
   Guild, the Caravansary, Worshipers of the Volcano God, Sunken City,
   Dolmens.
9. **"Companion piece activated by an existing card"** — Tales only:
   Capital, Ports, Cathedral.
10. **Mid-game terrain mutation** — Tales only: Water Elemental, Floating
    Cities.
11. **Site-gated actions** (any unit, independent of the card played that
    turn) — Tales only: Doppelganger's House, Tower of the Alchemists,
    Gigantic Cavern, Sunken City, the Waterfall.
12. **Transit-vs-landing terrain split in movement** — Guild-only: Winged
    (also clarifies Aquanauts/Machinists' special movement). No Tale needs
    this split, so it's built during the Guilds phase.

## 7. Phased roadmap

### Tales track (built first)

**Phase 0 — Scaffolding.** `tales.json`/`guilds.json` + schemas (ids/
names/descriptions only), `GameState.taleVariant`/`guildVariant`,
`resolveContent.ts` additions. Setup UI for Tale selection (blind draw +
host-pick, decision 7) and a stub for the Guild mode picker (built out for
real once the Guilds track starts). No card/tale effects yet. Tests:
setup/selection only.

**Phase 1 — Tales infra.** Generalized Trophy-claim predicates, Fantastic
Event framework (`tales.ts`), board-setup hook table, "laid down" status,
no-entry hex, majority-control helper, mid-game terrain mutation,
site-gated actions, companion-piece activation, `ResourceSwapEffect`,
`StealResourceEffect`, conversion range/cost-scaling/immunity machinery
(built generically here — see section 6, items 2 and 4).

**Phase 2 — Tale elements**, in this order (each group leans on Phase 1 +
earlier groups' infra):
1. Gigantic Cavern, Tower of the Alchemists, the Waterfall, Monastery of
   the Psy-Monks, Lair of the Thieves' Guild.
2. Storm Peak, the Typhoon, the Dragon, Worshipers of the Volcano God.
3. Water Elemental, Floating Cities, the Sunken City (+ its board-gen
   "reserve a hole" exception), the Leviathan (no Trophy — just the
   creature + Fantastic Event, decision 1).
4. Capital, the Ports, the Cathedral.
5. The Banks, the Majestic Bridge, the Orb of Acceleration, the
   Caravansary, Dolmens.
6. The Swamp (new `Terrain` value — isolated on purpose, touches the most
   files of any single Tale).
7. Doppelganger's House — implement its site-action/draw-pile mechanics
   now, but gate it inert whenever Shared guild mode is later selected
   (decision 3) — the check itself is a placeholder until the Guilds track
   defines `GuildVariantState`.

**Phase 3 — Tales UI & checkpoint.** Board rendering of special tiles/
creatures on `HexBoard`, Fantastic Event narration in the game log, the
Tale-selection setup screen polished end-to-end, full regression suite.
**Tales variant is feature-complete here** — a natural point to ship/
playtest before starting Guilds.

### Guilds track (built second)

**Phase 4 — Guild content-delta infra + the simplest remaining cards.**
`applyGuildModifiers`, `PlayerPaymentEffect`/`DestroyEffect` (the two Guild-
only effect types, section 6 item 3), wiring into `applyAction()`/
`actionTargeting.ts`. Cards: Lumberjacks, Miners, Master Jewelers, Snowmen,
Collectors (cap half), Corsairs, Mercenaries, Machinists, Archivists — plus
Alchemists and Thieves' Guild, which just wire up their card-triggered
version of the resource-swap/steal effects Tales already built.

**Phase 5 — Guild scoring hooks.** `victoryPoints.ts`/`scoring.ts`
extension points. Cards: Capitalists, Collectors (VP half), Druids,
Farmers, Scholars (auto-pick, decision 2), Travelers, Trophy Hunters
(auto-pick, decision 2).

**Phase 6 — Movement engine upgrades.** Transit-vs-landing split (section
6 item 12), cross-player blocking hook, composite/bypass movement
profiles. Cards: Winged, Sentinels, Aquanauts, Northerners (+ its
Glacier-guard exception).

**Phase 7 — Remaining bespoke guild hooks.** Psy-Monks and Shadow Cult wire
up their card-triggered version of the conversion range/immunity machinery
Tales already built. Druids' Temple-in-Forest variant. Doppelgangers'
Recycling-phase trade action (`perPlayer`-only) — this is also where the
Phase 2-item-7 placeholder check (Doppelganger's House inert under Shared
mode) gets its real `GuildVariantState` condition wired in.

**Phase 8 — Guild variant checkpoint.** Confirm the 6 excluded cards
(section 4.1) stay correctly excluded from Shared mode's picker/random
pool, full regression suite, Shared-mode setup UI (host-pick/random)
polished end-to-end.

**Phase 9 — Guild UI.** Per-player Guild-power badges (Classic mode) or a
single global banner (Shared mode).

### Both tracks

**Phase 10 — Docs.** Update `content/README.md`, `PROJECT_PLAN.md`,
`todo.md` per the existing conventions once implementation actually
starts (this plan doc records the *design*; those track *progress*, same
split as today).

## 8. Testing strategy

Mirror the existing `src/engine/__tests__/` structure: one test file per
new engine module (`tales.test.ts`, `guilds.test.ts`, plus additions to
`unitActions.test.ts`/`movement.test.ts`/`victoryPoints.test.ts`/
`scoring.test.ts`/`purchaseCost.test.ts` for the direct hooks). Each
card/Tale gets at least one test proving its effect actually fires under
the right condition and doesn't fire without the guild/tale active — same
bar the base game's 258+ tests already hold. Shared-mode-specific tests
should assert the effect applies to *every* player, not just the "owner"
concept per-player mode has, and should assert the 6 excluded cards are
genuinely unpickable (not just unrecommended) in that mode.
