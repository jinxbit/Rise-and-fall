# Production deployment

The runbook for putting what is on `main` in front of real players.
Design and reasoning live in `DELIVERY_PIPELINE_PLAN.md`; this is the short
operational version.

## The shape of it

| | Pre-production | Production |
| --- | --- | --- |
| Branch | `main` | `production` |
| GitHub Environment | `Preview` | `production` (deploys) + `production-release` (the approval gate) |
| Supabase project | Preview project | production project (`PRODUCTION_SUPABASE_PROJECT_ID`) |
| Frontend | Vercel Preview (badge on screen) | Vercel Production (no badge) |

`production` is **only ever fast-forwarded to a commit `main` already
carries**. Nothing else commits to it, so it is an ancestor of `main` by
construction and there is no back-merge to remember.

**Deploying is a side effect of the push, not of the promotion workflow.**
`promote.yml` moves the branch; `deploy-supabase.yml` sees `production` move
and runs `supabase db push` + `supabase functions deploy` against the
production project; `smoke.yml` follows it and replays the checked-in real
games through the freshly deployed Edge Functions; Vercel builds the
frontend from the same push.

## Before you promote

1. **Pre-production is green.** `Smoke -> Preview` succeeded on the commit
   you intend to promote (or on a later one). `promote.yml` refuses to run
   while the latest Preview smoke is red.
2. **CI is green on that exact commit.** Also checked by `promote.yml`.
3. **You have actually used pre-production.** Smoke proves the backend
   replays a recorded game; it does not prove the app works. Play a turn.
4. **Migrations have had a human read.** They never auto-merge, and they are
   the one thing pre-production cannot fully de-risk: they run against an
   empty Preview database and then against real production data.
5. **`production-release` has a required reviewer.** `promote.yml` asserts
   this — an environment with no reviewer would promote unattended.

## Promoting

GitHub -> Actions -> **Promote to production** -> Run workflow. Leave the
`commit` input blank to promote `main`'s head, or paste a full SHA.

The `prepare` job runs first and changes nothing. Read its run summary: the
commit title, whether `main` contains it, whether the move is a
fast-forward, CI's verdict, and the state of the latest Preview smoke. Then
approve the `production-release` prompt. The push is a plain `git push`, so
git itself refuses anything that is not a fast-forward.

## After the push

Watch, in order:

1. **Deploy Supabase -> production** — its "Refuse to touch the wrong
   project" step asserts the resolved project ref against
   `PRODUCTION_SUPABASE_PROJECT_ID` before anything is applied, then
   `db push`, then `functions deploy`.
2. **Smoke -> production** — replays the fixture games against the live
   project. It writes real rows, in an isolated private `live`-mode room
   that it deletes afterwards. A failure files an issue (without an
   `@claude` mention — pointing an unattended agent at the live project is
   the maintainer's call).
3. **Vercel Production** — the build carries no environment badge. If a
   badge appears in production, the Vercel environment scoping is wrong.
4. **Open the app.** Sign in, load a real game, take a turn.

## This release (as of 2026-09-11)

`main` is ~91 commits ahead of `production` and carries three unapplied
migrations, all of which change live behaviour:

- `0028_hidden_information_rls_lockdown.sql` — revokes direct client
  `SELECT` on `game_state` for hidden-information games; those reads must go
  through `get-game-state`.
- `0029_start_game_edge_function.sql` — blocks the client-side genesis write
  and the `lobby -> active` flip for enforced games; Start Game goes through
  the new `start-game` Edge Function.
- `0030_purchase_phase_simultaneous.sql` — `game_state_sync_meta` now
  projects the whole `pending_player_ids` list during the purchase phase.

0028 and 0029 **cut off a code path the currently-live frontend still
uses**, so the frontend and the functions must reach production in the same
promotion — which they do, since both ride the same commit. Existing games
are untouched: every lockdown is scoped to games whose settings carry the
matching flag, and games predating the flags read `false`.

## If it goes wrong

**Roll forward.** `production` is fast-forward only and branch protection
forbids force-pushes, so there is no "un-promote": fix on `main`, get it
green in pre-production, promote again.

A Vercel instant-rollback reverts the frontend alone and leaves the new
schema and functions deployed, so use it only when the frontend is the
problem. Migrations have no down step — a migration that needs undoing needs
a new migration.

## One-time setup (already done; here so it can be checked)

- Branch protection on `production`: no force-pushes, no deletions.
- GitHub Environments `Preview` and `production`, each with its own
  `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID`, `SMOKE_SUPABASE_ANON_KEY`,
  `SMOKE_SUPABASE_SERVICE_ROLE_KEY`. An environment missing one silently
  inherits the repository-level secret, which is production's.
- `production-release` with a required reviewer, referenced by `promote.yml`
  only. The gate must not go on `production` — deploys and the nightly smoke
  run under that one and would hang waiting for a click.
- Repository variable `PRODUCTION_SUPABASE_PROJECT_ID`, and repository
  secrets `SUPABASE_ACCESS_TOKEN` and `AUTOMATION_TOKEN`. Without
  `AUTOMATION_TOKEN` the promotion refuses to push: GitHub does not start
  workflow runs from events its own `GITHUB_TOKEN` caused, so the branch
  would move without deploying.
