# Production smoke test

Replays real games from `../fixtures/productionGames/` against the **live**
Supabase project, through the deployed Edge Functions, and checks each one
finishes on the score and winner it finished on in production.

`npm run test` proves the *code* is right, against an in-process stack
(`../supabaseStack/`). This proves the *deployment* is: migrations actually
applied, functions actually deployed and booting, RLS actually as written,
keys still valid. Neither substitutes for the other.

## Running it

```bash
SMOKE_SUPABASE_URL=https://<project-ref>.supabase.co \
SMOKE_SUPABASE_ANON_KEY=<anon key> \
SMOKE_SUPABASE_SERVICE_ROLE_KEY=<service role key> \
npm run test:smoke
```

`.github/workflows/smoke.yml` runs it after every successful
Supabase deploy, nightly, and on demand. `SMOKE_SUPABASE_URL` defaults to the
`SUPABASE_PROJECT_ID` secret the deploy workflow already uses, so only the two
key secrets need adding.

The service-role key is used for exactly two things: creating the run's
throwaway users and deleting them again. Every game action is submitted as a
real signed-in player over the anon key — submitting as the service role would
bypass the very authorization this is here to test.

## Why it can't touch anything real

It writes to the production database, so isolation is the whole safety story
(`liveProject.ts`):

- **Throwaway users per run**, created and deleted through the admin API. No
  standing credentials, nothing left in the user list.
- **A `private` room**, so it never appears on the Public Rooms screen.
- **`play_mode: 'live'`, never `'async'`.** Both notification functions
  early-return unless the game is async, so a replay cannot page anyone. Play
  mode is carried on `GameState` but never read by the engine, and the
  enforcement path treats live and async identically — so this costs nothing.
  It is the one field the final-state comparison expects to differ on.
- **Teardown deletes the room before the users.** `games.created_by` and
  `players.user_id` reference `auth.users` with no `on delete cascade`
  (`0001_init_schema.sql`), so the other order fails on a foreign key and
  strands the room. Deleting the room cascades its players, state and meta.
- Teardown runs in a `finally`, and `provisionLiveRoom` tears down its own
  partial work if it fails part-way. If a run is killed hard enough to skip
  both, the leftovers are one `[smoke] …` private room and its accounts.

## Which games run

Only fixtures that were played on the **rule-enforced** write path, and that
actually finished. A client-trusted game is skipped with a reason rather than
forced through rules it was never played under — one checked-in game genuinely
cannot survive that (the hotseat owner-override gap pinned in
`../__tests__/supabaseStack.test.ts`). A run where *every* fixture was skipped
fails: a green tick that verified nothing is the worst shape a smoke test can
take.

## Player ids are remapped

A fixture's action history names the original room's `players.id` uuids, and
card ids embed them (`card_<playerId>_<kind>`). A fresh room gets fresh uuids,
so `remapFixture.ts` rewrites the history — and the expected end state, scores
and winners — onto the new room before anything is submitted. Unit ids need no
remapping; they come from a counter in `GameState`, not from who owns them.

## Cost per run

Each action is one Edge Function invocation plus one `game_state` write, and
each write fires the configured Database Webhooks (which return immediately
for a non-async game). With the two eligible fixtures that is roughly 500
function invocations and up to ~1,500 webhook invocations per run — comfortably
inside Supabase's free-tier limits at one run a night plus one per deploy, but
worth knowing before adding many more fixtures.

## The runner is itself tested

`../__tests__/productionSmokeRunner.test.ts` runs this exact runner against the
in-process stack on every PR — it creates users, signs them in, opens a room,
seats players, writes genesis, replays a real game and cleans up, without
knowing it isn't talking to Supabase. Production is a bad place to discover
that the provisioning sequence, the id remapping or the teardown is wrong.
