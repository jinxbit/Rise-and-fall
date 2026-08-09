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

~~Needs: the achievement list~~ (now in `src/content/achievements.json`) and
~~the cost formula~~ (now `src/content/achievements.json`'s
`purchaseCost.byAchievementCount`, implemented as `calculatePurchaseCost()`
in `src/engine/purchaseCost.ts`, tested).

Still blocks `PURCHASE_CARD` itself: the formula needs "achievements
claimed so far," and `GameState` doesn't track claimed achievements at all
yet (see #4 below) — nothing detects or records when a player reaches full
supply of a unit type. Needs: an achievement-claim tracking field on
`GameState` and the detection logic that populates it (hook into wherever
units are created/destroyed).

## 3. Game-end / win condition

Round step 6 checks whether the game has ended. `finishRound()`
(`src/engine/round.ts`) currently always continues to the next round — the
win-condition check is a marked no-op (`GameState.winnerPlayerIds` stays
`[]` forever).

The rule is now fully known: the end *trigger* is
`src/content/achievements.json`'s `gameLength` (default 4) — total
achievements claimed across all players; once that many have been claimed,
the round in progress finishes fully and then the game ends. The winner is
whoever has the most **total** VP (achievement + board-count +
terrain-control, summed), **with no tiebreaker** — a tie is a shared win.
All of this is implemented as pure, synthetic-data-tested functions
(`calculateAchievementVP`/`calculateBoardCountVP`/`sumVP`/
`determineWinners` in `src/engine/victoryPoints.ts`,
`calculateTerrainControlVP` in `src/engine/scoring.ts`) — `GameState.
winnerPlayerIds: string[]` (renamed from the old singular
`winnerPlayerId` to allow ties) is ready to receive the result.

Still blocks wiring into `finishRound()`: same achievement-tracking gap as
#2, plus `calculateTerrainControlVP` needs a real generated board (still
unbuilt, see `PROJECT_PLAN.md` section 2) and the real VP numbers
(`units.json`/`terrain.json`/`achievements.json` are still placeholder
values).

## 4. Player elimination

New rule: if a player has to play a card — either choosing one in the
select-cards phase, or moving one to decline in the decline phase — and
they don't have one available (empty hand for select-cards; empty hand
*and* discard for decline), they're eliminated. `applyChooseCard` and
`applyMoveToDecline` (`src/engine/applyAction.ts`) don't handle this case
yet — an affected player would just be stuck unable to submit any valid
action.

Needs answers before implementing (getting `Player`/turn-order/scoring
handling wrong here means reworking round flow, not just adding a field):
- Does an eliminated player's board presence change (units/cards removed?
  left as-is?), and are they skipped in `turnOrder`/`pendingPlayerIds` for
  the rest of the game?
- Does an eliminated player still count toward final VP/`determineWinners`
  (their VP total as of elimination), or are they excluded from winning
  entirely?

## 5. Multi-card decline

New rule: when the decline phase triggers, a player may need to decline
more than one card — specifically, if more than 1 achievement was claimed
*during that round*. `beginDeclinePhase`/`applyMoveToDecline`
(`src/engine/round.ts`/`applyAction.ts`) currently always process exactly
one card per player.

Blocked on the same gap as #2/#3: nothing tracks achievement claims yet, so
there's no way to count "how many were claimed this round" to know how
many cards each player must decline.
