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

**Cliff rule (applies to all targeted actions):** create, an
`'adj'`-location transform, and convert can never cross a cliff edge —
absolute, regardless of the acting unit's own `canCrossCliffs` capability
(that capability is for movement, not these actions).

Status legend: ✅ implemented & tested

## City

| # | Action | Status |
|---|--------|--------|
| 1 | Create Nomad | ✅ |
| 2 | Create Merchant | ✅ |
| 3 | Create Mountaineer | ✅ |
| 4 | Generate Income | ✅ |

## Temple

| # | Action | Status |
|---|--------|--------|
| 5 | Convert Enemy Unit | ✅ |
| 6 | Generate Income | ✅ |

## Nomad

| # | Action | Status |
|---|--------|--------|
| 7 | Produce Resource | ✅ |
| 8 | Transform to Ship | ✅ |
| 9 | Transform to City | ✅ |
| 10 | Transform to Temple | ✅ |

## Merchant

| # | Action | Status | Notes |
|---|--------|--------|-------|
| 11 | Buy/Sell Resource | ✅ | not a real trade — flat 5 gold income, no target |
| 12 | Generate Income | ✅ | |
| 13 | Transform to Ship | ✅ | |

## Mountaineer

| # | Action | Status |
|---|--------|--------|
| 14 | Produce Resource | ✅ |
| 15 | Transform to City | ✅ |

## Ship

| # | Action | Status | Notes |
|---|--------|--------|-------|
| 16 | Transform to Nomad | ✅ | |
| 17 | Transform to City | ✅ | |
| 18 | Transform to Merchant | ✅ | |
| 19 | Trade | ✅ | flat rate per adjacent City, any owner (no own/enemy split) |

**19/19 implemented and tested** — 129 tests across `unitActions.test.ts`
(synthetic fixtures) and `unitActions.realContent.test.ts` (against the
real `units.json`/`terrain.json`/`resources.json`).

## Resolved questions

All four open questions from the first implementation pass are resolved:

1. **Ship's "Trade"** — no own/enemy split. Flat `goldPerCity` per adjacent
   City regardless of owner.
2. **Merchant's "Buy/Sell Resource"** — not a real trade. The action now
   just generates flat gold income (`effect: { actionType: 'trade-resource',
   gold: 5 }` in `units.json`), no resource involved, no target needed.
3. **Cliff-crossing on transform/convert** — same absolute rule as create:
   never allowed, regardless of the acting unit's movement capability.
   `create`'s now-redundant `targetHex.crossCliff` field was removed from
   `units.json`/`unitContent.ts` — cliff-blocking is unconditional for
   every targeted action (create, `'adj'`-transform, convert).
4. **Create + supply cap** — confirmed: create always respects the target
   kind's supply cap (`units.json`'s `supply.byPlayerCount`); a City can't
   create a Nomad if the player already holds their full Nomad supply.
