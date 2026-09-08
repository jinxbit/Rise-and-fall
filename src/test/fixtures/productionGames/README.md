# Production game fixtures

Drop a game exported from production into this directory and it becomes a
test. No registration step, no code change:
`src/test/__tests__/productionGames.test.ts` globs this folder, and every
export it finds is replayed action by action through the real
`apply-action`/`undo-action`/`redo-action` Edge Functions against a Supabase
stack that behaves like production (`src/test/supabaseStack/`).

## Adding a game

1. Open the game and use **Copy game export** (GamePage.tsx) — or the saved
   `.json` file that button's download produces.
2. Save it here as `<something-descriptive>.json`, unchanged. The file is the
   app's own export format (`src/lib/gameStateExport.ts`): a small JSON object
   whose `gameStateZipped` field holds the gzipped `GameState`.
3. Run `npm run test`. The new game shows up as its own suite, named after the
   file.

Pick games that are worth regression-testing: a finished game, a game that hit
a bug, a game using a Tale or a game length that little else covers, a game
with undo/redo in its history, a hotseat game. Long games are fine — a few
hundred actions replays in seconds.

## Declaring the result

A game's outcome is worth stating in a sidecar, from what you read off the
end-of-game screen, rather than leaving the test to derive it:

```json
{
  "expected": {
    "finalScores": { "Mano": 174, "jinxbit": 138 },
    "winners": ["Mano"]
  }
}
```

Players are named by display name or by engine player id. A scoring change
that moved every total in step would still satisfy "the replay matches the
export" — both sides move together — but it cannot satisfy a number that came
from outside the code.

## Entries that no longer need submitting

A game played before the §4.2/§4.3 fold-in can have a standalone history entry
for something today's engine does automatically as part of the preceding
action — a tile tier down to one legal arrangement, a one-card hand's pick.
The app's own reconstruction paths (`replayActions`, `gameLog`, `turnReview`)
already skip those; a live submission deliberately does not, so that a player
resubmitting a stale action still gets a real rejection.

The replay makes the same distinction, asking the engine rather than guessing:
dispatched as a trusted replay, such an entry is the one case that succeeds
with no steps. Those entries are skipped, and the final state is compared with
them dropped from the expected log — they are no-ops by construction, so
nothing else about the game changes. `red-beats-blue-async` has 12 of them out
of 263.

## Which write path a game is replayed on

The app has two, and a game is replayed on the one it was actually played on
(the same branch `GamePage.tsx`'s `submitAction` takes):

- **Rule-enforced** (`ruleEnforcementEnabled`, the default assumed here): each
  action goes to the `apply-action`/`undo-action`/`redo-action` Edge
  Functions, which re-derive the state server-side and write it compressed.
- **Client-trusted**: the client applies the action itself and writes
  `game_state` directly, under RLS and the version compare-and-swap.

Most games in production still run client-trusted. Say so in the sidecar:

```json
{ "settings": { "ruleEnforcementEnabled": false } }
```

Replaying a client-trusted game through the Edge Functions would be testing it
against rules it was never played under — and can genuinely fail: the hotseat
game in this directory is refused under enforcement, because §4.4's
owner-override check lacks the hotseat carve-out §4.1 has (see the
"refuses a hotseat player acting for their other seat" test in
`src/test/__tests__/supabaseStack.test.ts` for a minimal reproduction).

## What gets asserted

For each game:

- Every logged action is accepted, submitted by the seat that actually made
  it. A rejection fails with that action's position in the history and the
  server's own message.
- `game_state.version` advances by exactly one per action.
- Nobody outside the game can act: a signed-in user with no seat in it is
  refused, on the Edge Function path and the direct-write path alike.
- The state stored at the end matches the exported one — including `status`,
  `winnerPlayerIds` and `claimedByAchievementId`, asserted separately so
  "the game ended differently" reads as its own failure.
- The final score matches whatever the sidecar declares, and — declared or
  not — the winner is whoever actually has the most points.
- The stored row is shaped the way that game's write path stores it (gzipped
  for an enforced game), and its `game_state_meta` projection matches
  (issue #451).
- The game's first action is refused (403) when submitted by another seat.
- A direct client `UPDATE` of `game_state` is refused by RLS for an enforced
  game and allowed for a client-trusted one
  (`0026_rule_enforcement_flag.sql`).

## What is inferred, and how to override it

An export carries the `GameState` only, so the `games`/`players` rows around it
are reconstructed from it (see `reconstructRoom` in `loadFixtures.ts`): seats
and their auth users come from `state.players`, the map settings are recovered
from the action history, and `ruleEnforcementEnabled` is forced on — replaying
through the Edge Functions is the whole point, and a client-trusted game would
not exercise a line of enforcement.

Every fixture verifies itself at load: the reconstructed genesis is replayed
through the engine and must reproduce the exported state exactly. If it can't,
the loader says so and names the fix — add a sidecar next to the export:

```jsonc
// my-game.room.json  (sits beside my-game.json)
{
  "createdBy": "<auth user id of the room owner>",
  "admins": ["<auth user id>"],
  "settings": { "mapTemplateId": "classic" },
  "userIdByPlayerId": { "<engine player id>": "<auth user id>" },
  "expected": { "finalScores": { "<display name>": 174 }, "winners": ["<display name>"] }
}
```

The loader works out "build alone" games and preset-board games from the
history on its own — `blue-beats-red` needed no settings beyond its write
path — so reach for `settings` only when the load-time check says to.

`admins` is the one to reach for if a replay is refused with *"Submitting this
action would discard another player's undone move"*: that action was made in
production by the room owner or a site admin with room admin mode on, so the
replay needs to know who that was.

## Privacy

These files are committed to the repository. An export contains display names
and auth user ids of everyone who played, plus the full game. Only add games
whose players are fine with that, and use a sidecar's `userIdByPlayerId` to
substitute placeholder ids if not.
