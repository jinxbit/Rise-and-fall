# Rise & Fall — Zeitgeist Game Mode: Implementation Plan

Companion to `VARIANTS_PLAN.md` (whose Guild deck this mode reuses),
`RULE_ENFORCEMENT_PLAN.md` (both write paths) and
`HIDDEN_INFORMATION_PLAN.md` (deck secrecy). Scopes an original,
project-specific game mode — **Zeitgeist** — in which one Guild card's rule
change is in effect for the whole table at once, and control of *which*
card that is passes between players through a gold auction held after each
Decline.

Not yet built. Nothing in this document has shipped; this is the agreed
design, written before the first slice so the *why* survives the same way
`todo.md` records it for everything already built.

## 0. The mode, in the requester's words

1. There is a collection of Guild cards. Each card changes the rules in a
   unique way (e.g. Nomads move 2 spaces instead of 1).
2. Before the map is built (or after it is revealed), 2 cards are drawn and
   revealed. The first is the **current** card — its rule change is in
   effect now. The second is the **next** card — its rule change is not.
3. When a Decline occurs, a new phase is added after the Purchase phase:
   the **Zeitgeist phase**.
   1. Players bid with their gold and their **auction reserve** (see 4) in a
      normal auction. The first player to have caused the Decline is the
      starting bidder.
   2. Losers pay nothing. The winner pays the gold to the bank and chooses:
      keep the current card as is; **or** replace the current card with the
      next card (the next card is then discarded); **or** draw a card from
      the deck and make it the current card, draw another and make it the
      next card, discarding the old current and next cards.
4. The City's Income action changes: the income gold is added to both the
   player's gold (as normal) *and* to the auction reserve used in a future
   Zeitgeist phase.
5. There is no Zeitgeist phase in the last Decline phase of the game. All
   auction reserves are emptied after the last *potential* Zeitgeist phase
   (i.e. one before the last, where such a phase exists — several Declines
   can fall together); if there is no such phase, after the final Purchase
   phase.

## 1. Why this fits the existing engine — and the one place it doesn't

Everything the engine models as a variant today is **immutable for the life
of a game**. `GameState.activeTaleIds` is fixed at genesis, which is
precisely why every caller may resolve content *once* and hand the engine a
frozen bundle: `GamePage.tsx` memoizes it on `activeTaleIds`,
`resolveGameContent()` (`supabase/functions/_shared/gameEnforcement.ts`)
rebuilds the same bundle per action from the same immutable fields, and
`replayActions()` (`src/engine/replay.ts`) takes one bundle for a whole
replay.

Zeitgeist is the first mechanic where **the rules change mid-game**. That is
the entire architectural risk of this mode, and the whole design below exists
to contain it in one line of code.

The containment: keep what the caller resolves immutable — the **whole deck**
— and let the engine select the active card out of it from state:

```ts
// src/engine/applyAction.ts, runActionAndForcedFollowUps
const effective = applyZeitgeistModifiers(unitContent, zeitgeistContent, state.zeitgeist?.currentCardId ?? null)
const primary = dispatchAction(resyncUnitMovementFromContent(state, effective), action, effective, …)
```

Three properties fall out of putting it exactly there:

- **Invariant 2 holds.** The engine still never imports content JSON; it
  receives `ZeitgeistContent` as an explicit param defaulting to
  `EMPTY_ZEITGEIST_CONTENT`, exactly like `TaleContent`.
- **Invariant 3 holds.** Effective content is a pure function of
  (immutable deck, state at that step), so replay re-derives it identically
  at every step. Nothing about a rule change needs to be logged beyond the
  action that caused it.
- **Units already on the board follow the new rules.** `Unit.movement` is a
  copy stamped at creation time, which is why
  `resyncUnitMovementFromContent` exists at that same call site. Feeding it
  the *effective* content means "Nomads move 2" reaches the Nomads that are
  already standing on the map — and un-reaches them when the card rotates
  away — with no new machinery.

It must go inside `runActionAndForcedFollowUps` rather than at the
`applyAction` entry point, so the forced-follow-up convergence loop
re-derives it too (CLAUDE.md invariant 4).

## 2. Decisions log

Recorded here so the reasoning survives, same spirit as `VARIANTS_PLAN.md`
§1. Items marked **OPEN** need the maintainer's ruling before the slice that
depends on them starts; each carries the default that will be implemented
if no other ruling arrives.

