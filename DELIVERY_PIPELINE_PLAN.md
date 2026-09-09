# Delivery pipeline plan

How a change gets from "jinxbit wants X" to running in production, with as
much of the middle automated as is safe.

The target loop, in the maintainer's own words:

1. Claude develops features.
2. Claude deploys them to a pre-production environment and tests there.
3. The maintainer does final testing in pre-production.
4. The pre-production version is promoted to production.

Steps 1 and 4 mostly exist today. Steps 2 and 3 do not exist at all — there
is no pre-production anything. This document is the design for building it,
and the record of which decisions were made and why.

Status: **pre-production is complete and verified end to end** (2026-09-09).
Phases 0-2 are done: a second Supabase project holds the full migration
history and every Edge Function, a real production game replays against it,
and the Vercel Preview build talks to it — confirmed by signing in and
finding no games, on a separate auth store. Phase 3 is next and has not
started.

Decisions taken so far are in §2 (a second hosted project, self-hosting
deferred), §3 (branch topology, recommended, not yet acted on) and §7
(auto-merge to the integration branch, never to production).

---

## 1. What exists today

| Piece | Where | Trigger |
| --- | --- | --- |
| Lint / test / build | `.github/workflows/ci.yml` | every PR, and push to `main` |
| Claude implements a change | `.github/workflows/claude.yml` | `@claude` on an issue or comment |
| Claude reviews a PR | `.github/workflows/claude-code-review.yml` | every PR |
| Supabase migrations + functions deploy | `.github/workflows/deploy-supabase.yml` | push to `main` (Preview) or `production` (production), touching `supabase/migrations/**`, `supabase/functions/**`, `src/lib/**` |
| Frontend deploy | Vercel | push to `production` (production), `main` and other branches (preview) |
| Real games replayed against the deployed backend | `.github/workflows/smoke.yml` | after a successful Supabase deploy, and nightly |

Test layers, innermost first: engine tests (`src/engine/__tests__/`), the
in-process production-like stack (`src/test/supabaseStack/`), real games
replayed through it (`src/test/__tests__/productionGames.test.ts`), and the
same games replayed against the live project
(`src/test/productionSmoke/`).

**The gap this document set out to close** (historical — closed by phases
1-3). Every one of those ran either before anything was deployed, or after it
was already in production. There is no environment where a change is
both *deployed* and *not yet live for players*. Migrations are the sharpest
edge: `supabase db push` runs for the first time against the production
database, and this project has already had migration history drift badly
enough to need `audit-and-fix-migrations.yml` to repair it.

---

## 2. What pre-production has to be

A second Supabase project — its own database, auth, and Edge Functions —
plus a frontend build pointed at it. Not a branch of production data: a
separate project that the same migrations and the same functions are
deployed to first.

Decided (2026-09-08): **a second Supabase project the maintainer creates**,
rather than Supabase Branching (a paid feature, and its interaction with
Edge Function deploys needs verifying before relying on it) or a staging
frontend against the production project (which would test no migration and
no function change before production — most of the value). Confirmed the
same day that the plan allows a second project.

**Self-hosting was considered and deferred.** The maintainer has a Synology
DS1522+ running continuously — x86-64, so Supabase's amd64 self-hosted
images would run on it (RAM is the binding constraint, not CPU: 8GB base
against a stack of ten-odd containers, trimmable by dropping the analytics
components, and the box takes up to 32GB). It would rehearse the highest-risk
thing faithfully — `supabase db push` takes a `--db-url`, so migrations are
the same SQL against the same Postgres — plus RLS and Edge Function
behaviour, since the self-hosted `edge-runtime` is the same Deno image.

What it would *not* rehearse is the hosted platform itself: `supabase
functions deploy` (self-hosted serves functions from a mounted directory),
Database Webhooks (a dashboard feature hosted, a hand-written `pg_net`
trigger self-hosted), and platform behaviour generally — cold starts, rate
limits, the per-invocation latency questions. It also needs TLS reachable
from both GitHub Actions and a browser, since a Vercel preview is HTTPS and
browsers block HTTPS-to-HTTP.

Deferred rather than rejected: it is the escalation path if hosted costs
become a factor. It would also fill a role a hosted staging project cannot
(see §8) — seeding hundreds of synthetic games to find out whether a
migration locks a table, which is not something to do on a shared free-tier
project.

---

## 3. Branch topology

The recommended change is to move what `main` *means*, rather than to add a
branch beside it.

**Recommended — `main` integrates, `production` releases:**

