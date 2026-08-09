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

## 2. Purchase-phase cost formula — done

Round step 4 lets a player buy a card back from decline, at a gold cost
"determined by the number of achievements achieved by players." The
formula was already implemented (`calculatePurchaseCost()` in
`src/engine/purchaseCost.ts`, reading `content/achievements.json`'s
`purchaseCost.byAchievementCount`) — what blocked `PURCHASE_CARD` itself was
that `GameState` didn't track claimed achievements, so "achievements
claimed so far" had nothing to read.

Resolved by adding achievement-claim tracking: `GameState.
claimedByAchievementId: Record<string, string>` (achievement id -> claiming
player id) and `GameState.achievementsClaimedThisRound: number` (see #5)
in `src/engine/types.ts`, populated by `updateAchievementClaims()`
(`src/engine/achievements.ts`) — for each achievement not yet claimed,
checks whether any non-eliminated player now holds their full per-player
supply of the tied unit kind (reuses `UnitContent.unitSupplyCaps`, the same
values already used elsewhere — no new content needed for the cap itself),
and the first to qualify claims it, permanently. Called from
`applyResolveUnitAction` (`src/engine/applyAction.ts`) after every
`RESOLVE_UNIT_ACTION`, since create/convert/a destroySelf transform are the
only things that can change a player's unit count for a kind.

`PURCHASE_CARD` is now `applyPurchaseCard()` in `src/engine/applyAction.ts`:
validates the card is in that player's `decline`, computes the cost from
`Object.keys(state.claimedByAchievementId).length`, spends the gold (bank
gains it back, same as any other cost), and moves the card to `hand`
(re-synced to `supply` instead if the player currently has no unit of that
kind — same rule 5/6 logic every other card move already respects). New
`AchievementContent` bundle (`src/engine/achievementContent.ts`, mirroring
`UnitContent`'s pattern) threads `purchaseCostTable` (and the other
achievement/VP content — see #3) through `applyAction()`'s new optional
`achievementContent` param. Tested in `src/engine/__tests__/round.test.ts`.

## 3. Game-end / win condition — done

Round step 6 checks whether the game has ended. `finishRound()`
(`src/engine/round.ts`) now checks it for real: once
`achievementContent.gameLength` total achievements have been claimed
(`Object.keys(state.claimedByAchievementId).length`, see #2), the round in
progress (which just finished) ends the game — `sumVP()` combines
`calculateAchievementVP`/`calculateBoardCountVP`/`calculateTerrainControlVP`
and `determineWinners()` picks whoever has the most total VP among
non-eliminated players (no tiebreaker — a tie is a shared win), setting
`status: 'completed'` and `winnerPlayerIds`. `finishRound()` takes a new
optional `achievementContent: AchievementContent` param (default
`EMPTY_ACHIEVEMENT_CONTENT`, `gameLength: Infinity`, so a caller that
doesn't supply it keeps the old always-continue behavior).

`AchievementContent` (`src/engine/achievementContent.ts`) bundles
everything the win check needs: `gameLength`, `achievementVictoryPoints`,
plus `unitBoardCountVP`/`terrainVictoryPoints`/`terrainScoresAs` for the
other two VP sources — resolved by the caller from `content/achievements.
json`/`units.json`/`terrain.json`, same content-agnostic convention as
`UnitContent`.

Still a real caveat, not blocking but worth flagging: `calculateBoardCountVP`
and `calculateTerrainControlVP` will only ever score their placeholder/empty
inputs meaningfully once the real per-unit/per-terrain VP numbers are filled
in and real board generation exists (`PROJECT_PLAN.md` section 2/3) — the
win-condition *logic* is complete and tested, but until then a finished game
is decided almost entirely by achievement VP. Tested end-to-end in
`src/engine/__tests__/round.test.ts` (game ends at the target, doesn't end
below it, ties/VP summing) and via `src/engine/__tests__/achievements.test.ts`
for the claim-detection piece.

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

`determineWinners`'s explicit `playerIds` param (`src/engine/victoryPoints.ts`)
— taken rather than deriving player ids from the VP map — is exactly what
let `finishRound()` (see #3) pass only non-eliminated players:
`state.players.filter(p => !p.eliminated).map(p => p.id)`.

## 5. Multi-card decline — done

Rule: when the decline phase triggers, a player may need to decline more
than one card — specifically, if more than 1 achievement was claimed
*during that round*. This was blocked on the same gap as #2/#3 (nothing
tracked achievement claims), now resolved by `GameState.
achievementsClaimedThisRound: number` — incremented by
`updateAchievementClaims()` (see #2) every time an achievement is newly
claimed, and reset to 0 at the start of every round
(`beginSelectCardsPhase`, `src/engine/round.ts`).

`beginDeclinePhase` now computes `cardsPerPlayer = Math.max(1,
achievementsClaimedThisRound)` — every pending player owes that many cards
this phase, not just whoever claimed the achievement(s).

Per ruling, decline is **simultaneous**, like select-cards — not turn
order, contrary to what the round-3 doc comments originally assumed.
`beginDeclinePhase` now sets `activePlayerId: null` throughout the phase
(same as select-cards), and `applyMoveToDecline`
(`src/engine/applyAction.ts`) checks `pendingPlayerIds.includes(playerId)`
rather than `pendingPlayerIds[0] === playerId` — any pending player may
move a card into decline at any time, in any order relative to the others.
A player who owes more than one card still appears more than once in
`pendingPlayerIds` (repeating their id that many times), but each
`MOVE_TO_DECLINE` now removes just the one occurrence being fulfilled
(`removeOneOccurrence()`), not necessarily the front of the queue —
they remain pending, and may act again whenever they choose, until every
occurrence is gone. `eliminatePlayersWithNoCardToDecline`
(`src/engine/elimination.ts`) was rewritten to match: instead of cascading
through `activePlayerId` one at a time, it checks every currently-pending
player independently (same pattern as `eliminatePlayersWithNoCardToPlay`
for select-cards) — still re-run after each `MOVE_TO_DECLINE`, so a player
who runs out of cards partway through their required count is caught and
eliminated. Tested end-to-end in `src/engine/__tests__/round.test.ts` and
`src/engine/__tests__/elimination.test.ts`.

## 6. Movement timing/frequency — done

Resolved: movement is a normal action, with no exceptions. Every mobile
unit kind's card has a `move` action in its `actions` list, chosen and
resolved through `RESOLVE_UNIT_ACTION` exactly like create/transform/
income/etc. — same per-unit `targets` shape, same "applies independently to
every acting unit" semantics. Only units of the kind matching the card
played can move that turn (a Ship card activation can't move a Nomad).

Implemented as a `move` action entry on every mobile unit kind in
`units.json` (`MoveEffect` in `src/engine/unitContent.ts`), handled by
`applyMove()` — just another case in `applyUnitActionEffect()`'s per-unit
switch in `src/engine/unitActions.ts`, no special-casing needed. Each
acting unit moves to its own target hex (`targets[unit.id]`); a unit with
no target, or an illegal one (per `legalMoveDestinations()`,
`src/engine/movement.ts` — a BFS respecting terrain restrictions,
cliff-crossing, and the pass-through (`blockedByUnits`) vs. land-on
(`canEndMoveOnUnitTypes`) distinction, plus Ship's "infinite range, but
can't leave its water region" rule via `moveDistance: "unlimited"` bounded
implicitly by `terrains: ["water"]`), simply does nothing that turn — the
rest still act. There is no standalone `MOVE_UNIT` action type — see
`UnitActions.md`'s resolved questions #5.