1. **The Zeitgeist deck is the Guild deck, not a third content type.**
   `VARIANTS_PLAN.md` §4 already scopes `guilds.json`/`guilds.schema.json`,
   24 cards, and a per-card `eligibleInSharedMode` flag for a "one card
   applies to everyone" house mode. Zeitgeist is that mode with the shared
   card changing hands. It adds a second per-card flag,
   `eligibleInZeitgeist`, and reuses the same content file. Building a
   parallel deck would fork the catalog.
2. **Only content-delta cards are eligible, for v1.** `VARIANTS_PLAN.md`
   §4.2 classifies each Guild card as **CD** (content delta), **Hook**, or
   **New**. Only CD cards are safe to swap mid-game:
   - A delta like `movementOverridesByKind: { nomad: { moveDistance: 2 } }`
     is stateless and reversible — turning it off is as clean as turning it
     on, and `applyTaleModifiers` (`src/engine/tales.ts`) already implements
     exactly this merge shape.
   - A Hook card that scores at game end (Capitalists, "+25 VP if strongest
     economy") or prices a past transaction (Archivists, "decline purchase
     at half price") raises a per-card retroactivity question — was the card
     active when it mattered? — that has no single generic answer.
   - A card that *widens* a limit (Collectors, resource cap 10) leaves
     illegal state behind the moment it rotates away: a player holding 8
     Wood under a restored cap of 5. Any such card needs an explicit
     clamp-or-keep ruling before it can be in this deck.
   So `ZeitgeistCardDelta` is the reversible subset of the Tale merge:
   `movementOverridesByKind`, `extraActionsByKind`,
   `activationsPerTurnByKind`. The consequence is worth stating plainly:
   **the rules-change half of this mode needs no new engine capability at
   all.**
3. **The auction is sequential, not sealed/simultaneous.** Rule 3.1's
   "starting bidder" implies a rotation, and sequential costs nothing in
   plumbing: a sequential phase sets `activePlayerId`, which the
   `game_state_sync_meta` trigger already projects and both notification
   Edge Functions already key off. A *simultaneous* phase would need a new
   migration, since `0030_purchase_phase_simultaneous.sql` enumerates the
   simultaneous phases by name — and a migration means a human read and no
   auto-merge (`DELIVERY_PIPELINE_PLAN.md` §7). Sequential keeps this entire
   mode migration-free.
4. **The deck is shuffled once, before genesis, and persisted.** Real
   randomness cannot live inside `buildGenesisState`, which must stay a
   deterministic function of the game row (see its doc comment). The deck
   order follows the precedent `resolveSoloBuildMap` /
   `resolveMapPoolRandomAtStart` set: `LobbyPage.tsx`'s `handleStart()`
   shuffles once, persists the order into
   `games.settings.zeitgeistDeckOrder`, and genesis deals the first two off
   it. A welcome side effect: undo/redo across a `redraw` replays to the
   same two cards, so rewinding an auction can never be used to re-roll it.
5. **No reshuffle when the deck runs out.** A mid-game reshuffle needs
   randomness the engine cannot have (invariant 3). When the deck empties,
   the discard pile returns to the bottom of the deck **in discard order**.
   With 24 cards and at most a handful of Declines per game this is nearly
   unreachable, but it must be defined rather than left to crash.
6. **The mode requires `ruleEnforcementEnabled`.** The undrawn deck order
   lives in `GameState`; without the server-side read path there is nothing
   to redact it from. Since issue #552 every game created through the UI is
   enforced anyway, so this excludes nothing a player can actually create.
7. **The auction reserve is auction-only currency, and is never scored**
   (maintainer, 2026-09-18). It is not a `Resources` holding: it never
   touches `resourceBank`, has no `playerCap`, is spendable in a Zeitgeist
   auction and nowhere else, and contributes nothing at scoring. Bidding
   capacity is therefore `gold + reserve`, and the gold half of that
   capacity *is* victory points — gold scores at `achievements.json`'s
   `goldPerVictoryPoint` (`calculateGoldVP`, `src/engine/victoryPoints.ts`)
   while reserve scores nothing. That asymmetry is the mechanic: rule 4
   makes City Income doubly valuable by handing out bidding power that
   costs its holder no VP, and a player who has to reach past their reserve
   into their gold is paying for the Zeitgeist in victory points.
   **Still OPEN — the draw order.** Nothing yet settles what a winning bid
   of 10 costs a player holding 6 gold and 8 reserve. **Default to
   implement:** draw from **reserve first, then gold**; only the gold
   portion moves to the bank, the reserve portion is simply decremented.
8. **The reserve always empties after the last Zeitgeist phase**
   (maintainer, 2026-09-18) — for every player, unconditionally, and after
   the final Purchase phase where no such Zeitgeist phase exists (rule 5.1).
   Because the reserve is auction-only and unscored (decision 7), this
   clearing changes nothing observable at scoring; it is implemented anyway,
   both because it is the stated rule and because leaving a spent-out number
   on screen would misrepresent what a player can still do. Its real effect
   is on *play*: reserve is use-it-or-lose-it, so hoarding it past the last
   auction is a pure loss, which is the pressure the rule is there to apply.
9. **OPEN — nobody bids.** If every eligible player passes without a bid,
   **default to implement:** the current card stays, nothing is paid, and no
   player gets the choice. The alternative (the starting bidder takes the
   choice for free at zero) is a different game; it needs saying out loud.
10. **OPEN — bid increments.** **Default to implement:** whole numbers, each
    bid strictly greater than the standing high bid, minimum first bid of 1.
11. **No setup-affecting cards in the v1 deck.** Rule 2 allows the first
    draw before the map is built, which raises "does the current card apply
    during board setup?". Keeping cards that could affect tile or starting
    unit placement out of the eligible set sidesteps the question entirely
    for now; genesis deals the cards, and `status: 'boardSetup'` simply never
    consults them.
12. **Async pacing is a real cost, and gets a mitigation in the same
    track.** Four players bidding in rotation is potentially days of
    wall-clock in an `async` game — this app's most-played mode. The
    auction therefore ships with an optional **maximum bid**: a player may
    submit a ceiling once and let the engine resolve the rotation against
    it, rather than being woken for every increment. This is a UX
    requirement, not a nicety.

## 3. Data model additions

### 3.1 `GameState` (`src/engine/types.ts`)

```ts
interface GameState {
  // ...existing fields...
  /** Null/absent = the mode is off. */
  zeitgeist?: ZeitgeistState | null
  /** First player to claim an achievement this round — rule 3.1's starting bidder. Reset each round. */
  firstDeclineCauserId?: string | null
}

interface ZeitgeistState {
  /** Undrawn cards, in the order fixed before genesis (decision 4). */
  deckCardIds: string[]
  discardCardIds: string[]
  currentCardId: string | null
  nextCardId: string | null
  /** Rule 4's parallel pool, per player. Emptied per rule 5.1 (decision 8). */
  reserveByPlayerId: Record<string, number>
  /** Non-null only while `roundPhase === 'zeitgeist'`. */
  auction: ZeitgeistAuction | null
}

interface ZeitgeistAuction {
  highBid: number
  highBidderId: string | null
  /** Decision 12: a submitted ceiling the engine resolves the rotation against. */
  maxBidByPlayerId: Record<string, number>
  /** Set once bidding closes: the winner still owes their SET_ZEITGEIST choice. */
  awaitingChoiceFrom: string | null
}
```

Both new `GameState` fields are **optional**, following the
`adminModeActive` / `declineSourceZoneByCardId` convention: absent means off,
so every existing game export, production fixture and stored row replays
byte-identically without a data migration.

`firstDeclineCauserId` is recorded in `updateAchievementClaims`
(`src/engine/achievements.ts`) when `achievementsClaimedThisRound` goes
0 → 1, and reset alongside it in `beginSelectCardsPhase`
(`src/engine/round.ts`). If that player has conceded or been eliminated by
the time the auction opens, the rotation starts at the next live player in
`turnOrder`.

### 3.2 Settings (`src/lib/dbTypes.ts`, `GameSettings`)

```ts
  /** Zeitgeist mode on/off. Requires ruleEnforcementEnabled (decision 6). */
  zeitgeistEnabled: boolean
  /** The deck order fixed by handleStart() before genesis (decision 4); null until resolved. */
  zeitgeistDeckOrder: string[] | null
```

`games.settings` is a jsonb column, so **neither field needs a migration**
(CLAUDE.md: "add pregame toggles there"). Both are carried onto `GameState`
at genesis, per the working convention that a running game reads its
settings from `GameState`, not the `games` row.

### 3.3 Content (`src/content/guilds.json` + schema)

```ts
interface ZeitgeistCardDelta {
  movementOverridesByKind?: Record<string, Partial<UnitMovement>>
  extraActionsByKind?: Record<string, UnitAction[]>
  activationsPerTurnByKind?: Record<string, number>
}

/** The whole eligible deck, immutable for the game — resolved once by the caller. */
interface ZeitgeistContent {
  cardsById: Record<string, { id: string; name: string; description: string; delta: ZeitgeistCardDelta }>
}
```

`resolveZeitgeistContent()` joins `src/content/resolveContent.ts` beside
`resolveTaleContent`, and `applyZeitgeistModifiers(base, content, cardId)`
joins `src/engine/tales.ts`'s neighbours in a new `src/engine/zeitgeist.ts`.
`EMPTY_ZEITGEIST_CONTENT` makes every existing call site a no-op.

## 4. The round sequence

### 4.1 Where the phase goes

`RoundPhase` (`src/engine/types.ts`) gains a fifth value, `'zeitgeist'`,
after `'purchase'`:

```
selectCards → actions → [decline] → purchase → [zeitgeist] → finishRound
```

`finishRound()` is reached from four places on the purchase path today:
`beginPurchasePhase`'s skip-everyone case, `applyPurchaseCard`,
`applyPassPurchase`, and `applyConcede`. All four funnel through one new
`endPurchasePhase()` in `src/engine/round.ts`, which either opens the
auction or falls straight through to `finishRound()` exactly as today. **That
funnel is the only intrusive edit this mode makes to existing round code**,
and for a game with the mode off it is a pure pass-through.

The phase opens only when all of:

- `state.zeitgeist` is present (mode on), and
- a Decline actually happened this round (`isDeclineTriggered`,
  `src/engine/decline.ts`), and
- the game is not ending this round — rule 5's "no Zeitgeist phase in the
  last Decline phase". This is decidable exactly where the funnel sits:
  `finishRound` already ends the game when
  `Object.keys(claimedByAchievementId).length >= achievementContent.gameLength`,
  so the same comparison, one step earlier, is precisely "this is the last
  Decline". Rule 5.1's reserve clearing hangs off the same test (decision 8).

### 4.2 Actions

Three additions to `src/engine/actions.ts` and the `dispatchAction` switch
in `src/engine/applyAction.ts` (whose `never` exhaustiveness default will
point at every site that still needs updating):

| Action | Payload | Legal when |
| --- | --- | --- |
| `ZEITGEIST_BID` | `playerId`, `amount` (or a ceiling, decision 12) | `roundPhase === 'zeitgeist'`, caller is `activePlayerId`, still in the rotation, `amount` clears decision 10's rule and their capacity |
| `ZEITGEIST_PASS` | `playerId` | same, and drops the caller from the rotation for good |
| `SET_ZEITGEIST` | `playerId`, `choice: 'keep' \| 'advance' \| 'redraw'` | caller is `auction.awaitingChoiceFrom` |

Rule 3.2's three choices map to `keep` (nothing moves), `advance` (next →
current, old current → discard, `nextCardId` becomes null until the next
`redraw` refills it, or — see the open question in §7 — is redrawn
immediately), and `redraw` (old current and next → discard, deal two fresh
from `deckCardIds`).

