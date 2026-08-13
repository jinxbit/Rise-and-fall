-- Room visibility: Public vs Private rooms, plus the Public Rooms discovery
-- screen — see the "Online Game Room Specification" issue (#40), sections 4
-- (Room Visibility) and 5 (Public Rooms Screen).
--
-- No RLS changes needed for reading: 0001_init_schema.sql's "games are
-- readable by any signed-in user" policy already allows any authenticated
-- user to select any game row (that's how joining-by-room-code already
-- works). Every room today is already the spec's "Private Room" in effect —
-- reachable only by knowing its room code/link, never listed anywhere. This
-- migration adds an explicit `visibility` column so a room can opt into
-- being *listed* on the Public Rooms screen; it doesn't change who can read
-- a room's row once they know its id/code (issue section 4: "Link
-- possession is the mechanism for access, not necessarily authentication or
-- security"). Writing `visibility` is already Owner-gated by 0008's
-- "room owner can update their game" policy.

alter table public.games
  add column if not exists visibility text not null default 'private'
    check (visibility in ('public', 'private'));

comment on column public.games.visibility is
  'Public rooms are listed on the Public Rooms screen (issue #40 section 5); private rooms are reachable only via their room code/link. Owner-only to change, via the existing "room owner can update their game" RLS policy.';

-- Speeds up the Public Rooms screen's listing query (visibility = 'public'),
-- without bloating the index with the (much more common) private rows.
create index if not exists games_public_idx on public.games (updated_at desc) where visibility = 'public';
