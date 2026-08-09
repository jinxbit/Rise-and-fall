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

Split "Buy/Sell Resource" into 4 concrete actions (Buy/Sell × Wood/Stone),
matching how City already splits "Create" per unit type rather than one
generic action with a parameter — each of the 4 applies uniformly to every
Merchant the player owns (`resource`/`mode` are fixed on the action, not a
per-unit choice), a straightforward 1-for-5 conversion each way.

| # | Action | Status |
|---|--------|--------|
| 11 | Buy Wood | ✅ |
| 12 | Sell Wood | ✅ |
| 13 | Buy Stone | ✅ |
| 14 | Sell Stone | ✅ |
| 15 | Generate Income | ✅ |
| 16 | Transform to Ship | ✅ |

## Mountaineer

| # | Action | Status |
|---|--------|--------|
| 17 | Produce Resource | ✅ |
| 18 | Transform to City | ✅ |

## Ship

| # | Action | Status | Notes |
|---|--------|--------|-------|
| 19 | Transform to Nomad | ✅ | |
| 20 | Transform to City | ✅ | |
| 21 | Transform to Merchant | ✅ | |
| 22 | Trade | ✅ | flat rate per adjacent City, any owner (no own/enemy split) |

**22/22 implemented and tested** — 131 tests across `unitActions.test.ts`
(synthetic fixtures) and `unitActions.realContent.test.ts` (against the
real `units.json`/`terrain.json`/`resources.json`).

## Resolved questions

All four open questions from the first implementation pass are resolved:

1. **Ship's "Trade"** — no own/enemy split. Flat `goldPerCity` per adjacent
   City regardless of owner.
2. **Merchant's "Buy/Sell Resource"** — it IS a real trade after all: a
   straight 1-resource-for-5-gold conversion, either direction, player's
   choice — but the choice is made by picking *which action* to play
   (Buy Wood / Sell Wood / Buy Stone / Sell Stone are 4 separate actions,
   see above), not a per-unit input at resolve time.
3. **Cliff-crossing on transform/convert** — same absolute rule as create:
   never allowed, regardless of the acting unit's movement capability.
   `create`'s now-redundant `targetHex.crossCliff` field was removed from
   `units.json`/`unitContent.ts` — cliff-blocking is unconditional for
   every targeted action (create, `'adj'`-transform, convert).
4. **Create + supply cap** — confirmed: create always respects the target
   kind's supply cap (`units.json`'s `supply.byPlayerCount`); a City can't
   create a Nomad if the player already holds their full Nomad supply.
