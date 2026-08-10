-- Hotseat: multiple local players on one authenticated session/browser.
--
-- Previously every player row needed a distinct auth.users identity
-- (`unique (game_id, user_id)`), which meant "hotseat" mode was mechanically
-- no different from live/async — every physical player still had to sign in
-- separately, even sharing one device. For real pass-and-play, one signed-in
-- host now seats several named local players under their own user_id (see
-- addLocalPlayer in src/lib/gameApi.ts), so that per-game uniqueness has to
-- go; `unique (game_id, seat_index)` still guarantees no two players occupy
-- the same seat.
alter table public.players
  drop constraint if exists players_game_id_user_id_key;

-- Needed so the host can remove a local player they added by mistake before
-- the game starts (LobbyPage.tsx) — there was no delete policy on `players`
-- at all before this, so any delete attempt was silently denied by RLS's
-- default-deny.
create policy "users can delete their own player row"
  on public.players for delete
  to authenticated
  using (user_id = auth.uid());

comment on table public.players is
  'One row per seated player. Identity comes from Discord OAuth via auth.users; in hotseat mode several seats can share one user_id (one signed-in host, several local players passing the device).';
