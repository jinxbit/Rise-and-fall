# Rise & Fall

A private, non-commercial web app for playing an original real-time strategy
board game with a small group of friends — remotely, async, or on one
shared device. Built for personal use only.

This is an **original implementation**: all code, UI, and copy here are
written from scratch. No third-party rulebook text, card text, or artwork is
reproduced.

## Stack

- **Frontend:** Vite + React + TypeScript, Tailwind CSS v4
- **Backend:** Supabase (Postgres for game state, Realtime for live sync, Auth with Discord OAuth for identity)
- **Hosting:** Vercel (frontend) + Supabase free tier (backend)

## Architecture

- `src/engine/` — the rules engine. Pure TypeScript, zero React/Supabase
  imports, fully unit-testable. Everything else in the app treats
  `GameState` as opaque and only mutates it by calling `applyAction()` here.
- `src/lib/` — Supabase client, auth helpers, and typed query functions
  (`gameApi.ts`) that read/write the `games` / `players` / `game_state`
  tables.
- `src/pages/` + `src/components/` — the UI: lobby (create/join by room
  code, pick play mode) and a placeholder in-game board view.
- `supabase/migrations/` — SQL migrations, run manually in the Supabase SQL
  editor (see below).

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
- **Hotseat:** one device, players take turns in person. See the tradeoff
  note below — the switching mechanism itself isn't built yet.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project values
npm run dev
```

Other scripts:

```bash
npm run test    # run the rules-engine test suite (vitest)
npm run lint    # oxlint
npm run build   # typecheck + production build
```

If `.env.local` isn't set up yet, the app renders a "Configuration error"
message instead of a blank screen — that's expected until you complete the
Supabase setup below.

## Supabase setup (do this yourself)

1. Create a new project at [supabase.com](https://supabase.com).
2. In the SQL editor, run `supabase/migrations/0001_init_schema.sql`. It
   creates `games`, `players`, and `game_state` (one JSON-state row per
   game, with a `play_mode` column on `games`), sets up Row Level Security
   so only seated players can read/write a game's state, and adds all three
   tables to the `supabase_realtime` publication.
3. Copy your project's **Project URL** and **anon public key** (Settings →
   API) into `.env.local` as `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY`.

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
   supabase secrets set SITE_URL=https://your-deployed-site.example
   ```
   `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are provided automatically at
   runtime; `DISCORD_NOTIFY_WEBHOOK_SECRET` is a value you choose, used to
   confirm requests actually came from your project's Database Webhook.
   `SITE_URL` is optional — when set, the ping links straight to the game
   (`SITE_URL/game/<room_code>`); without it, the message just names the
   room code instead of a link.
3. In the Supabase dashboard: **Database → Webhooks → Create a new hook**.
   - Table: `game_state`. Events: `Update`.
   - Type: **Supabase Edge Functions**, targeting `notify-discord-turn`.
   - Add an HTTP header `x-webhook-secret` set to the same value as
     `DISCORD_NOTIFY_WEBHOOK_SECRET` above.

See `supabase/functions/notify-discord-turn/index.ts`'s doc comment for how
the function decides who to ping.

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

## Hotseat identity — tradeoff to decide before it's built

The spec asks for one of two approaches for switching the active player on
a shared device:

- **A. Re-authenticate each turn.** Each player signs in with Discord when
  it becomes their turn (and signs out after). Simple to reason about —
  the Supabase session always matches "whose turn is it" — but adds an
  OAuth round-trip every single turn, which is friction for in-person play.
- **B. Pre-authenticate once, then switch in-app.** All participating
  players sign in with Discord once at game start (e.g. one after another
  in the same browser); the app then holds all their sessions/tokens
  locally and just switches which one is "active" as turns pass, no
  re-login. Smoother turn-to-turn, but requires the client to juggle
  multiple Supabase sessions at once (Supabase's JS client is built around
  one active session at a time, so this needs a small custom session-store
  layer instead of relying on the client's built-in session handling).

Milestone 1 only implements the play-mode picker (hotseat is selectable in
the lobby); the actual turn-switching mechanism is intentionally not built
yet. Recommendation: **B**, since in-person play is exactly the case where
turn-to-turn friction matters most — but it's your call, and it changes how
much auth-layer work the next milestone needs.

## What's built (milestone 1)

- Repo scaffold: Vite + React + TS + Tailwind v4.
- Rules engine skeleton (`src/engine/`): `Board`/`Tile`/`Unit`/`Player`/`Card`/`GameState`
  types, a typed `applyAction()` with `END_TURN` fully implemented (turn
  order, log, immutability) and `MOVE_UNIT`/`PLAY_CARD` as typed
  not-yet-implemented placeholders, plus `createNewGame`/`startGame`
  factories. 13 passing unit tests.
- Supabase schema + RLS policies for `games` / `players` / `game_state`.
- Supabase client, Discord OAuth sign-in/out, `useAuth()` hook.
- Lobby: create a game (pick play mode), join by room code, live player
  list via Realtime, host-gated "start game" button.
- Placeholder in-game board view rendering a hardcoded hex board from the
  engine's `Board` type, to confirm the data path from engine → UI works.

## What's stubbed / not yet built

- Actual board generation/drafting at game start (`startGame()` in the
  engine takes starting positions as a parameter — nothing calls it yet
  with a real drafted board).
- `MOVE_UNIT`, `PLAY_CARD`, and all other game actions/rules (unit
  abilities, card effects, cliffs-only movement, win conditions) — this is
  the bulk of the actual game and needs the detailed rules from you first.
- Hotseat turn-switching (see tradeoff above).
- Any real game UI beyond the placeholder board: unit sprites, tile
  interaction, hand of cards, action log display.

## Proposed next milestone

Once you've walked through the Discord OAuth setup and confirmed sign-in
works end to end:

1. Nail down the exact rules with you (unit stats/abilities, the full card
   list and their effects, cliff-traversal specifics, win conditions) and
   encode them as `MOVE_UNIT` / `PLAY_CARD` / etc. in `applyAction()`.
2. Build board generation/drafting for game start and wire it into
   `startGame()` from the lobby's "Start game" button.
3. Decide and build the hotseat identity approach from the tradeoff above.
4. Replace the placeholder board with real tile rendering + interaction
   (click a unit, see legal moves, click a card, see legal targets).
