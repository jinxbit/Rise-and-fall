# Kogge — implementation plan and rules reference

A second, separate game hosted in this app: **Kogge**, a medieval sea-trade
game for 2–4 players. This document restates the rules in our own words (it
is paraphrased from an unofficial player summary — do not paste third-party
rulebook text here, per `CLAUDE.md`), records every interpretation we had to
make where the summary is ambiguous, and maps each rule to the code that
implements it.

## Scope of the first version

| Built | Not built (yet) |
| --- | --- |
| Pure rules engine, `src/kogge/engine.ts` — deterministic, seeded, event-sourced (`actionHistory` + `replayKogge`) | Online play through Supabase (lobby, Edge Function enforcement, realtime) |
| Hotseat play on one device at `/kogge`, saved to `localStorage`, with undo | Variants (Taxes, Trading with houses, Conflicts, Memory) |
| Engine tests, `src/kogge/__tests__/engine.test.ts` | Enforcing "future promises" made during player trades (players honor them socially) |

The module does **not** share code or types with the Rise & Fall engine
(`src/engine/`) and imports nothing from `src/lib/`, so it never triggers a
Supabase deploy. It follows the same principles, though: all rules live in
`applyKoggeAction()`, randomness comes only from a seed stored in the state,
and the current state is always the genesis replayed through the action log.

## Components

- **Board**: nine trading cities in a ring, numbered 0–8. Each city has a
  goods colour, two route-marker slots, room for two houses, and a pile of
  goods. Layout (`KOGGE_BOARD` in `src/kogge/board.ts`):
  - grey: 0, 1, 2 · orange: 3, 4 · purple: 5, 6 · white: 7, 8
  - clockwise ring order: 0 → 5 → 1 → 7 → 3 → 8 → 2 → 6 → 4 → (0)
  - A route marker's *colour* is the colour of the city carrying its number
    (so a "grey marker" is a 0, 1 or 2).
- **Route markers** (the reserve): value *v* has `14 − v` copies
  (fourteen 0s … six 8s; 90 total).
- **Goods supply**: 25 grey, 18 orange, 13 purple, 10 white.
- **Per player**: a boat, houses, two raid markers (one in hand at the
  start, the second must be earned).
- **Guildmaster** figure and game-end marker.
- **Bonus markers**: 8 — two each of *Triple trade*, *Extra marker*,
  *Free second move* and *Secret passage*.

## Setup

1. Each city receives 3 goods of its own colour from the supply.
2. Each player receives 1 raid marker, 2 grey goods, 1 orange good, and one
   route marker of every value 0–8 (taken from the reserve).
3. A random marker is drawn from the reserve; the Guildmaster and the
   game-end marker start in the city with that number.
4. Two shuffled sets of markers 0–8 (from the reserve) fill each city's two
   slots, face up, such that a city never shows its own number and its two
   markers differ.
5. The marker drawn in step 3 goes back to the reserve.
6. **Starting city**: every player secretly picks a value from their hand,
   then all reveal. Each places a house and their boat in that city. If three
   or more players picked the same city, those players pick again. (The
   picked marker stays in hand.)
7. **Initial turn order**: ascending by starting-city number; players sharing
   a city are ordered randomly.

## Goal

- **Development points (DP)**: 1 per house on the board (including the
  starting house) + 1 per bonus marker. The first player to reach **5 DP wins
  immediately**. A player can build a fifth house even though there is no
  piece for it — that house always ends the game.
- Otherwise the game ends when the Guildmaster reaches its starting city for
  the **second** time, and the highest **victory point (VP)** total wins. Ties
  are shared (no tiebreak).
- **VP**: house 10 · unused raid marker in hand 10 · bonus marker 20 ·
  goods held (in hand *and* beside your houses): white 7, purple 5,
  orange 3, grey 1.

## Round structure

### 1. Market and turn-order auction

1. Players holding *Extra marker* draw one random marker from the reserve
   per bonus (in turn order).
2. Unsold lots from the last round return to the reserve; four new lots of
   two random markers are drawn (always four, whatever the player count).
3. In the current turn order, each player bids once by revealing one or more
   markers from hand. Ranking:
   - A bid made only of identical markers ("a set") beats any mixed bid.
   - Between sets: more markers wins; with equal size, the higher value wins.
   - Between mixed bids: higher sum wins.
   - A bid may not exactly repeat an earlier bid this round.
   - A player **must** bid if any legal bid exists; otherwise they pass and
     rank below every bidder.