Invariant 4 applies throughout: a rotation in which only one player can
afford any bid, or a `SET_ZEITGEIST` where an empty deck leaves only
`keep`/`advance` to choose between, is *forced* — it belongs in
`nextForcedFollowUp` (`src/engine/applyAction.ts`), folded into the
triggering entry rather than logged separately. `gameLog.ts` still narrates
each folded step on its own line.

### 4.3 Rule 4 — the City's Income action

`applyIncome` (`src/engine/unitActions.ts`) credits gold through
`creditResource`/`gainResource`. Rule 4 adds a parallel, uncapped credit to
`zeitgeist.reserveByPlayerId` of *the same amount actually gained* — the
amount after clamping, not the nominal effect, matching how
`describeResourceDelta` already reports reality rather than intent. The
reserve is not a `Resources` holding: it never touches `resourceBank`, has
no `playerCap`, and is not scored.

Scope question worth being explicit about: rule 4 says "the City's Income
action". The Capital (The Capital Tale) performs City actions, and the
Cathedral/Port have income actions of their own. **Default to implement:**
any `income`-effect action resolved by a unit of kind `city`, and by any
companion that reuses the City's action list. Other kinds' income does not
feed the reserve.

## 5. Hidden information, and both write paths

The undrawn deck order is the one new secret. `redactStateForPlayer`
(`src/engine/redaction.ts`) masks `zeitgeist.deckCardIds` for every viewer —
the same shape as the masking already there, and the only redaction work
this mode needs. Bids are public the moment they land, so nothing about the
auction itself is hidden; there is no new `RETRACT_*` surface and no new
`lockRevealedInformationEnabled` interaction.

