# Rise & Fall

A private, non-commercial web app for playing an original real-time strategy
board game with a small group of friends — remotely, async, or on one
shared device. Built for personal use only.

This is an **original implementation**: all code, UI, and copy here are
written from scratch. No third-party rulebook text, card text, or artwork is
reproduced.

## Stack

- **Frontend:** Vite + React + TypeScript, Tailwind CSS v4
- **Backend:** Supabase (Postgres for game state, Realtime for live sync, Auth with Discord/Google OAuth or email/password for identity)
- **Hosting:** Vercel (frontend) + Supabase free tier (backend)

## Architecture

- `src/engine/` — the rules engine. Pure TypeScript, zero React/Supabase
  imports, no JSON imports, fully unit-testable. Everything else in the app
  treats `GameState` as opaque and only mutates it by calling
  `applyAction()` here. A game's current state is always reconstructable by
  replaying its append-only `actionHistory` from genesis (event sourcing),
  which is what makes undo/redo, history review and the replay tests work.
- `src/content/` — hand-authored game data (units, terrain, resources,
  achievements, tales, map templates) as JSON + JSON Schema, plus
  `resolveContent.ts`, which resolves it into the content-agnostic bundles
  the engine takes as parameters. See `src/content/README.md` — the most
  detailed description of the actual game rules in the repo.
- `src/lib/` — Supabase client, auth helpers, and typed query functions
  (`gameApi.ts`) that read/write the `games` / `players` / `game_state` /
  `game_state_meta` / `profiles` / `map_pool` tables, plus the storage
  encoding (`gameStateCompression.ts`) and the export format
  (`gameStateExport.ts`).
- `src/pages/` + `src/components/` — the UI: home/lobby/create screens, the
  SVG hex board (`HexBoard.tsx`), interactive board setup
  (`BoardSetupView.tsx`), the round cycle (`RoundView.tsx`), the end-of-game
  breakdown (`EndGameView.tsx`), and admin/map-builder screens.
- `supabase/migrations/` — SQL migrations. Applied automatically on push to
  `main` by `.github/workflows/deploy-supabase.yml`, or by hand (see below).
- `supabase/functions/` — Edge Functions: the `apply-action` /
  `undo-action` / `redo-action` trio that enforce the rules server-side for
  games that opt in (see below), plus the `notify-discord-turn` /
  `notify-web-push` turn notifiers. The enforcement functions import
  `src/engine/` unmodified — there is no second copy of the rules.
- `src/test/` — vitest setup, an in-process Supabase stack that behaves like
  production (`supabaseStack/`), and real games replayed as regression tests
  (`fixtures/productionGames/`).

`CLAUDE.md` at the repo root is the short orientation doc: the same layering
plus the invariants and gotchas worth knowing before changing anything.

**Play modes** (`live` / `async` / `hotseat`) share the same rules engine
and the same `GameState` JSON shape end to end. The only thing that differs
between them is how a client figures out "which player am I" and how it
learns about updates:

- **Live:** all players connected at once; Supabase Realtime pushes every
  state change to every client immediately.
- **Async ("play by turn"):** no realtime requirement — a player's client
  just loads the current `game_state` row and checks whose turn it is.
  Optional "your turn" pings go out over Discord webhooks (see below) —
  each player supplies their own; a Supabase Edge Function sends the ping
  server-side.
