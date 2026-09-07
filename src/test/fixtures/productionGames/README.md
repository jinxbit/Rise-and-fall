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

## What gets asserted

For each game:

- Every logged action is accepted by the Edge Function, submitted by the seat
  that actually made it. A rejection fails with that action's position in the
  history and the server's own message.
- `game_state.version` advances by exactly one per action.
- The state stored at the end matches the exported one — including `status`,
  `winnerPlayerIds` and `claimedByAchievementId`, asserted separately so
  "the game ended differently" reads as its own failure.
- The stored row is gzipped and its `game_state_meta` projection matches
  (issue #451).
- The game's first action is refused (403) when submitted by another seat.
- A direct client `UPDATE` of `game_state` is refused by RLS
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
  "userIdByPlayerId": { "<engine player id>": "<auth user id>" }
}
```

`admins` is the one to reach for if a replay is refused with *"Submitting this
action would discard another player's undone move"*: that action was made in
production by the room owner or a site admin with room admin mode on, so the
replay needs to know who that was.

## Privacy

These files are committed to the repository. An export contains display names
and auth user ids of everyone who played, plus the full game. Only add games
whose players are fine with that, and use a sidecar's `userIdByPlayerId` to
substitute placeholder ids if not.
