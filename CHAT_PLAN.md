# Chat — Spec, Design & Execution Plan

Tracks [issue #466](https://github.com/jinxbit/Rise-and-fall/issues/466). This
is a **design document, not yet implemented** — no code in this repo
implements any of the below at the time this file is written. Once reviewed
and finalized, it is the source of truth for breaking the work into
independent GitHub issues, the same way `HIDDEN_INFORMATION_PLAN.md` and
`RULE_ENFORCEMENT_PLAN.md` serve their features. Update it as decisions
change.

## 1. Problem statement

Issue #466 asks for two chat surfaces:

1. **Site-wide chat** — one shared room, visible on the main page (`HomePage.tsx`),
   above the room lists.
2. **In-game chat** — one chat per game, visible at the top of `GamePage.tsx`.

Constraints from the issue, carried through this whole document:

- Only a signed-in, registered user may **post**. (Reading may be more or
  less permissive — see §2.)
- The feature must ship **disabled in production** until jinxbit flips it on
  deliberately, independent of `main` being promoted to `production`
  (`DELIVERY_PIPELINE_PLAN.md` §3/§4).
- Future, explicitly out of scope for the first cut: `@mention` direct
  messages with a notification, message reporting, and 30-day message
  retention. These are designed below (§7–§9) so the schema doesn't need to
  change shape later, but are not part of the initial execution phases.

Chat is **not a game rule**. It never touches `GameState`, never goes through
`applyAction()`, and is invisible to `src/engine/`, `replayActions`, or
either write path in `CLAUDE.md`'s "two write paths" section. It also carries
no rule-enforcement concern — there's nothing to cheat at by posting a
message — so unlike `game_state`, chat rows are ordinary client-writable
tables gated by RLS, the same trust model as `players`/`games` themselves.
This keeps the whole feature outside the four engine invariants entirely; no
`src/engine/` change is needed anywhere in this plan.

## 2. Scope, proposed

### Confirmed by the issue

- Two chats: one site-wide, one per game.
- Site-wide chat renders above the room lists on the main page.
- In-game chat renders at the top of the game page.
- Posting requires a signed-in, registered user (Discord/Google/email —
  same `useAuth()` session every other write already requires; guest-auth
  sessions, gated behind `VITE_ALLOW_GUEST_AUTH` and testing-only per
  `.env.example`, count as signed in the same way they do everywhere else in
  the app).
- Disabled in production until explicitly enabled (§4).

### Proposed defaults (flag for pushback during review)

- **Reading site-wide chat requires sign-in too.** `HomePage.tsx` already
  renders a completely different, room-list-free view for a signed-out
  visitor (the sign-in screen, `HomePage.tsx:93-116`) — there is no
  logged-out "rooms" view for site-wide chat to sit above in the first
  place, so gating its reads on session as well costs nothing and avoids
  having to moderate a chat surface strangers can read without an account.
- **Reading in-game chat matches who can currently see that game.** Same
  audience `game_state`/`players` already grant: seated players always, plus
  (for a `visibility: 'public'` room) any other signed-in visitor, per
  `0019_public_game_state_visible.sql`/`0021_remove_observers.sql`. No new
  audience concept is introduced.
- **Posting in-game chat is restricted to seated players.** A public room's
  non-seated visitor can read the board and, under this proposal, the chat,
  but not post to it. (Open question §10.1 if this is too restrictive —
  e.g. should a spectator be able to cheer someone on?)
- **One flat channel per surface, no threads/rooms-within-rooms.** Site-wide
  is a single global stream; each game has exactly one stream. No per-team
  or per-DM channels in the first cut (DMs are §8, a distinct future
  mechanism, not a "channel").
- **Hotseat games get in-game chat like any other game.** All local hotseat
  players share one `auth.uid()` (`0003_hotseat_local_players.sql`), so
  hotseat chat is really "notes from the one signed-in host to themselves"
  — harmless, and consistent with `HIDDEN_INFORMATION_PLAN.md`'s existing
  precedent of hotseat being out of scope for anything seat-distinguishing
  rather than specially blocked.

### Out of scope for the initial phases (designed for, not built — §7–§9)

- `@mention` direct messages and their notification.
- Message reporting.
- 30-day retention/deletion.
- Rich text, attachments, emoji reactions, read receipts, typing indicators.
- Per-game opt-out of chat (`games.settings` has room for this later —
  `CLAUDE.md`'s "add pregame toggles there, no migration needed" — but
  nothing in the issue asks for it yet).

## 3. Data model

One table serves both surfaces; a game-scoped row's `game_id` is set, a
site-wide row's is `null`. This avoids two near-identical tables and lets a
single component (§6) render either surface off the same shape.

```sql
create table public.chat_messages (
  id bigint generated always as identity primary key,
  game_id uuid references public.games(id) on delete cascade,  -- null = site-wide
  sender_id uuid not null references auth.users(id),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index chat_messages_game_id_created_at_idx
  on public.chat_messages (game_id, created_at);
```

Notes:

- `game_id` is nullable rather than two tables so RLS, indexing, and the
  future retention job (§9) are all one policy/query instead of two.
- `on delete cascade` means a deleted game takes its chat with it, matching
  how the rest of a game's rows already behave.
- No `updated_at`/edit support — chat messages are append-only, matching the
  "no fake-history" spirit of `actionHistory`'s own append-only rule
  (`CLAUDE.md` invariant 3), even though this table has nothing to do with
  replay. Editing is not requested by the issue.
- `sender_id`'s display name/avatar comes from `profiles`/`useDisplayName`
  exactly like every other player-identity lookup already in the app — no
  denormalized copy of the name onto the row.
- Soft-delete (a `deleted_at` or `hidden_at` column) is deliberately **not**
  added yet — it belongs to the reporting/moderation phase (§8) and adding
  it there, gated behind that phase's own migration, avoids an unused column
  sitting inert through the earlier phases.

### RLS sketch

```sql
alter table public.chat_messages enable row level security;

-- Site-wide (game_id is null): any signed-in user may read.
create policy "read site-wide chat"
  on public.chat_messages for select
  to authenticated
  using (game_id is null and public.chat_enabled());

-- In-game: same audience game_state grants today.
create policy "read game chat"
  on public.chat_messages for select
  to authenticated
  using (
    game_id is not null
    and public.chat_enabled()
    and exists (
      select 1 from public.games
      where games.id = chat_messages.game_id
        and (
          games.visibility = 'public'
          or exists (
            select 1 from public.players
            where players.game_id = games.id and players.user_id = auth.uid()
          )
        )
    )
  );

-- Post: site-wide needs only a session; in-game needs a seat.
create policy "post chat"
  on public.chat_messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and public.chat_enabled()
    and (
      game_id is null
      or exists (
        select 1 from public.players
        where players.game_id = chat_messages.game_id and players.user_id = auth.uid()
      )
    )
  );
```

`public.chat_enabled()` is the kill switch — see §4. No `update`/`delete`
policy exists yet (nothing needs one until reporting/moderation, §8).

## 4. The kill switch: "disabled until I enable it"

The issue's requirement is stronger than "hide the UI" — mirroring this
repo's own stance on hidden information (`HIDDEN_INFORMATION_PLAN.md` §5.4:
a client-side-only hide is "a UX guarantee, not a security one"), a modified
client must not be able to post or read chat while it's off, not just fail
to render a chat box.