4. The best bid takes turn-order position 1, and so on down.
5. **City resupply**: for every marker bid, the city with that number gets 2
   goods of its colour. Cities are served from highest number to lowest, so a
   short supply runs out on the low cities. If a city with houses gained at
   least as many goods as it has houses, one of those new goods is moved next
   to each house (it now belongs to that house's owner); if it gained fewer,
   none are. All bid markers return to the reserve.

### 2. Guildmaster

The start player moves the Guildmaster 1 or 2 cities clockwise. Cities
carrying any raid marker are skipped (they don't count as a step). The city
it stops in receives 2 goods of its colour.

### 3. Actions

In turn order, each player first **sails**, then takes **actions** in the
city where the boat stopped.

**Sailing**

- The first move is free: sail to the city numbered by either marker in your
  current city.
- Each further move costs one good or one route marker from hand
  (*Free second move*: the second move is also free).
- A face-down marker may be chosen blind; it flips face-up and stays so. If
  its destination is illegal (a city with your own raid marker), the move
  is spent without sailing — for the first move that means the free move is
  lost; for a later move the payment is still spent.
- *Secret passage*: sail directly to the Guildmaster's city, paying one extra
  good/marker on top of the normal cost of that move.
- You may never sail to a city carrying your own raid marker.
- Every city the boat is in during sailing (start and each stop) pays out the
  goods waiting beside your houses there.
- Sailing stops for the turn once you take any city action.

**Actions** — each at most once per turn, in any order:

1. **Build a house**: pay one good of each colour *other* than the city's,
   plus one marker of the city's number (two if the city already has a house).
   Max two houses per city.
2. **Trade with the Guildmaster** (only in its city) — one of:
   - return three identical markers to gain your second raid marker (once
     per game);
   - pay six goods of one colour for an available bonus marker;
   - pay one good for a reserve marker of that colour;
   - return one marker for a supply good of its colour.
3. **Buy a lot**: pay one good (any colour) to take one two-marker lot.
4. **Trade with the city** (only if you sailed this turn): place one good in
   the city and take two goods of other colours from it (*Triple trade*:
   take three).
5. **Change a route**: swap one face-up marker in the city for a marker from
   hand whose number isn't the city's. The new marker goes face down.
6. **Raid** (ends your turn): place a raid marker from hand in the city and
   either
   - take half the goods of another boat in the city — its owner splits their
     goods into two piles differing by at most one good, you choose a pile; or
   - take every good in the city, including goods beside houses there.

   Then your boat makes one free forced move; the player to your left picks
   which of the city's two markers it follows (a face-down one flips). If the
   destination carries your raid marker, the boat stays put. Your turn ends.
   You can never sail into a city with your raid marker again.
7. **Trade with players** (not limited, doesn't stop sailing): with any
   player whose boat shares your city, swap any goods and markers you both
   agree to.

## Interpretations we had to choose

| Question | Decision |
| --- | --- |
| City colours and ring order | Fixed layout above; grey is the common colour, matching both goods and marker counts. |
| Do hand markers / city markers come from the reserve? | Yes. |
| Is the start-city marker spent? | No, it stays in hand. |
| Bid ties (e.g. {3,4} vs {2,5}) | Earlier bidder ranks higher. Passing players rank after all bidders, in previous turn order. |
| Resupply when a city gains goods for houses | Aggregated per city per round, not per marker. |
| When does the Guildmaster game end apply? | The round in which the Guildmaster reaches its start for the second time is played to the end of its action phase, then VP are scored. Passing over the start city (including skipping it because it is raided) counts as reaching it. |
| "Different goods" in city trade | Taken goods must not be the colour of the good given. |
| Same bonus type twice | Allowed if still in stock (DP/VP count; the effect doesn't stack). |
| Raid on a boat with no goods | Allowed; nothing is taken. |
| Illegal face-down reveal on a paid move | Payment is still spent (mirrors losing the free move). |
| "Player to the left" | Next player in seating order (the order players were entered). |
| Player trades — when? | During the active player's action turn, between the active player and a player whose boat shares the city. |

## Code map

| File | Role |
| --- | --- |
| `src/kogge/types.ts` | `KoggeState`, `KoggeAction`, colours, bonuses |
| `src/kogge/board.ts` | Board layout, supply/reserve counts, VP values |
| `src/kogge/rng.ts` | Seeded PRNG (state stored on `KoggeState.rng`) |
| `src/kogge/bids.ts` | Bid comparison and legality |
| `src/kogge/engine.ts` | `createKoggeGame`, `applyKoggeAction`, `replayKogge`, scoring |
| `src/pages/KoggePage.tsx` | Hotseat UI at `/kogge` |

## Possible next steps

- Online play: store `{ setup, actionHistory }` in a `games` row with a
  `game_kind` discriminator and run `applyKoggeAction` in an Edge Function.
- The four variants.
- Hidden hands for pass-and-play (currently everything but the start pick and
  face-down markers is open information, as in the physical game).
