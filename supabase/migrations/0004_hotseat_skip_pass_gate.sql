-- Hotseat: optionally skip the "pass the device" confirmation gate.
--
-- 0003_hotseat_local_players.sql made hotseat mode actually usable
-- pass-and-play on one device; GamePage.tsx shows a "Pass the device to
-- <Name> — continue" interstitial before every local player's turn. Some
-- groups don't want that extra tap every single turn (e.g. players who
-- trust each other not to peek), so this is a per-game, creation-time
-- choice (see HomePage.tsx) rather than something forced on everyone.
alter table public.games
  add column if not exists skip_hotseat_pass_gate boolean not null default false;

comment on column public.games.skip_hotseat_pass_gate is
  'Hotseat only: when true, GamePage.tsx skips the "pass the device" confirmation gate between local players'' turns and just shows whoever must act next directly. Set at game creation (HomePage.tsx); irrelevant for live/async.';
