# TODO

Open items surfaced while implementing the card-play and decline rules in
`src/engine/`. Each one currently blocks a specific piece of the engine from
being finished — the code has a clearly marked placeholder or stub at each
spot below until the real rule is provided.

## 1. Real per-unit-kind unit limits — done

Decline rule 1 says every unit kind has a limit, per player, that triggers
decline once reached. Real values now in `src/content/units.json`'s
`supply.byPlayerCount` (8 Cities, 3 Temples, 8 Nomads, 6 Merchants, 3
Mountaineers, 5 Ships — same across every player count), which turned out
to be exactly the concept this item was asking about.

`getUnitLimit()`/`isDeclineTriggered()` (`src/engine/decline.ts`) now read
`GameState.unitLimits`, set once at game creation via `createNewGame`'s
`unitLimits` param (`src/engine/createGame.ts`) — the caller resolves it
from `units.json`, same pattern as `resourceBank`. Defaults to `{}` (no
limits) if omitted, so existing callers/tests are unaffected. Tested in
`src/engine/__tests__/decline.test.ts`.

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

## 4. Player elimination — done

Rule: if a player has to play a card — choosing one in the select-cards
phase, or giving one up in the decline phase — and has none available
(empty hand for select-cards; empty hand *and* discard for decline),
they're eliminated: removed from the board and turn order for the rest of
the game, excluded from winning, all their gold/wood/stone returned to the
bank. Achievements they've already claimed are NOT revoked.

Implemented in `src/engine/elimination.ts` (`eliminatePlayer`,
`eliminatePlayersWithNoCardToPlay`, `eliminatePlayersWithNoCardToDecline`),
wired into `beginSelectCardsPhase`/`beginDeclinePhase`
(`src/engine/round.ts`) and cascading after each `MOVE_TO_DECLINE`
(`src/engine/applyAction.ts`). `Player.eliminated: boolean` and
`Player.resources`/`GameState.resourceBank` (see `src/content/resources.
json`) added to `src/engine/types.ts`. Tested, including end-to-end via
`applyAction` and the resource-return.

Still relevant: `determineWinners` (`src/engine/victoryPoints.ts`) already
takes an explicit `playerIds` list rather than deriving it from the VP map,
specifically so callers can pass only non-eliminated players once
win-condition checking is wired into `finishRound()` (see #3) —
`state.players.filter(p => !p.eliminated).map(p => p.id)`.

## 5. Multi-card decline

New rule: when the decline phase triggers, a player may need to decline
more than one card — specifically, if more than 1 achievement was claimed
*during that round*. `beginDeclinePhase`/`applyMoveToDecline`
(`src/engine/round.ts`/`applyAction.ts`) currently always process exactly
one card per player.

Blocked on the same gap as #2/#3: nothing tracks achievement claims yet, so
there's no way to count "how many were claimed this round" to know how
many cards each player must decline.