- **Hotseat:** one device, players take turns in person. Every seat belongs
  to the one signed-in host account, and the app gates each handover behind
  a "pass the device" screen so the next player doesn't see the previous
  one's secrets (skippable per game — see the hotseat section below).

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project values
npm run dev
```

Other scripts:

```bash
npm run test        # the whole test suite (vitest) — engine, UI, and replays
npm run test:watch  # the same, in watch mode
npm run lint        # oxlint
npm run build       # typecheck (3 tsconfig projects) + production build
```

CI (`.github/workflows/ci.yml`) runs lint, test, and build on every pull
request; all three also run in a few seconds to half a minute locally.

If `.env.local` isn't set up yet, the app renders a "Configuration error"
message instead of a blank screen — that's expected until you complete the
Supabase setup below.

## Supabase setup (do this yourself)

1. Create a new project at [supabase.com](https://supabase.com).
2. Apply every migration in `supabase/migrations/`, in filename order. The
   easy way is the CLI — `supabase link --project-ref <your-project-ref>`
   then `supabase db push` — which applies all of them and records what it
   applied; the SQL editor works too if you paste them in order. `0001` is
   the foundation (`games`, `players`, `game_state`, Row Level Security so
   only seated players can read/write a game's state, and the
   `supabase_realtime` publication); the rest add `profiles`,
   `game_state_meta`, `push_subscriptions`, `map_pool`, per-game settings
   and the later RLS refinements, and the app assumes all of them.
3. Copy your project's **Project URL** and **anon public key** (Settings →
   API) into `.env.local` as `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY`.
4. Deploy the Edge Functions if you want server-side rule enforcement or
   turn notifications — `supabase functions deploy` — plus the per-function
   secrets described in the sections below. Everything else works without
   them.

## Deploying Supabase changes (optional)

Migrations and Edge Functions can be applied by hand (SQL editor / `supabase`
CLI, as described throughout this doc) or automatically on every push to
`main` via [`.github/workflows/deploy-supabase.yml`](.github/workflows/deploy-supabase.yml).
That workflow runs whenever a file under `supabase/migrations/` or
`supabase/functions/` changes (or on manual trigger from the Actions tab),
links the CLI to your project, runs `supabase db push` to apply any new
migrations, and `supabase functions deploy` to redeploy all Edge Functions.

To enable it, add these repository secrets (**Settings → Secrets and
variables → Actions**):

- `SUPABASE_ACCESS_TOKEN` — a personal access token from your [Supabase
  account settings](https://supabase.com/dashboard/account/tokens).
- `SUPABASE_PROJECT_ID` — your project's ref, the subdomain in its API URL
  (`https://<project-ref>.supabase.co`).
- `SUPABASE_DB_PASSWORD` — the database password you set when creating the
  project (Settings → Database, or reset it there if forgotten).

Function-specific secrets (`DISCORD_NOTIFY_WEBHOOK_SECRET`, VAPID keys, etc.)
still need to be set once per project with `supabase secrets set`, as
described in each function's setup section below — the workflow only
deploys code, not secrets.

## Email/password sign-in

Supabase's built-in Email provider is enabled by default, so no extra setup
is required beyond a fresh Supabase project — the home page's "or" divider
lets a player register with a username, email, and password, or sign back in
with the same email/password. The username becomes the account's display
name (`full_name`), same as the Discord/Google flows. If the Supabase
project has **Confirm email** turned on (Authentication → Providers →
Email), a new account can't sign in until the player clicks the
confirmation link sent to their inbox.