Server plumbing is minimal, because `resolveGameContent(state)`
(`supabase/functions/_shared/gameEnforcement.ts`) already re-resolves
content per action from state — the mutable current card is simply another
state field it reads. Watch the two standing Edge-Runtime rules when the new
files enter that import graph: explicit `.ts` extensions on every relative
import, and `with { type: 'json' }` on the JSON import. **A missing
extension fails at deploy, not in CI.**

The notification functions (`supabase/functions/notify-discord-turn`,
`notify-web-push`) enumerate the phases; `ROUND_PHASE_LABEL` is a
`Record<RoundPhase, string>`, so `tsc` finds them. No SQL changes (decision
3), so `deploy-supabase.yml` runs `functions deploy` only.

## 6. Testing

- `src/engine/__tests__/zeitgeist.test.ts` pins the rules: the phase opens
  only after a Decline, never on the last one; the rotation and its
  forced-follow-up folding; reserve credit from City Income; each of rule
  3.2's three choices; deck exhaustion (decision 5); reserve clearing
  (decision 8).
- A dedicated replay test proves the point of §1: a history containing a
  card rotation replays to the same state, with a Nomad's legal moves
  differing before and after the rotation.
- `src/test/supabaseStack/` covers the enforced wire path end to end,
  including that the deck tail never reaches an opponent's copy of the
  state.
