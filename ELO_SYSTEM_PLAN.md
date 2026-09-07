# ELO system — design document

A skill rating for Rise & Fall's persistent accounts, so players have a
number that goes up and down as they win/place well or lose across games.
This is a design doc only — nothing here is implemented yet. Written
against the codebase as of the "duplicated game finished status" work
(issue #455) and `HIDDEN_INFORMATION_PLAN.md`'s `game_state_meta` split.

## 1. Why this isn't plain 1v1 Elo

Classic Elo assumes exactly two players, one winner. Rise & Fall games are
free-for-all (`games.min_players`/`max_players`, `0001_init_schema.sql`,
default 2–4, no teams), and per the win rule there's deliberately **no
tiebreaker** — `determineWinners()` (`src/engine/victoryPoints.ts`) returns
every player tied for the highest total VP, which can be more than one id.
On top of that, a player can leave the ranking early via elimination or
`CONCEDE` (`Player.eliminated`/`Player.conceded`, `src/engine/types.ts`) —
excluded from winning, but still a real outcome worse than finishing the
game with fewer points.

So the model needs to handle: N-player free-for-all, ties for any place
(not just 1st), and forfeits. The standard way to do this — used by chess
tournament software, board-game rating sites, etc. — is to decompose an
N-player game into every pairwise comparison and run ordinary two-player
Elo math on each pair, then combine.

## 2. Rating model

**Scale:** a Rise & Fall–specific scale starting at **1000**, not 1500/2400
— deliberately not implying compatibility with chess Elo or any external
system.

**Per game**, given the final standing (see §3 for where that standing
comes from):

For every ordered pair of rated players `(i, j)` in the same game:

- Expected score: `E_ij = 1 / (1 + 10^((R_j - R_i) / 400))`
- Actual score `S_ij`: `1` if `i` placed better than `j`, `0` if worse,
  `0.5` if they tied (same place — including two-or-more-way wins).
- Player `i`'s total for the game: `sum_j (S_ij - E_ij)` over every other
  rated player `j`.
- Rating change: `delta_i = round(K * sum_i / (n - 1))`, where `n` is the
  number of *rated* players in that game (§4). Dividing by `n - 1`
  (the number of pairwise comparisons `i` is part of) keeps a single game's
  swing comparable whether it was a 2-player or 4-player game, rather than
  scaling up with opponent count.
- All deltas are computed from ratings **as they stood at game start**
  (snapshotted once, applied to every pair simultaneously) so the result
  doesn't depend on the order players are processed in.

**Placement / ranking:** reuse the "1224" competition ranking already
implemented for the end-game screen (`ranksFor()` in
`src/components/EndGameView.tsx`) — players tied on total VP share a place,
the next distinct total skips ahead accordingly. That function is small and
UI-only today; move (or duplicate as a rated version of) that ranking logic
into `src/engine/` so it can be reused outside a React component (see §5
for why the rated version needs it in a %non-UI context).

**Eliminated/conceded players:** treated as ranked strictly below every
player who finished the game active, regardless of their frozen VP total
(today's `EndGameView` sort would otherwise coincidentally tie a
0-VP-but-still-active player with an eliminated one — a forfeit isn't the
same outcome as "scored zero and kept playing," so this needs a deliberate
rule rather than reusing the raw VP sort as-is). Within the
eliminated/conceded group, there's currently no elimination-order tracked
in `GameState` (no `eliminatedAtRound` or similar), so **all eliminated/
conceded players in a game tie for last** — this is a known simplification
(see §8).

## 3. K-factor and provisional ratings

- Flat **K = 32** at launch. This is a small, friendly-competitive player
  base, not a ladder under adversarial pressure, so a taper for experienced
  players (e.g. K = 16 after 20 games) is a reasonable v2 tweak but not
  needed to ship something useful.
- No decay/inactivity penalty at launch (see §8).

## 4. Which players and games count

- **Only real, distinct accounts.** Hotseat games seat multiple *local*
  players under one signed-in host's `user_id`
  (`0003_hotseat_local_players.sql`'s `addLocalPlayer` — several `players`
  rows can share a `user_id` once that constraint was relaxed). Rating an
  account against itself is meaningless, and deduping it correctly is
  needless complexity for a mode that's explicitly built for in-person
  play. **Recommendation: hotseat games are never rated, full stop.**
- **Guest/anonymous accounts are excluded.** `VITE_ALLOW_GUEST_AUTH`'s
  testing escape hatch (`src/lib/auth.ts`) creates real but throwaway
  Supabase anonymous sessions (`auth.users.is_anonymous = true`) with no
  persistent identity across browsers — rating them would pollute the
  leaderboard with accounts nobody can look up again.
- **Minimum two rated players.** If a `live`/`async` game completes but
  fewer than two seated players are rating-eligible after excluding guests
  (e.g. one real account playing against guests only), skip rating
  entirely — there's nothing to compare.
- **Canceled games never qualify** — `state.status` only ever reaches
  `'completed'` via `finishRound()` or the sole-survivor path in
  `src/engine/elimination.ts`; a canceled room's `game_state` simply never
  gets there, so no separate exclusion is needed for that case.

## 5. Where the final standing actually comes from — the key constraint

`GameState` does **not** persist a full final ranking. `finishRound()` and
`elimination.ts` only ever set `winnerPlayerIds` (whoever's tied for
*first*) — every other player's exact place (2nd vs. 3rd vs. 4th) is
recomputed on demand, client-side, by `calculateVPDetail()`/
`calculateVPBreakdown()` (`src/engine/victoryPoints.ts`), which walk the
*entire* board/units/achievements state and re-derive VP from the real
rules content (`content/achievements.json`, `content/terrain.json`, etc.).
That's a lot of real game logic — not something to reimplement a second
time in raw SQL inside a Postgres trigger.

This rules out the simplest-looking implementation (a pure-SQL trigger
reading only `game_state.state`'s top-level JSON, the same shape
`game_state_sync_meta` in `0025_game_state_meta.sql` already reads for
`status`/`roundPhase`/`turn`/`version`) — that trigger genuinely can't tell
2nd place from 3rd without duplicating `victoryPoints.ts` in SQL, which
would drift from the real engine the moment scoring rules change.

Two ways to get a real ranking instead:

**A. Coarser SQL-only rating (win vs. everyone else).** Only use
`winnerPlayerIds` + `eliminated`/`conceded`, all cheap top-level JSON
fields a SQL trigger *can* read: winner(s) beat everyone; every other
still-active player draws with each other; eliminated/conceded players
lose to everyone. This loses the "did you come 2nd or last" signal
entirely — every non-winner is scored identically regardless of how close
they were — which is a real loss of information for a VP-based game, but
it's simple, fully server-side, and needs no new infrastructure.

**B. Full placement-based rating via the real engine (recommended).**
Compute standings with the actual `calculateVPDetail`/`calculateVPBreakdown`
+ the new shared `ranksFor`-equivalent (§2) — in TypeScript, against the
same content the client uses — then write ratings from there. This is the
option worth building, because it's the only one that rewards a strong 2nd
place over a weak one, matching what the end-game screen already shows
players.

## 6. Recommended architecture: Edge Function on the existing webhook pattern

Rise & Fall already has exactly this shape of problem solved twice:
`supabase/functions/notify-discord-turn` and
`supabase/functions/notify-web-push` are both Edge Functions triggered by a
**Database Webhook** on `game_state` `UPDATE`, authenticated via an
`x-webhook-secret` header, running with the service role (so they can write
past RLS). Add a third: `apply-elo-ratings`.

1. **Trigger:** same Database Webhook mechanism (**Database → Webhooks**),
   table `game_state`, event `Update`, target `apply-elo-ratings`, header
   `x-webhook-secret` set to a new `ELO_WEBHOOK_SECRET`.
2. **Function body:**
   - Bail immediately unless `new.state.status === 'completed'`
     (mirrors `notify-discord-turn`'s turn-detection guard, just a
     different field).
   - Idempotency guard: bail if a `rating_events` row already exists for
     this `game_id` (see schema below) — protects against webhook retries
     and, defensively, against `game_state` somehow being rewritten after
     completion.
   - Load the game's `players` rows (service role bypasses RLS), join
     `games.play_mode`, filter out hotseat games (§4) and guest accounts
     (`auth.admin.getUserById` or a join against `auth.users.is_anonymous`)
     down to the rated player set; bail if fewer than 2 remain.
   - Compute standings by importing the real rules engine — Deno can
     import the same `src/engine/*.ts` modules the client/tests use
     (`calculateVPDetail`, `calculateVPBreakdown`, the shared ranking
     helper from §2), so this is literally the same scoring code, not a
     reimplementation.
   - Run the pairwise Elo math from §2, using each rated player's current
     `player_ratings.rating` (row-locked/read within the function's own
     transaction to avoid a race with another game finishing for the same
     player at the same instant).
   - Write one `player_ratings` upsert + one `rating_events` insert per
     rated player, in one transaction.
3. **Why not compute it client-side instead:** whichever browser witnesses
   the `'completed'` transition could run the same TS engine and just
   write the result directly — no Edge Function needed. Rejected because
   (a) nothing guarantees a client is present at exactly that moment for
   `async` games days apart, and (b) it means trusting an ordinary
   `authenticated` RLS role to self-report its own rating change, which is
   a bigger trust jump than the current model (clients already write
   `game_state` directly, but that's validated by every other client
   replaying the same deterministic engine against the same action log —
   a rating delta has no such cross-check). The webhook path keeps rating
   writes entirely out of client hands, consistent with how this repo
   already treats "state that must not be client-forgeable."

## 7. Schema

```sql
-- One row per rated account. Absence = never finished a rated game (shown
-- as "unranked" in the UI rather than a fake baseline row).
create table public.player_ratings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  rating numeric not null default 1000,
  games_played int not null default 0,
  updated_at timestamptz not null default now()
);

-- Append-only history — the idempotency guard (unique game_id+user_id)
-- *and* the source for a future "rating over time" chart, same spirit as
-- src/engine/scoreHistory.ts's per-round score snapshots.
create table public.rating_events (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  place int not null,
  player_count int not null,
  rating_before numeric not null,
  rating_after numeric not null,
  delta numeric not null,
  created_at timestamptz not null default now(),
  unique (game_id, user_id)
);
```

RLS: both tables readable by any signed-in user (leaderboard + "how did I
do last game" need to be visible to everyone, same audience as `players`
today); **no `authenticated` insert/update/delete policy on either** — only
the service-role Edge Function writes them, same lockdown
`game_state_meta` uses for its security-definer trigger.

## 8. Open questions / deliberately deferred

- **Elimination order.** Eliminated/conceded players all tie for last
  today (§2) because `GameState` doesn't record *when* each was removed.
  Tracking an `eliminatedAtRound`/order field on `Player` would let a
  first-eliminated player rate below a last-eliminated one — a real
  improvement, but a separate engine change outside this doc's scope.
- **Per-play-mode pools.** Should `live`/`async` share one rating, or get
  separate pools (a `live` game's pace/pressure arguably tests something
  different than a days-long `async` one)? Recommend starting with one
  shared pool for simplicity; split later if it turns out to matter.
- **Provisional ratings.** No "new player" badge/wider K at launch (§3) —
  revisit once there's enough game volume for it to matter.
- **Backfill.** This doc only covers games completed *after* rollout.
  Backfilling already-completed games would need a one-off script reusing
  the same engine + pairwise math against historical `game_state` rows, run
  in `winnerPlayerIds`/completion order — worth doing once, not part of the
  ongoing trigger.
- **Where it's surfaced.** Not designed here in detail, but the natural
  spots are: a small rating badge next to a player's name (lobby,
  `MyGamesPage`), a new leaderboard page, and a "+18 / -12" delta on
  `EndGameView` once the Edge Function has run — that last one is
  necessarily asynchronous relative to the end-game screen appearing
  (the webhook fires after the client's own write completes), so the UI
  needs to handle "rating not posted yet" rather than assuming it's ready
  the instant the screen renders.

## 9. Suggested milestones

1. `player_ratings`/`rating_events` migration + RLS (§7).
2. Extract the placement/ranking helper (§2) out of `EndGameView.tsx` into
   `src/engine/` so both the UI and the Edge Function use one
   implementation.
3. `apply-elo-ratings` Edge Function (§6) + its Database Webhook, following
   `notify-discord-turn`'s structure (webhook secret, service role, doc
   comment explaining the trigger condition).
4. Surface ratings in the UI (§8's "where it's surfaced" list) — separate
   follow-up issue once the above is in place and producing real numbers.