**Proposed mechanism, following the existing `profiles.is_admin` precedent
almost exactly** (`0017_admin_delete_any_game.sql`'s own doc comment: "an
admin grants themselves the flag directly via SQL"):

```sql
create table public.app_config (
  id boolean primary key default true check (id),  -- singleton row
  chat_enabled boolean not null default false
);
insert into public.app_config (chat_enabled) values (false);

create function public.chat_enabled() returns boolean
  language sql stable security definer as
  $$ select chat_enabled from public.app_config limit 1 $$;

alter table public.app_config enable row level security;
create policy "anyone can read app_config"
  on public.app_config for select to authenticated using (true);
-- No insert/update/delete policy at all: nothing in the app can flip this
-- flag. jinxbit turns it on with one statement in the Supabase SQL editor:
--   update public.app_config set chat_enabled = true;
```

Why this over the alternatives considered:

- **A build-time `VITE_CHAT_ENABLED` env var** (the pattern
  `VITE_ALLOW_GUEST_AUTH`/`VITE_VAPID_PUBLIC_KEY` already use) would hide the
  UI, but Postgres RLS can't see a Vercel/Vite env var, so it can't be the
  *only* gate — something server-side still has to exist. It would also need
  a Vercel redeploy to flip, and would only gate the client, not a direct
  REST/RPC call. A DB-backed flag is strictly simpler: one gate, no
  redeploy, real server-side enforcement, and (since Preview and production
  are separate Supabase projects per `CLAUDE.md`'s deploy section) Preview
  can default to `true` for dogfooding while production stays `false`
  without any extra plumbing — each project's `app_config` row is
  independent by construction.
- **A per-request Edge Function gate** (route all chat writes through a
  `send-chat-message` function, the way rule-enforced games route through
  `apply-action`) would work but adds a Deno cold start and a whole
  Edge Function to a feature with no rules to enforce — RLS alone already
  fully expresses "signed in" and "seated in this game," so there is nothing
  an Edge Function would validate that a `with check` clause can't.
- The client reads `chat_enabled()` once (a cheap RPC call, or folded into
  whatever the client already fetches on load) and hides both chat surfaces
  entirely when false, so a normal user sees no trace of the feature — the
  RLS policies above are the actual guarantee; the UI hide is the ordinary
  courtesy layer on top, same relationship as every other belt-and-suspenders
  pair in this codebase.

This is a single global switch, not a per-game or per-environment
`games.settings` value — the issue asks to gate the *feature*, not any one
game.

## 5. Realtime delivery

New table added to the `supabase_realtime` publication, the same mechanical
step every existing Realtime-visible table already took
(`0001_init_schema.sql`, `0025_game_state_meta.sql`). Unlike `game_state`
(issue #448's motivation for `game_state_meta`'s slim broadcast — a `GameState`
row is routinely ~200kb), a chat row is a few hundred bytes at most, so there
is no bandwidth reason to split "broadcast" from "fetch": the client
subscribes directly to `postgres_changes` INSERT events on `chat_messages`
(filtered `game_id=eq.<id>` for in-game, `game_id=is.null` for site-wide) and
appends the new row straight from the payload, no follow-up fetch needed.

## 6. UI placement

- **Site-wide** (`HomePage.tsx`): a new `<ChatPanel gameId={null} />` section
  placed right after the header/banners and before the "Create a game" /
  "Join by code" section (`HomePage.tsx:194` today) — i.e. "before the
  rooms" per the issue, since everything from `roomEntries` down (line 219
  onward) is the room lists. Only rendered once `chat_enabled()` is true and
  a session exists (§2).
- **In-game** (`GamePage.tsx`): a new `<ChatPanel gameId={game.id} />` at the
  very top of the returned JSX (`GamePage.tsx:1520` today, ahead of the
  room-header row at line 1535), collapsible/dismissible so it doesn't push
  the board below the fold on small screens — the existing mobile pass
  (`PROJECT_PLAN.md` §5) already had to solve exactly this problem for the
  history bar.
- A single shared `ChatPanel` component (`src/components/ChatPanel.tsx`)
  parameterized by `gameId: string | null`, backed by a small `chatApi.ts`
  in `src/lib/` (list + subscribe + post), mirroring the existing
  `gameApi.ts` shape. No engine involvement, so no new content JSON, no
  `resolveContent.ts` entry.

## 7. Future: `@mention` direct messages + notification

Not built now; recorded so §3's schema doesn't need to change shape later.

- Parsing `@name` in `body` client-side to render a mention as a link/pill;
  the stored `body` stays plain text (no markup format decided yet — see
  open question §10.2).
- A notification on mention reuses the existing pattern exactly:
  `notify-discord-turn`/`notify-web-push` already fire off a Supabase
  Database Webhook on a table event (`game_state` UPDATE today). A
  `chat_messages` INSERT webhook triggering new
  `notify-discord-mention`/`notify-web-push-mention` functions — Deno
  near-duplicates of the existing two, per those files' own doc comments
  ("Edge Functions can't import the app's Vite-aliased TypeScript sources")
  — needs no new notification infrastructure, only new trigger wiring and
  functions.
- This is naturally a **direct message**, not a broadcast: the notification
  should go only to the mentioned user, unlike today's turn notification
  which already targets a single "whose turn is it" recipient — so the
  existing per-recipient lookup logic in `notify-web-push`/`notify-discord-turn`
  is directly reusable, just keyed off the parsed mention instead of
  `pendingActorIds`.

## 8. Future: reporting

Not built now.

- A `chat_message_reports` table (`message_id`, `reporter_id`, `reason`,
  `created_at`), insert-only by any authenticated user, readable only by
  `profiles.is_admin` — same shape as the `is_admin` precedent in §4.
- An admin review surface, likely a new `/admin/chat-reports` page mirroring
  `AdminMapsPage.tsx`'s existing `is_admin`-gated pattern
  (`useIsAdmin(session?.user ?? null)`), from which an admin can delete a
  message (needs the `delete` RLS policy §3 deliberately deferred) or
  dismiss the report.
- Whether a reported message auto-hides pending review, or stays visible
  until an admin acts, is an open question (§10.3) — this document doesn't
  pre-decide it since the issue only asks that reporting exist eventually,
  not how aggressive it should be.

## 9. Future: 30-day retention

Not built now. This repo has no existing cron/scheduled-job infrastructure
inside Supabase itself (no `pg_cron` usage in any migration) — the one
precedent for "something runs on a schedule" is `.github/workflows/smoke.yml`,
a GitHub Actions cron. The natural fit is the same shape:

- A new scheduled workflow (or an addition to an existing nightly one) that
  invokes a `cleanup-old-chat-messages` Edge Function (service-role client,
  same trust level as `start-game`/`apply-action`'s service-role writes)
  which runs `delete from chat_messages where created_at < now() - interval
  '30 days'`.
- Alternatively, a plain SQL `security definer` RPC callable the same way,
  if no other logic is needed beyond the delete — simpler than a whole Edge
  Function for a one-line query, at the cost of being one more RPC to
  remember exists. Leaning Edge Function only for consistency with how every
  other scheduled/service-role action in this repo is already exposed, but
  this is a genuinely open, low-stakes implementation choice (§10.4).

## 10. Open questions

Everything else in this document is a proposed default, not a request for a
decision — flag it in review if any default is wrong. These four are
genuine unknowns this document can't resolve on its own:

1. **Can a public room's non-seated visitor post in-game chat, or only
   read it?** §2 proposes read-only for a visitor, post-only-if-seated.
   Confirm or override.
2. **Mention syntax and rendering** (`@name` vs `@userid`, plain-text
   storage vs. some markup) — needed before §7 is scoped into an issue, not
   needed for the initial phases.
3. **Does a report auto-hide the message, or only flag it for review?** —
   needed before §8 is scoped into an issue.
4. **Cleanup job: Edge Function vs. plain SQL RPC** for §9 — low-stakes,
   pick whichever is easier to wire into a scheduled workflow when that
   phase starts.

## 11. Execution plan

Each numbered item below is meant to become one independent GitHub issue,
sized so later ones don't block earlier ones from shipping and being used.
1 must land before 2/3; 2 and 3 can then proceed independently of each
other; 4–6 (all "future" scope, §7–§9) each depend only on 1–3, not on each
other.

1. **Schema + kill switch.** `chat_messages` table, its RLS policies (§3),
   the `app_config`/`chat_enabled()` kill switch (§4), added to the
   `supabase_realtime` publication (§5). No UI yet. Testable entirely via
   `src/test/supabaseStack/` the same way every other RLS policy in this
   repo is (real Postgres-equivalent policy checks, no Docker needed) —
   see `CLAUDE.md`'s Testing section.
2. **Site-wide chat UI.** `chatApi.ts`, `ChatPanel.tsx`, wired into
   `HomePage.tsx` above the room lists (§6), gated on `chat_enabled()` and
   session.
3. **In-game chat UI.** `ChatPanel.tsx` reused with a `gameId`, wired into
   `GamePage.tsx` at the top (§6), collapsible for mobile.
4. **(Future) `@mention` + notification** (§7) — needs open question §10.2
   answered first.
5. **(Future) Reporting** (§8) — needs open question §10.3 answered first.
6. **(Future) 30-day retention job** (§9) — needs open question §10.4
   answered first.

Phases 4–6 are intentionally not started until jinxbit confirms scope/timing
on this document, per the issue's own "Future" heading treating them as
later work, not part of the initial delivery.

## 12. Testing strategy

- **RLS/data-layer:** `src/test/supabaseStack/` integration tests covering
  every policy in §3–§4 — signed-out reject, wrong-seat reject, kill-switch
  off reject, kill-switch on + correct seat accept — the same style already
  used for `game_state`'s RLS (`getGameState.test.ts`,
  `writePathRedaction.test.ts`).
- **Component-level:** `ChatPanel.tsx` behavior (render, submit, Realtime
  append) via `@testing-library/react`, this repo's existing pattern for
  UI components with no engine logic behind them.
- No engine tests are needed anywhere in this feature — by design (§1), it
  never touches `src/engine/`.
