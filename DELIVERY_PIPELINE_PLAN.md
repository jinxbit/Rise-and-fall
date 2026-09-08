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

Status: **design agreed, nothing built.** Decisions taken so far are in §3
(branch topology, recommended) and §7 (auto-merge to the integration branch,
never to production — the maintainer's explicit choice).

---

## 1. What exists today

| Piece | Where | Trigger |
| --- | --- | --- |
| Lint / test / build | `.github/workflows/ci.yml` | every PR, and push to `main` |
| Claude implements a change | `.github/workflows/claude.yml` | `@claude` on an issue or comment |
| Claude reviews a PR | `.github/workflows/claude-code-review.yml` | every PR |
| Supabase migrations + functions deploy | `.github/workflows/deploy-supabase.yml` | push to `main` touching `supabase/migrations/**`, `supabase/functions/**`, `src/lib/**` |
| Frontend deploy | Vercel | push to `main` (production), other branches (preview) |
| Real games replayed against the deployed backend | `.github/workflows/smoke.yml` | after a successful Supabase deploy, and nightly |

Test layers, innermost first: engine tests (`src/engine/__tests__/`), the
in-process production-like stack (`src/test/supabaseStack/`), real games
replayed through it (`src/test/__tests__/productionGames.test.ts`), and the
same games replayed against the live project
(`src/test/productionSmoke/`).

**The gap.** Every one of those runs either before anything is deployed, or
after it is already in production. There is no environment where a change is
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
| Supabase project | new, e.g. `rise-and-fall-staging` | the existing one |
| Frontend | Vercel Preview env, with a stable branch domain | Vercel Production |
| Data | disposable; seeded on demand | real games |
| Smoke test | on every deploy | on every deploy, and nightly |

**Frontend environment variables are baked in at build time.**
`src/lib/supabase.ts` reads `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`
from the bundle, so a staging frontend is a *separate build*, not a runtime
switch. Vercel's Preview-scoped environment variables give exactly that:
Preview → staging project, Production → production project. Assign a branch
domain to `main` so the staging URL is stable rather than a per-deployment
hash.

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
**GitHub Environments** (`staging` and `production`) and scope the same
secret *names* to each. Two benefits: the workflows stop caring which
environment they are in beyond `environment: staging|production`, and the
`production` environment can carry a **required reviewer**, which is the
native way to make promotion wait for the maintainer rather than inventing a
gate in YAML.

Per environment: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
`SUPABASE_PROJECT_ID`, `SMOKE_SUPABASE_ANON_KEY`,
`SMOKE_SUPABASE_SERVICE_ROLE_KEY`.

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
2. **Stand up staging.** Maintainer: create the Supabase project, set the
   Vercel Preview variables and branch domain, add the GitHub Environments
   and their secrets, create the `production` branch at the current `main`,
   set branch protection. Then the first staging deploy and smoke run.
3. **Retarget `main`, and the docs with it.** `main` deploys to staging;
   `production` deploys to production. Update `CLAUDE.md` and `README.md` in
   the same commit — they currently state that main is production.
4. **Auto-merge, and self-healing staging failures.** §7's rules, plus the
   issue-opening on a red staging smoke.
5. **The promotion workflow.** Fast-forward `production` behind the
   environment's required reviewer.
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
