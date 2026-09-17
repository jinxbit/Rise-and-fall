-- Bandwidth reduction on the games-listing queries (issue #620):
-- HomePage.tsx/PublicRoomsPage.tsx/MyGamesPage.tsx/AdminRoomsPage.tsx all
-- fetch `games.settings` for every listed room (gameApi.ts's
-- GAME_LIST_COLUMNS), which embeds a full `Board` for a map-pool game
-- (`settings.mapPoolBoard` — dbTypes.ts's GameSettings comment), tens of KB
-- re-downloaded on every list refresh even though no listing card ever reads
-- its contents — only its *presence*, via mapBuildStyleLabel's truthiness
-- check (gameCardView.ts). `settings.mapPoolMapId` ("which map_pool row
-- mapPoolBoard came from, for display only" — set alongside mapPoolBoard
-- everywhere it's written, CreateGamePage.tsx/LobbyPage.tsx) already carries
-- that same signal, so mapBuildStyleLabel now reads that instead and this
-- migration lets the listing queries null out mapPoolBoard itself.
--
-- A PostgREST "computed column" (a function taking the table's row type as
-- its sole argument, selectable as if it were a plain column, aliased back
-- to `settings` in the select list) rather than a generated column or a
-- view, so single-room reads (getGameByRoomCode et al.) are untouched and
-- keep using a plain `select()` that still returns the real mapPoolBoard.
create or replace function public.games_settings_for_listing(public.games)
returns jsonb
language sql
stable
as $$
  select jsonb_set($1.settings, '{mapPoolBoard}', 'null'::jsonb)
$$;

comment on function public.games_settings_for_listing(public.games) is
  'games.settings with mapPoolBoard (a full Board, tens of KB) nulled out. Used by the games-listing queries (gameApi.ts''s GAME_LIST_COLUMNS) in place of the plain settings column — see this migration''s header comment and gameCardView.ts''s mapBuildStyleLabel.';
