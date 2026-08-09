# Unit actions — implementation checklist

Tracks implementation of every action in `src/content/units.json` against
`src/engine/unitActions.ts`. Per the units ruleset: playing a card lets the
player choose **one** of that unit kind's actions, and it applies
**simultaneously to every unit of that kind the player controls** — not a
single unit. Where an action needs a target hex, the player supplies one
target per unit of that kind (a unit with no legal target simply does
nothing for that action; others still act, each paying/gaining
independently).

Architecture: `applyAction(state, action, unitContent)` — `unitContent`
(`src/engine/unitContent.ts`) is resolved by the caller from
`units.json`/`terrain.json`/`resources.json` (the engine itself never
imports JSON — same convention as `UNIT_KINDS` in `cards.ts`). The
dispatcher is `applyUnitActionEffect()` in `src/engine/unitActions.ts`.
Tested both with synthetic fixtures (`unitActions.test.ts`) and against the
real JSON content (`unitActions.realContent.test.ts`).

Status legend: ⬜ not started · ✅ implemented & tested · ❓ implemented, but resting on an assumption noted below (see Open questions)

## City

| # | Action | Status | Notes |
|---|--------|--------|-------|
| 1 | Create Nomad | ✅ | targeted (adjacent hex per City) |
| 2 | Create Merchant | ✅ | targeted (adjacent hex per City) |
| 3 | Create Mountaineer | ✅ | targeted (adjacent hex per City) |
| 4 | Generate Income | ✅ | no target — gold by terrain the City occupies |

## Temple

| # | Action | Status | Notes |
|---|--------|--------|-------|
| 5 | Convert Enemy Unit | ❓ | targeted; cliff-crossing rule assumed (Q3) |
| 6 | Generate Income | ✅ | no target — gold per adjacent non-Temple unit owned |

## Nomad

| # | Action | Status | Notes |
|---|--------|--------|-------|
| 7 | Produce Resource | ✅ | no target — resource by terrain occupied |
| 8 | Transform to Ship | ❓ | targeted; cliff-crossing rule assumed (Q3) |
| 9 | Transform to City | ✅ | self hex (no target choice, only a legality check) |
| 10 | Transform to Temple | ✅ | self hex (no target choice, only a legality check) |

## Merchant

| # | Action | Status | Notes |
|---|--------|--------|-------|
| 11 | Buy/Sell Resource | ❓ | per-unit resource+mode choice assumed (Q2) |
| 12 | Generate Income | ✅ | no target — gold per adjacent City (own/enemy differ) |
| 13 | Transform to Ship | ❓ | targeted; cliff-crossing rule assumed (Q3) |

## Mountaineer

| # | Action | Status | Notes |
|---|--------|--------|-------|
| 14 | Produce Resource | ✅ | no target — resource by terrain occupied |
| 15 | Transform to City | ✅ | self hex (no target choice, only a legality check) |

## Ship

| # | Action | Status | Notes |
|---|--------|--------|-------|
| 16 | Transform to Nomad | ✅ | targeted (adjacent plain hex per Ship) |
| 17 | Transform to City | ✅ | targeted (adjacent plain hex per Ship) |
| 18 | Transform to Merchant | ✅ | targeted (adjacent plain hex per Ship) |
| 19 | Trade | ❓ | own/enemy City split assumed absent (Q1) |

19/19 implemented and tested (31 synthetic tests in `unitActions.test.ts` +
4 tests against real content in `unitActions.realContent.test.ts`); 4 rest
on a documented, clearly-flagged assumption pending your confirmation.

## Open questions

Nothing here blocked implementation — each got a reasonable, documented
assumption (see the `OPEN QUESTION` comments next to each handler in
`src/engine/unitActions.ts`) so work could continue. Resolve whenever
convenient; code + this file will update to match your answers.

**Q1 — Ship's "Trade" own/enemy split.** Merchant's "Generate Income"
explicitly charges different rates for adjacent own vs. enemy Cities (3 vs
5 gold). Ship's "Trade" effect (`goldPerCity: 5`) has no such split in
`units.json`. Implemented literally as written: 5 gold per adjacent City,
*any* owner. Was this meant to mirror Merchant's own/enemy split and just
wasn't filled in yet, or is Ship's trade intentionally owner-agnostic?

**Q2 — Merchant's "Buy/Sell Resource" per-unit choice.** The rule doesn't
say how each acting Merchant decides what to trade. Implemented as an
independent choice per Merchant (via the new `targets[unitId].resource`/
`.mode` fields on `RESOLVE_UNIT_ACTION` — see `UnitActionTarget` in
`src/engine/actions.ts`): each Merchant may buy or sell 1 resource for 5
gold, chosen individually. Is that the intended shape, or should all of a
player's Merchants make the *same* choice for one card play, or is only
one Merchant meant to trade per play regardless of how many you have?

**Q3 — Cliff-crossing on "transform" (adjacent) and "convert".** "Create"
actions have an explicit `targetHex.crossCliff` override in the JSON;
"transform" and "convert" don't. Implemented using the acting unit's own
`movement.canCrossCliffs` capability as the rule for those two (a unit that
can normally cross cliffs may target across one; a unit that can't, can't).
Is that the intended default, or should transform/convert simply never
cross cliffs (matching "create"'s common default of `false`) regardless of
the acting unit's own capability?

**Q4 — Does "Create" respect the unit's supply cap?** Implemented so a
City can't create a Nomad if the player already holds their full
per-player supply of Nomads (`units.json`'s `supply.byPlayerCount` —
`unitSupplyCaps` in `UnitContent`) — the action just does nothing for that
City instead of exceeding the physical piece limit. This wasn't stated
explicitly for "create" specifically, but seemed the only sane reading of
what a supply cap means. Confirming this is correct rather than, say, the
decline mechanic being the *only* enforcement of that limit.