- `main` stops being production. Everything merges here, and it deploys to
  the staging Supabase project and the staging frontend.
- A new `production` branch is what deploys to production. Promotion is a
  **fast-forward of `production` to `main`** — nothing else ever commits to
  it.

The reason is that `production` is then always an ancestor of `main` by
construction. The two cannot diverge, so there is never a back-merge to
remember, and "what is in production" is always answerable as "everything up
to commit X on `main`". It also leaves the GitHub default branch as `main`,
which is where `claude-code-action` opens pull requests by default — no
per-PR base overrides.

**Rejected — add a `staging` branch, keep `main` as production:** any fix
committed to `main` (a hotfix, or a merge made in a hurry) immediately
diverges from `staging` and needs merging back. That bookkeeping is exactly
the kind of step that gets skipped once and then silently rots.

**Cost of the recommended option:** `deploy-supabase.yml` retargets;
`smoke.yml` retargets; branch protection has to be set up on
`production`; and every place that says "main is production" needs updating
(`CLAUDE.md`'s Supabase section, `README.md`). It is a rename of meaning, not
a restructuring of work.

---

## 4. Environments

| | Pre-production | Production |
| --- | --- | --- |
| Branch | `main` | `production` |
| GitHub Environment | `Preview` | `production` |
| Supabase project | new, e.g. `rise-and-fall-staging` | the existing one |
| Frontend | Vercel Preview env, with a stable branch domain | Vercel Production |
| Data | disposable; seeded on demand | real games |
| Smoke test | on every deploy | on every deploy, and nightly |

**Frontend environment variables are baked in at build time.**
`src/lib/supabase.ts` reads `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`
from the bundle, so a pre-production frontend is a *separate build*, not a
runtime switch. Vercel's Preview-scoped environment variables give exactly
that: Preview → the Preview Supabase project, Production → production.

**Vercel picks Production vs Preview by branch, exactly as this plan does.**
Its *Production Branch* setting is `main` today, so a build of `main` uses
the Production-scoped variables and Preview-scoped ones apply only to other
branches. That means there is no fixed pre-production URL until §3's
topology change lands — phase 3 must flip Vercel's Production Branch to
`production` at the same time it flips the workflows, or the frontend and
the backend will disagree about which environment `main` is.

No domain purchase is needed for a stable URL: Vercel's auto-generated
per-branch domain (`<project>-git-<branch>-<scope>.vercel.app`) always points
at that branch's latest deployment. Only the per-*deployment* hash URLs are
unstable. A custom subdomain is optional and free if the domain is already
owned; buying one is not required.

**Every non-production build says so on screen.** `VITE_ENVIRONMENT` is set
on Vercel's Preview scope only, and the app renders a corner badge naming
that environment and the Supabase project ref it is actually talking to
(`src/components/environmentBadge.ts`). Production leaves the variable unset
and shows nothing, so the safe state is the one requiring no configuration.
This exists because a build is configured entirely at build time: without it,
the only ways to tell pre-production from production are reading the deployed
JavaScript or noticing that your account does not exist there. Both have been
needed already.

**Auth on staging needs its own setup.** OAuth redirect URIs are registered
per Supabase project, so Discord and Google sign-in will not work on staging
until they are configured there too. The cheap path is to lean on
email/password (`EmailPasswordAuth.tsx`, issue #384) and optionally
`VITE_ALLOW_GUEST_AUTH` for staging, and only wire OAuth there if the OAuth
flow itself is what needs testing.

---

## 5. Secrets

Existing (production): `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
`SUPABASE_PROJECT_ID`, `SMOKE_SUPABASE_ANON_KEY`,
`SMOKE_SUPABASE_SERVICE_ROLE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`.

Rather than adding a parallel `STAGING_*` set of repository secrets, use
**GitHub Environments** (`Preview` and `production`) and scope the same
secret *names* to each, so the workflows stop caring which environment they
are in beyond `environment: Preview|production`.

**The promotion gate does not belong on the `production` environment.** A
required reviewer there is the obvious-looking way to make promotion wait for
the maintainer, and it is wrong: `deploy-supabase.yml` and `smoke.yml` both
run under `environment: production` too, so a reviewer on it would suspend
every production deploy and every nightly production smoke run waiting for a
click. The gate belongs on a *separate* environment — `production-release` —
referenced only by the promotion workflow (§9 phase 5), which does no
deploying itself and exists precisely to be approved.

The names in the workflows must match the environments **exactly**. Asking
for one that does not exist is not an error GitHub reports — it auto-creates
an empty environment, which then inherits production's secrets (§8).
`Preview` deliberately matches Vercel's own name for the same tier, since
the Vercel Preview build and this GitHub Environment point at the same
Supabase project.

Per environment: `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID`,
`SMOKE_SUPABASE_ANON_KEY`, `SMOKE_SUPABASE_SERVICE_ROLE_KEY`.
`SUPABASE_ACCESS_TOKEN` is account-scoped rather than project-scoped, so it
can be left at repository level and inherited by both — it is the one secret
here where inheritance is the right answer.

Plus one repository **variable**, `PRODUCTION_SUPABASE_PROJECT_ID`, holding
the production project ref. It is a variable rather than a secret on purpose:
a ref is the subdomain of the public API URL, so it is not sensitive, and
being readable in the UI is what lets the wiring be checked by eye. Both
workflows refuse to run without it (§8).

---

## 6. The loop, end to end

**1. Develop.** An issue mentioning `@claude` starts `claude.yml`. Claude
implements on a branch and opens a PR against `main`. `ci.yml` runs lint,
test and build; `claude-code-review.yml` reviews the diff.

**2. Deploy to pre-production and test there.** On green CI the PR
auto-merges (rules in §7). The push to `main` deploys migrations and Edge
Functions to the staging Supabase project and builds the staging frontend.
The staging smoke test — the existing `src/test/productionSmoke/` runner,
pointed at staging — then replays the checked-in real games through the
freshly deployed functions. If it fails, an issue is opened mentioning
`@claude` with the failing action and the server's own message, so the fix
starts without the maintainer being the messenger.

**3. Maintainer tests.** A stable staging URL, plus `npm run seed:staging` —
a command that reuses `provisionLiveRoom` to create a room from a fixture,
replay it to an interesting position, and seat the maintainer's own staging
account in it. The point is that "go and test it" costs a click rather than
fifteen minutes of setting a game up.

**4. Promote.** A `production` fast-forward, triggered by
`workflow_dispatch` on a promotion workflow that names the commit being
promoted. The `production` GitHub Environment's required reviewer means it
waits for an explicit approval. The push deploys to the production Supabase
project and Vercel Production, and `smoke.yml` runs against
production as it does today.

---

## 7. Automation rules

Decided (2026-09-08): **auto-merge to `main` on green CI; never to
`production`.**

A PR auto-merges only when *all* of these hold:

- CI (lint, test, build) is green.
- It was opened by Claude, not by a human — a human PR is a human's to merge.
- It does **not** touch `supabase/migrations/**`. A migration is the one
  change staging cannot fully de-risk: it runs against an empty staging
  database and then against production data of a completely different shape
  and size. Migrations get a human read, always.
- It is not a draft, and carries an explicit label (say `automerge`) so the
  behaviour is opt-in per PR rather than ambient.

And never:

- Auto-promote to `production`. That is step 3's whole purpose.
- Promote while the staging smoke test is red.
- Push to `production` other than by fast-forward.

Auto-promotion is worth revisiting only once the browser tests exist — the
current smoke coverage proves the backend replays a recorded game, which is
not the same as proving the app works.

---

## 8. Risks, honestly

- **Staging proves less than it looks.** Its database is empty and its games
  are fixtures. A migration that is instant on staging can lock a table for
  minutes on production data; a query that is fine against three games is not
  necessarily fine against three hundred. Staging catches *shape* problems,
  not *scale* problems. Closing that gap needs an environment where hundreds
  of synthetic games can be generated and thrown away cheaply, which is the
  one job the self-hosted option in §2 would do better than a hosted project.
- **Two projects, two migration histories.** They can drift apart from each
  other as well as from the files. `audit-and-fix-migrations.yml` should be
  parameterised by environment at the same time as the deploy workflow, so
  the audit can be run against either.
- **Free-tier projects pause when idle.** A staging project that nobody
  touches for a week pauses, and the next deploy fails confusingly. The
  nightly smoke test doubles as a keep-alive, which is a reason to point the
  nightly at *both* environments rather than only production.
- **An environment that does not exist looks exactly like one that does.**
  GitHub auto-creates an environment the moment a workflow names one, and an
  environment with no secrets of its own inherits the repository-level ones —
  which are production's. So a typo in an environment name, or an environment
  not yet filled in, silently targets production rather than failing. This
  happened on 2026-09-09. Both workflows now assert the resolved project ref
  against the repository variable `PRODUCTION_SUPABASE_PROJECT_ID` before
  touching anything, which is the only reason it is a survivable mistake
  rather than a destructive one.
- **More moving parts to get wrong.** Every workflow gains an environment
  dimension. The mitigation is that they all share one runner
  (`src/test/productionSmoke/runSmoke.ts`) which is already covered in CI by
  `productionSmokeRunner.test.ts` against the in-process stack.

---

## 9. Phases

0. **This document.** ✅
1. **Parameterise the workflows by environment.** ✅ (2026-09-08)
   `deploy-supabase.yml` and `smoke.yml` (renamed from
   `production-smoke.yml`, since it is no longer production-only) each
   resolve a target environment from one commented branch mapping, and run
   their real job under a GitHub Environment of that name. `main` still maps
   to production, so behaviour is unchanged; a `workflow_dispatch` input can
   already target staging the moment that environment exists. Secrets resolve
   through the environment, and repository-level secrets are inherited until
   environment-scoped ones are added, so phase 2 is additive rather than a
   cutover. `npm run test:production` became `npm run test:smoke` for the
   same reason.
2. **Stand up pre-production.** Mostly ✅ (2026-09-09). The Supabase project
   exists, the GitHub `Preview` environment carries its four project-specific
   secrets, and the repository variable `PRODUCTION_SUPABASE_PROJECT_ID`
   guards both workflows. `Deploy Supabase -> Preview` applied all 27
   migrations to an empty database in one pass — the first time that sequence
   has ever run start to finish rather than incrementally, which is most of
   why this environment is worth having — and deployed every Edge Function.
   `Smoke -> Preview` then replayed a real production game against it and it
   finished on the recorded score.

   Two mis-steps on the way, both now designed out and recorded in §8: a run
   requested for an environment name that did not exist deployed to
   production instead, because GitHub auto-creates an empty environment and
   an empty environment inherits production's secrets.

   The Vercel half took two goes. Preview-scoped `VITE_SUPABASE_*` had no
   effect at first because the existing entries were scoped to *all*
   environments, which wins over an environment-specific one — the build
   looked correctly configured and silently used production. What surfaced it
   was the environment badge (§4): the page named the project it was really
   talking to. Narrowing the originals to Production and adding Preview-scoped
   copies fixed it, confirmed by signing in on the preview and finding no
   games. The Preview project also needed its own Authentication -> URL
   Configuration, since a fresh project's Site URL is `localhost`.

   Outstanding, and a prerequisite for phase 3 rather than phase 2: branch
   protection on `production` (no force-pushes, no deletions). The branch
   exists, at the same commit as `main`.

3. **Retarget `main`, and the docs with it.** ✅ (2026-09-09) `main` deploys
   to pre-production; `production` deploys to production. Three things moved
   together, since any one alone leaves the environments disagreeing: the
   branch mapping in `deploy-supabase.yml` and `smoke.yml` (both now map
   `main -> Preview`, `production -> production`, and `deploy-supabase.yml`
   triggers on both branches), **Vercel's Production Branch setting**
   (`main` -> `production`), and `CLAUDE.md`. Done at the one moment it was
   free: `main` and `production` were identical, so nothing was stranded in
   pre-production by the switch.
4. **Auto-merge, and self-healing staging failures.** §7's rules, plus the
   issue-opening on a red staging smoke.
5. **The promotion workflow.** Fast-forward `production`, gated by a required
   reviewer on a dedicated `production-release` environment — never on
   `production` itself, which deploys and nightly smoke runs also use (§5).
6. **Browser tests.** The Playwright layer sketched earlier — it is what
   would eventually justify trusting an automatic promotion.

Phases 1 and 2 can proceed in parallel: phase 1 is repository work, phase 2
is dashboard work.

---

## 10. Open questions

- ~~**Does the Supabase plan allow a second project?**~~ Resolved
  (2026-09-08): it does. Phase 2 proceeds as written; self-hosting on the
  maintainer's NAS stays documented in §2 as the escalation path if hosted
  costs become a factor.
- **Should the nightly smoke run against both environments,** or only
  production? Both, probably — it keeps staging awake (§8) and catches drift
  there before a promotion does.
- **Where do hotfixes go?** Under §3's topology a hotfix still goes through
  `main` and a promotion, which is correct but not instant. If a
  production-only emergency path is wanted, it needs designing deliberately
  rather than discovering it at 2am.
- **Should `claude-code-review.yml`'s verdict gate auto-merge?** Today it
  comments and nothing depends on it. Making a review blocking is a way to
  raise the bar on unattended merges, but risks deadlock when the reviewer
  and the implementer are the same model.
