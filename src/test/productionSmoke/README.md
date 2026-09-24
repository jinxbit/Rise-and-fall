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

## It also fails on a slow deploy, not just a wrong one

Each fixture's average `apply-action`/`undo-action`/`redo-action` round trip
(`replayFixture.ts`'s `actionDurationsMs`) is checked against a ceiling —
`DEFAULT_MAX_AVERAGE_ACTION_MS` in `liveProject.ts`, 1500ms, overridable with
`SMOKE_MAX_AVERAGE_ACTION_MS` — and the run fails with the measured average
and the ceiling named in the message if it's exceeded. This exists because of
todo.md #139: a change that roughly doubled the per-action round trip (~860-
890ms baseline) was only visible as the whole run eventually blowing its 900s
cap, twice, with no number in the failure pointing at what got slower. A
report also carries `averageActionMs` for every fixture that ran, not just a
failing one, so the nightly log shows the trend before it crosses the line.

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

## Hidden information is forced on

None of the checked-in exports was played with
`hiddenInformationEnabled`, so a replay of them used to reach the deployed
Edge Functions' `revealedGameStateView` and never
`redactStateForPlayer` — leaving the wire check below as the only live
coverage of redaction. `runSmoke.ts` therefore provisions each room with
`{ hiddenInformation: true }`, overriding whatever the export recorded.

Nothing in `src/engine/` reads the flag (only `redaction.ts` does), so the
game replays identically; it is reconciled in `fixtureForRoom` alongside
`playMode`, for the same reason, rather than showing up as a divergence on
every run.

It does change one thing the replay depends on. With redaction live, an
`apply-action` response is masked for the acting seat — truncated at
`unredactedPrefix`, in-flight fields hidden — and
`replayFixtureThroughStack` uses the response as its own copy of the state to
decide whether the next logged entry is a stale forced follow-up. Both
eligible fixtures genuinely fold entries (12 and 18), and measured against the
in-process stack 37 of 462 responses come back materially redacted, so that is
not theoretical. The replay therefore takes the state from `LiveRoom`'s
service-role `readTrueState()` instead, once per action, for a redacted game
only. That read is deliberately outside the `actionDurationsMs` window, which
exists to catch a regression in the *round trip*; a target that can't supply
it fails loudly rather than replaying against a state that isn't the game.

## Every call asks for a protocol-2 delta

Neither smoke entry point used to send `protocol` or `sinceActionIndex`, so
every deployed response came back `shape: "full", reason: "protocol-1"` and
the delta path — the rebuild, the in-flight overlay, the hash check — had no
coverage against a real project at all. The replay now speaks protocol 2 on
every call, and `runSmoke.ts` fails the run if a delta could not be rebuilt,
or if not one response came back as a delta (a deployment that ignored
`protocol: 2` used to pass silently, which was the whole problem).

The cache is **per seat**, not per room, because that is what the world looks
like: each seat is a separate browser holding its own IndexedDB entry, and a
seat's cache only advances when that seat itself calls. So a request's
`sinceActionIndex` is usually several entries behind the row and the append
comes back multi-entry — the case `extendReplay` has to fold undo/redo
markers through, which a single-action test never reaches.

The client half is `gameApi.ts`'s own `applyReplayDelta`/`deriveBaseFromView`,
imported from `src/lib/replayDelta.ts`. That module exists so they can be
imported at all: `gameApi.ts` pulls in `./supabase`, which throws at import
time without env vars. A smoke test that reimplemented the client half would
prove the deployment agrees with the test, not with the app.

Measured against the in-process stack:

```
red-beats-blue-async      251 actions   251 deltas   2 full
three-player-red-runaway  211 actions   209 deltas   5 full
```

`full` is not a failure count. A seat's first call has no cache, and a
redacted game's safe prefix can move *backwards* (it is not monotonic — a
measured 173 → 104), which `get-game-state` answers with a full state and the
reason `prefix-moved-back`. That is the whole of the excess above: three
first calls and two moved-back prefixes in the three-player game.

There is also one protocol-2 `get-game-state` per seat once the game is
finished, so the read path's delta branch is covered and not only the three
write endpoints.

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

## The hidden-information wire check

`hiddenInformationWire.ts`/`.smoke.ts` is a second, independent check in this
same directory (HIDDEN_INFORMATION_PLAN.md §8 phase 9): rather than replaying
a recorded game, it opens its own throwaway three-seat room (same isolation
rules as above), scripts it to a freshly-opened `selectCards`/`decline` phase,
and inspects the *raw* `get-game-state`/`apply-action` response bodies and a
real Realtime subscription — bypassing `gameApi.ts`'s usual collapse — to
prove a still-pending player's secret pick never crosses the wire in any of
them, then that it's revealed once the phase resolves. It runs automatically
alongside the fixture-replay check above: `vitest.smoke.config.ts`'s
`include` matches every `*.smoke.ts` file here, so no separate workflow entry
was needed. The wire half (no socket required) is also exercised on every PR
against the in-process stack via
`../__tests__/hiddenInformationWireRunner.test.ts`; the Realtime half only
ever runs here, against a live project.

## The runner is itself tested

`../__tests__/productionSmokeRunner.test.ts` runs this exact runner against the
in-process stack on every PR — it creates users, signs them in, opens a room,
seats players, writes genesis, replays a real game and cleans up, without
knowing it isn't talking to Supabase. Production is a bad place to discover
that the provisioning sequence, the id remapping or the teardown is wrong.