**Forgot password:** "Forgot password?" on the sign-in form emails a reset
link (Supabase's `resetPasswordForEmail`) that lands on `/reset-password`,
where the player sets a new password. That path needs to be reachable from
the allow list in **Authentication → URL Configuration → Redirect URLs** —
add `<your-origin>/reset-password` (e.g. `http://localhost:5173/reset-password`
for local dev) alongside the plain origins already added for Discord/Google
OAuth above, or use a wildcard like `http://localhost:5173/**` to cover both.

## Discord OAuth setup (do this yourself)

This uses Supabase Auth's built-in Discord provider, so a player's Discord
username/avatar becomes their in-game identity, with a stable account
across live/async/hotseat sessions.

**1. Create the Discord application**

- Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
- Name it whatever you like (e.g. "Rise & Fall").
- Under **OAuth2 → General**, note the **Client ID** and **Client Secret**
  (click "Reset Secret" if one isn't shown yet) — you'll paste both into
  Supabase in step 3.

**2. Get your Supabase callback URL**

- In the Supabase dashboard: **Authentication → Providers → Discord**.
- Supabase shows a **Callback URL (for OAuth)** field, something like:
  `https://<your-project-ref>.supabase.co/auth/v1/callback`
- Copy it exactly.

**3. Register the redirect URL in Discord**

- Back in the Discord Developer Portal, under **OAuth2 → General → Redirects**,
  click **Add Redirect** and paste the Supabase callback URL from step 2.
- Save changes.

**4. Configure the scopes**

- No extra scope configuration is needed on the Discord side for basic
  login — Supabase requests `identify` and `email` by default when you
  enable the provider, which is enough to get the user's Discord username,
  id, and avatar. You don't need to add a redirect scope or bot
  permissions; this is a plain OAuth login, not a bot install.

**5. Enable the provider in Supabase**

- In **Authentication → Providers → Discord**, toggle it on, paste in the
  **Client ID** and **Client Secret** from step 1, and save.

**6. Add your app's redirect URLs**

- In **Authentication → URL Configuration**, add the URLs your app will
  actually run on to the allow list, e.g.:
  - `http://localhost:5173` (local dev)
  - your Vercel deployment URL, once you have one
- The app calls `signInWithOAuth` with `redirectTo: window.location.origin`,
  so whatever origin the user is on when they click "Sign in with Discord"
  needs to be in this list.

Once that's done, "Sign in with Discord" on the home page should work end
to end.

## Google OAuth setup (do this yourself)

This uses Supabase Auth's built-in Google provider as an alternative to
Discord — a player's Google name/avatar becomes their in-game identity, with
a stable account across live/async/hotseat sessions, same as Discord.

**1. Create OAuth credentials in Google Cloud**

- Go to the [Google Cloud Console credentials page](https://console.cloud.google.com/apis/credentials)
  and select or create a project.
- Click **Create Credentials → OAuth client ID**. If prompted, configure the
  **OAuth consent screen** first (External is fine for testing).
- Application type: **Web application**. Name it whatever you like (e.g.
  "Rise & Fall").
- Note the **Client ID** and **Client Secret** — you'll paste both into
  Supabase in step 3.

**2. Get your Supabase callback URL**

- In the Supabase dashboard: **Authentication → Providers → Google**.
- Supabase shows a **Callback URL (for OAuth)** field, something like:
  `https://<your-project-ref>.supabase.co/auth/v1/callback`
- Copy it exactly.

**3. Register the redirect URL in Google Cloud**

- Back in the Google Cloud Console, edit the OAuth client from step 1, and
  under **Authorized redirect URIs**, add the Supabase callback URL from
  step 2.
- Save changes.

**4. Enable the provider in Supabase**

- In **Authentication → Providers → Google**, toggle it on, paste in the
  **Client ID** and **Client Secret** from step 1, and save.

**5. Add your app's redirect URLs**

- In **Authentication → URL Configuration**, add the URLs your app will
  actually run on to the allow list, e.g.:
  - `http://localhost:5173` (local dev)
  - your Vercel deployment URL, once you have one
- (Skip this if you've already added them for Discord — it's the same list.)
- The app calls `signInWithOAuth` with `redirectTo: window.location.origin`,
  so whatever origin the user is on when they click "Sign in with Google"
  needs to be in this list.

Once that's done, "Sign in with Google" on the home page should work end to
end.

## Discord turn notifications (optional, per player)

This is separate from Discord OAuth above — sign-in identifies who you are,
this is just an optional ping for async games. No bot or extra Discord app
setup: each player creates their own [Discord
webhook](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)
on a channel they control and pastes the URL into the "Discord
notifications" panel on the home page. When it becomes their turn in an
async game, a Supabase Edge Function (`supabase/functions/notify-discord-turn`)
sends the ping — not a co-player's browser, so it still fires even if
everyone else has closed the tab, and no player's webhook URL needs to be
readable by anyone but the backend.

1. In Discord, go to the channel you want pings in → **Edit Channel →
   Integrations → Webhooks → New Webhook**.
2. Copy its **Webhook URL**.
3. On the Rise & Fall home page, open **Discord notifications**, paste the
   URL in, and hit **Save**. **Send test** confirms it's wired up correctly.

**Backend setup** (do this once per Supabase project):

1. Run `supabase/migrations/0005_discord_webhooks.sql` (after `0001`) to add
   the `profiles` table webhook URLs are stored in, then
   `supabase/migrations/0013_discord_notify_backend.sql` to lock reads of
   that table down to each player's own row (the old design let co-players
   read each other's webhook URL — see that migration's comment).
2. Deploy the Edge Function with the [Supabase
   CLI](https://supabase.com/docs/guides/functions/deploy):
   ```bash
   supabase functions deploy notify-discord-turn
   supabase secrets set DISCORD_NOTIFY_WEBHOOK_SECRET=$(openssl rand -hex 32)
   ```
   `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are provided automatically at
   runtime; `DISCORD_NOTIFY_WEBHOOK_SECRET` is a value you choose, used to
   confirm requests actually came from your project's Database Webhook.
   Optionally also set `SITE_URL` (e.g. `supabase secrets set
   SITE_URL=https://your-deployed-site.example`) so the ping includes a
   direct link to the game — without it, the ping falls back to showing the
   room code instead of a link. Only the origin is used, so it's fine even
   if the value has a path on the end (e.g. one copy-pasted from the browser
   address bar while testing).
3. Register the Database Webhook — **Database → Webhooks → Create a new
   hook** in the Supabase dashboard.
   - Table: `game_state`. Events: `Update`.
   - Type: **Supabase Edge Functions**, targeting `notify-discord-turn`.
   - Add an HTTP header `x-webhook-secret` set to the same value as
     `DISCORD_NOTIFY_WEBHOOK_SECRET` above.

Steps 2 and 3 are what the **Set Up Discord Notifications** workflow
(Actions → Run workflow) does for you, including registering the hook —
see [Setting the backend up from GitHub Actions](#setting-the-backend-up-from-github-actions)
below. Re-running it rotates the secret on both sides at once.

See `supabase/functions/notify-discord-turn/index.ts`'s doc comment for how
the function decides who to ping.

## Push notifications (optional, per player)

The app is installable as a PWA (Add to Home Screen / Install app) and can
send a system notification when it becomes your turn in an async game — no
Discord setup needed, just a browser permission prompt. Same design as
Discord turn notifications above: a Supabase Edge Function
(`supabase/functions/notify-web-push`) sends the push server-side, so it
still fires even if every tab is closed.

1. On the Rise & Fall home page (once the backend below is set up), open
   **Profile → Push notifications** and hit **Turn on**, then allow the
   browser's permission prompt.
   - **iOS Safari**: only works after the app has been installed to the
     Home Screen (Share → Add to Home Screen) — Safari doesn't support Web
     Push for regular browser tabs, only for installed PWAs, and needs
     iOS/iPadOS 16.4+.
   - **Android (Chrome and most others)**: works either installed or as a
     regular browser tab.

**Backend setup** (do this once per Supabase project):

1. Run `supabase/migrations/0020_push_subscriptions.sql` (after `0001`) to
   add the table subscriptions are stored in.
2. Generate a VAPID keypair (identifies your server to push services —
   nothing to sign up for):
   ```bash
   npx web-push generate-vapid-keys
   ```
3. Set `VITE_VAPID_PUBLIC_KEY` in your `.env` (see `.env.example`) to the
   public key — this is what enables the opt-in UI at all; leaving it unset
   hides it. Rebuild/redeploy the frontend after setting it.
4. Deploy the Edge Function and set its secrets:
   ```bash
   supabase functions deploy notify-web-push
   supabase secrets set VAPID_PUBLIC_KEY=<the public key from step 2>
   supabase secrets set VAPID_PRIVATE_KEY=<the private key from step 2>
   supabase secrets set PUSH_NOTIFY_WEBHOOK_SECRET=$(openssl rand -hex 32)
   ```
   `VAPID_CONTACT` is optional (`supabase secrets set
   VAPID_CONTACT=mailto:you@example.com`) — some push services use it to
   reach you if your server is misbehaving; defaults to a placeholder.
   `SITE_URL` (see the Discord section above) is reused here too, so the
   notification can deep-link straight to the game.
5. In the Supabase dashboard: **Database → Webhooks**, and either add a
   second target to the same hook created for Discord above, or create a
   new one — Table: `game_state`, Events: `Update`, Type: **Supabase Edge
   Functions**, targeting `notify-web-push`, with an HTTP header
   `x-webhook-secret` set to `PUSH_NOTIFY_WEBHOOK_SECRET` from step 4.

Steps 4 and 5 (and the keypair in step 2) are what the **Set Up Web Push
Notifications** workflow does for you — see [Setting the backend up from
GitHub Actions](#setting-the-backend-up-from-github-actions) below. Step 3
stays yours: nothing in this repo's Actions can set an env var on the
frontend host.

See `supabase/functions/notify-web-push/index.ts`'s doc comment for how the
function decides who to ping — it's the same turn-detection logic as the
Discord function, just a different delivery channel.

## Lobby & game lifecycle notifications (optional, per player)

Same two channels and same per-player opt-in as above (Discord webhook /
push subscription — there's no separate toggle for these), but for four
room-lifecycle events instead of "it's your turn": a player joining the
lobby, the game starting, the game finishing, and the game being canceled.
Two more Edge Functions send these — `notify-discord-lifecycle` and
`notify-web-push-lifecycle` — each triggered by three Database Webhooks
instead of one, since the four events live on three different tables
(`players` inserts, `games` status updates, `game_state` reaching
`completed`).

Live players already see all of this over Realtime and hotseat has nobody
remote to ping, so — same rule as the turn notifications above — only async
games trigger a ping.

**Backend setup**: run the **Set Up Lifecycle Notifications** workflow
(Actions → Run workflow → pick the environment, type `YES`). It deploys both
functions, generates and sets `DISCORD_LIFECYCLE_WEBHOOK_SECRET` /
`PUSH_LIFECYCLE_WEBHOOK_SECRET`, registers all six Database Webhooks, and
probes both functions with the headers those hooks now carry. Do the
Discord/push turn-notification setup first: these functions reuse the same
`profiles` / `push_subscriptions` tables, the same VAPID keypair, and the
same per-player opt-in — there is no separate toggle for lifecycle events.

By hand instead, once per Supabase project:

1. Deploy both Edge Functions and set their secrets:
   ```bash
   supabase functions deploy notify-discord-lifecycle
   supabase secrets set DISCORD_LIFECYCLE_WEBHOOK_SECRET=$(openssl rand -hex 32)

   supabase functions deploy notify-web-push-lifecycle
   supabase secrets set PUSH_LIFECYCLE_WEBHOOK_SECRET=$(openssl rand -hex 32)
   ```
   Both reuse `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (automatic) and
   `SITE_URL` (optional, already set above if you configured turn
   notifications) for the game link. `notify-web-push-lifecycle` also reuses
   the existing `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_CONTACT`
   secrets from the push notifications setup above — no new keypair, since
   it's the same subscriber pool.
2. In the Supabase dashboard: **Database → Webhooks**, create three hooks
   per function (six total) — one per source table, each targeting the
   matching lifecycle function:
   - Table: `players`, Events: `Insert`
   - Table: `games`, Events: `Update`
   - Table: `game_state`, Events: `Update` (a third target alongside the
     existing turn-notification hooks on this same table/event)

   Each hook needs Type **Supabase Edge Functions** and an HTTP header
   `x-webhook-secret` set to `DISCORD_LIFECYCLE_WEBHOOK_SECRET` (for the
   three targeting `notify-discord-lifecycle`) or
   `PUSH_LIFECYCLE_WEBHOOK_SECRET` (for the three targeting
   `notify-web-push-lifecycle`).

See `supabase/functions/notify-discord-lifecycle/index.ts`'s doc comment for
the full trigger/dispatch details, which apply to both functions.

## Setting the backend up from GitHub Actions

Three manually-dispatched workflows do the notification backend setup above
without a terminal — useful for rotating a leaked secret from a phone, and
the only practical way to keep six hooks consistent:

| Workflow | Deploys | Registers |
| --- | --- | --- |
| Set Up Discord Notifications | `notify-discord-turn` | `game_state`/Update |
| Set Up Web Push Notifications | `notify-web-push` | `game_state`/Update |
| Set Up Lifecycle Notifications | `notify-discord-lifecycle`, `notify-web-push-lifecycle` | `players`/Insert, `games`/Update, `game_state`/Update, per function |

Each one asks which environment to target (Preview is pre-production, the
project `main` deploys to; production is the live one) and refuses to run if
that GitHub Environment has no `SUPABASE_PROJECT_ID` of its own and would
have silently inherited production's — the same guard, and the same
incident, as `deploy-supabase.yml`.

Each generates a fresh webhook secret, sets it on the function, and writes
it into the hooks in the same run, so **re-running a setup workflow is how
you rotate a secret**; nothing has to be copied by hand and the two sides
cannot drift apart. A Database Webhook is only a Postgres trigger calling
`supabase_functions.http_request`, so registration is
`scripts/supabase/register-database-webhook.sh` sending SQL over the
Supabase Management API — it replaces whatever already points at that
function on that table (adopting a hook you created by hand rather than
doubling it), and `WEBHOOK_DRY_RUN=1` prints the SQL instead of sending it.

Two things stay manual, because nothing here can do them:

- Each player's own opt-in — pasting a Discord webhook URL, or enabling
  push — in the app's Profile screen. That's per-player data.
- `VITE_VAPID_PUBLIC_KEY` on the frontend host (Vercel), after generating a
  new keypair. The workflow prints the value to paste.

If registration can't run at all — the Management API is unreachable, or
Database Webhooks were never enabled on a fresh project (**Database →
Webhooks → Enable**, which is what installs
`supabase_functions.http_request`) — the run says so, prints the dashboard
steps and the secret to paste, and fails loudly rather than leaving you with
a function nothing calls.

## Replaying production games in tests

Real games can be turned into regression tests by dropping their export into
`src/test/fixtures/productionGames/`. Use **Copy game export** on a game page
(see `src/lib/gameStateExport.ts`), save the JSON there, and `npm run test`
picks it up — no registration step.

Each one is replayed action by action, submitted by the seat that actually
made each move, on the same write path the game was played on — the real
`apply-action`/`undo-action`/`redo-action` Edge Functions for a rule-enforced
game, or a direct `game_state` write for a client-trusted one — against a
Supabase stack that behaves like production: the migrations' Row Level
Security, `game_state`'s compare-and-swap `version`, the
`game_state_sync_meta` trigger and the gzipped-at-rest state encoding are all
in play (`src/test/supabaseStack/`). The test then asserts the game ends
exactly where production ended it, final score and winner included.

The only pieces that are test doubles are Postgres and the Deno Edge Runtime
themselves, so this runs on a plain Node CI runner with no Docker. For the
remaining fidelity — a real Postgres running the actual migration SQL, and
the functions on the real Edge Runtime — bring up the local stack with
`supabase start` && `supabase db push` && `supabase functions serve` (see
`supabase/config.toml`).

See `src/test/fixtures/productionGames/README.md` for what gets asserted,
what the loader infers about a game's room row, and how to override it.

## Smoke-testing the live deployment

`npm run test` verifies the code against an in-process stack. It cannot tell
you whether a migration actually applied, an Edge Function actually deployed,
or a policy was edited in the dashboard. `npm run test:smoke` does: it
replays the same real games against the **live** Supabase project, through the
deployed `apply-action`/`undo-action`/`redo-action` functions, and checks each
one finishes on the score and winner it finished on in production.

```bash
SMOKE_SUPABASE_URL=https://<project-ref>.supabase.co \
SMOKE_SUPABASE_ANON_KEY=<anon key> \
SMOKE_SUPABASE_SERVICE_ROLE_KEY=<service role key> \
npm run test:smoke
```

`.github/workflows/smoke.yml` runs it after every successful
Supabase deploy, nightly, and on demand — add `SMOKE_SUPABASE_ANON_KEY` and
`SMOKE_SUPABASE_SERVICE_ROLE_KEY` as repository secrets and it works (the URL
falls back to the `SUPABASE_PROJECT_ID` secret the deploy workflow already
uses).

It writes to production, so each run works in an isolated, private `live`-mode
room owned by throwaway accounts it deletes afterwards, and can never page a
real player (both notification functions only fire for `async` games). See
`src/test/productionSmoke/README.md` for the full isolation story, which games
are eligible, and the per-run cost.

## Testing without Discord OAuth set up

Set `VITE_ALLOW_GUEST_AUTH=true` (see `.env.example`) to show a "Continue
as guest (testing)" button next to the Discord one. It uses Supabase's
built-in anonymous sign-in, which produces a real session/`auth.uid()`, so
RLS and the rest of the app work exactly as with a Discord identity — the
only difference is the display name (`Guest 1234`) and no persistent
account across browsers/devices.

This requires **Authentication → Sign In / Providers → Allow anonymous
sign-ins** to be enabled in the Supabase dashboard (off by default).

Leave `VITE_ALLOW_GUEST_AUTH` unset in production — Discord sign-in is
meant to be mandatory there; this is a testing-only escape hatch.

## Hotseat identity — how it works

The original write-up here posed a choice between re-authenticating each
player every turn and holding several Supabase sessions in one browser at
once. What shipped is neither: **one signed-in host seats several named
local players under their own account.**
`0003_hotseat_local_players.sql` dropped the old
`unique (game_id, user_id)` constraint so several `players` rows can share
one `user_id` (`unique (game_id, seat_index)` still keeps seats distinct),
and the host adds them in the lobby with `addLocalPlayer()`
(`src/lib/gameApi.ts`). No player but the host ever signs in, and there is
no multi-session juggling.

In game, `GamePage.tsx` makes "which player is this browser acting as"
follow whoever must act next (`currentActorId`, `src/engine/turnOrder.ts`)
rather than a fixed identity, and puts a **"pass the device"
confirmation** in front of each handover so the next player doesn't see the
previous one's hand. A game can opt out of that gate
(`settings.skipHotseatPassGate`) when players don't care about hiding
information from each other.

The same "act as whoever is pending" mechanism is what admin mode reuses
for live/async games, where a room owner or site admin can take a turn on
behalf of the player the game is waiting on.

## Debugging: game state export

Every in-progress game's menu (the hamburger icon top-left of `GamePage`)
has a **"Copy game export"** action that copies a small JSON file to the
clipboard — useful for attaching to a bug report, pasting into a chat, or
inspecting a specific game's state without going through Supabase.

The file is real JSON (open it in any editor, `JSON.parse` it, or save it
as `whatever.json`) with this shape — see
`src/lib/gameStateExport.schema.json` for the full JSON Schema:

```json
{
  "schema": "rise-and-fall/game-state-export",
  "version": 1,
  "exportedAt": "2026-08-15T22:00:00.000Z",
  "gameStateZipped": "H4sIAAAAAAAAA6tWKknMzs..."
}
```

`schema`/`version` identify the file and its format; `exportedAt` is when
it was generated. The actual game state lives in `gameStateZipped` —
gzip-compressed then base64-encoded, since a real game state is tens of
KB pretty-printed and that would otherwise dominate the file. To get the
state back out:

- **In this codebase**: `decodeGameStateExport(text)` from
  `src/lib/gameStateExport.ts` parses the file, decompresses
  `gameStateZipped`, and returns `{ schema, version, exportedAt, gameState }`
  with `gameState` as a fully-typed `engine.GameState` (`src/engine/types.ts`).
- **From the command line**, with `jq` and `gzip` installed:
  ```sh
  jq -r .gameStateZipped export.json | base64 -d | gunzip
  ```
- **In any language with gzip + base64 support**: base64-decode
  `gameStateZipped`, then gunzip the result — you get back the
  `JSON.stringify`'d `GameState`.

There's also a **"Show game state JSON"** toggle in the same menu that
prints the current state as plain (uncompressed) pretty-printed JSON
inline in the page, for quick eyeballing without decoding anything.

## Server-side rule enforcement

By default a game is *client-trusted*: each client runs the engine itself
and writes the resulting `game_state` row directly, with the `version`
column providing compare-and-swap concurrency. That is fine among friends
but takes every client at its word.

The create-game screen no longer offers a choice here (issue #552, after the
enforced path ran checked-by-default with no surprises since issue #432):
every game it creates has `settings.ruleEnforcementEnabled` on, switching it
onto the `apply-action` / `undo-action` / `redo-action` Edge Functions
instead of the client-trusted path. The client submits the raw *action*, and
the server resolves the caller's seat from their JWT, refuses any action
naming somebody else's seat, re-derives the state with the same engine code
the client bundles, and does its own compare-and-swap write.
`0026_rule_enforcement_flag.sql` makes RLS reject direct `game_state` writes
for these games, so the Edge Functions are the only way in. Their state is
also stored gzipped.

The flag is per game and fixed at creation, and every game created before it
existed (or before issue #432 flipped its now-removed checkbox to
checked-by-default) reads as off, so no in-progress game was affected by
either change; `createGame()`'s own default for any caller that omits the
flag (tests included) is still off. Both paths are exercised by the test
suite. See `RULE_ENFORCEMENT_PLAN.md` for the design and
`HIDDEN_INFORMATION_PLAN.md` for the still-open read-side half (server-side
redaction of other players' secrets — today's redaction runs client-side, so
an opponent's still-secret card pick is hidden in the UI but present in the
row the client fetched).

Hiding in-progress card picks (`settings.hiddenInformationEnabled`) is
likewise no longer a checkbox (issue #552, after issue #481's
checked-by-default checkbox ran with no surprises): it's on automatically
for every non-hotseat game, since rule enforcement — a prerequisite — is now
always on too. Hotseat never gets it, checkbox or not: one shared login
across every local seat makes per-seat masking actively wrong there
(`src/lib/hiddenInformationEligibility.ts`).

The create-game screen's one remaining checkbox in this area, **"Lock a card
pick once revealed"** (`settings.lockRevealedInformationEnabled`, issue
#529), is now **checked by default** too (issue #552, once the two defaults
above had run without surprises) but can still be unchecked. It closes one
remaining gap: normally, undo lets even the player who resolved a
simultaneous `selectCards`/`decline` phase (the last one pending) go back
and change their own pick after everyone's has already been revealed, since
only their own move needs discarding. With this on, that also needs the
room-owner/admin-mode override that undoing *another* player's move already
requires (`RULE_ENFORCEMENT_PLAN.md` §4.4/§4.5).

## What's built

The game is complete end to end and being played: create or join a room,
build the map, play the round cycle, and finish with a scored end-game
screen.

- **Rules engine** (`src/engine/`, ~8k lines + ~1100 tests): board setup,
  all six unit kinds and their actions (create/transform/convert/income/
  produce/trade/trade-resource/move), cliffs and terrain movement,
  resources and the shared bank, the four-phase round cycle
  (select cards → actions → decline → purchase), achievements, elimination,
  concede, all five VP sources, win determination, and event-sourced
  undo/redo with history review.
- **Board setup**: the real tier-by-tier tile-laying procedure with
  rotation, legality and no-space checks, auto-placement of forced
  arrangements, then starting-unit placement — or skip it with a map
  template, a saved map from the map pool, or a random map.
- **Full game UI**: an SVG hex board with terrain, cliff edges, unit
  pictograms and per-unit action targeting; hand/round/phase panels; a
  narrated game log; per-player score breakdowns; the end-game screen; and
  a map builder plus admin screens for maps and rooms.
- **All three play modes**, including hotseat with the pass-the-device gate
  (above) and admin mode for taking a turn on someone's behalf.
- **Accounts and identity**: Discord and Google OAuth, email/password with
  reset, opt-in guest sign-in for testing, custom display names, per-user
  colour and display preferences, and a confirm-before-revealing-cards
  option for the select-cards/decline phases (default on).
- **Turn notifications**: Discord webhooks and Web Push, both sent
  server-side by Edge Functions so they fire with every tab closed.
- **PWA**: installable, with a custom service worker and an update banner
  when a newer build is live.
- **Server-side rule enforcement**, on by default with no opt-out for new
  games (above).
- **Testing**: the engine suite, component tests, an in-process Supabase
  stack that behaves like production, and real games replayed as regression
  tests.

## What's not built yet

- **Server-side redaction** (`HIDDEN_INFORMATION_PLAN.md` phase 5): a
  `get_game_state` read path that strips other players' secrets before they
  reach the client. Redaction exists and is tested, but runs client-side.
- **Guilds variant** and the remaining 18 Tales — `VARIANTS_PLAN.md` has the
  full design; five Tales (Capital, Majestic Bridge, Banks, Ports,
  Cathedral) are implemented.
- **ELO ratings** — designed in `ELO_SYSTEM_PLAN.md`, not started.
- **An accessibility pass** (keyboard navigation, contrast, focus states).
- **End-to-end verification of enforcement and redaction in a real
  two-browser session** against a deployed project — the in-process stack
  covers the same checks, but not the real Edge Runtime or a real browser.

Ongoing work is tracked as numbered entries in `todo.md`, which doubles as
the project's changelog.
