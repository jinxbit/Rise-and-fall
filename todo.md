# TODO

Open items surfaced while implementing the card-play and decline rules in
`src/engine/`. Each one currently blocks a specific piece of the engine from
being finished — the code has a clearly marked placeholder or stub at each
spot below until the real rule is provided.

## 1. Real per-unit-kind unit limits

Decline rule 1 says every unit kind has a limit, per player, that triggers
decline once reached. The engine currently uses a flat placeholder of `2`
for every unit kind (`PLACEHOLDER_UNIT_LIMIT` / `getUnitLimit()` in
`src/engine/decline.ts`).

Needs: the real limit per unit kind (and possibly per player count — see
`supply.byPlayerCount` in `src/content/units.json`, which has the same `0`
placeholder shape for what looks like the same concept).

## 2. Purchase-phase cost formula

Round step 4 lets a player buy a card back from decline, at a gold cost
"determined by the number of achievements achieved by players." `PURCHASE_CARD`
(`src/engine/applyAction.ts`) is stubbed as `NOT_IMPLEMENTED` pending this.

Needs: the achievement list and the cost formula that derives gold cost from
achievements.

## 3. Game-end / win condition

Round step 6 checks whether the game has ended. `finishRound()`
(`src/engine/round.ts`) currently always continues to the next round — the
win-condition check is a marked no-op (`GameState.winnerPlayerId` stays
`null` forever).

Needs: the actual win/end condition.