- Every existing production fixture must stay green untouched — that is the
  regression signal that `zeitgeist: null` really is inert.

## 7. Open questions for the maintainer

Beyond decision 7's draw order and decisions 9-10, which are marked OPEN
above:

1. **`advance` and the empty `next` slot.** After "replace the current card
   with the next card", is a new next card drawn immediately, or does the
   slot stay empty until someone pays to `redraw`? The latter makes
   `advance` a strictly weaker choice over time; the former makes it nearly
   as informative as `redraw`.
2. **Does the auction's winner pay before or after choosing?** It matters
   only if a rule ever makes the choice unaffordable; it does not today.
   Paying first is assumed.
3. **Eliminated players and their reserve.** `eliminatePlayer` returns a
   player's resources to the bank; the reserve is not a bank resource and is
   never scored (decision 7), so it is simply dropped — nothing to return,
   nothing to account for.

## 8. Phased roadmap

Four slices, each independently shippable and independently revertible.
None requires a migration.

1. **Content + deck.** `guilds.json`/schema restricted to the CD subset,
   `eligibleInZeitgeist`, `resolveZeitgeistContent`,
   `applyZeitgeistModifiers`, `EMPTY_ZEITGEIST_CONTENT`. No engine
   behavior change — pure addition, dead until slice 2 calls it.
2. **Engine: state, phase, auction.** `ZeitgeistState`,
   `firstDeclineCauserId`, the `endPurchasePhase` funnel, the three
   actions, rule 4's reserve credit, rules 5/5.1, and the one-line
   effective-content derivation in `runActionAndForcedFollowUps`.
3. **Wire: redaction, notifications, settings.** Deck-tail masking, phase
   labels in both notify functions, `zeitgeistEnabled` /
   `zeitgeistDeckOrder` through `GameSettings` → `handleStart()` →
   `buildGenesisState`, and the `start-game` Edge Function path.
4. **UI.** Create-game toggle, the current/next card display in
   `RoundView.tsx`, the auction panel including decision 12's maximum bid,
   and the reserve shown alongside gold.
