-- Chat rate limit (issue #605): a server-side defense against a signed-in
-- user flooding chat_messages (site-wide and/or in-game) by scripting
-- inserts directly, bypassing any client-side throttle. Two of the issue's
-- three concerns are already covered without a schema change: oversized
-- messages by chat_messages' own `char_length(body) between 1 and 2000`
-- check (0031_chat_messages.sql), and harmful content by ChatPanel.tsx
-- rendering `body` as a plain JSX text child (React-escaped, never
-- `dangerouslySetInnerHTML`) with no markup/rich-text interpretation
-- (CHAT_PLAN.md §2). This migration closes the third: nothing today limits
-- how often one sender can post.
--
-- Enforced with a BEFORE INSERT trigger rather than folded into the "post
-- chat" RLS policy (0031_chat_messages.sql) so a rejection raises a plain,
-- readable Postgres exception (surfaced verbatim by toAppError/ErrorBanner
-- on the client, src/lib/errors.ts) instead of RLS's generic "new row
-- violates row-level security policy" — same reasoning as this repo's
-- existing status-transition triggers (0008_room_lifecycle.sql,
-- 0029_start_game_edge_function.sql) over a check constraint or policy.
-- Applies to both surfaces together (site-wide and every game combined,
-- keyed only by sender_id) rather than per-channel, so switching channels
-- can't be used to dodge the limit.
--
-- Threshold (10 messages per rolling 10 seconds) is a proposed default, not
-- a tuned value — see CHAT_PLAN.md's new "DOS/abuse defenses" section.
-- Flag for pushback during review if it's too strict/loose for real play.

create index if not exists chat_messages_sender_id_created_at_idx
  on public.chat_messages (sender_id, created_at);

create or replace function public.chat_messages_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count integer;
begin
  select count(*) into recent_count
  from public.chat_messages
  where sender_id = new.sender_id
    and created_at > now() - interval '10 seconds';

  if recent_count >= 10 then
    raise exception 'You are sending messages too fast. Wait a few seconds and try again.';
  end if;

  return new;
end;
$$;

drop trigger if exists chat_messages_rate_limit_trigger on public.chat_messages;

create trigger chat_messages_rate_limit_trigger
  before insert on public.chat_messages
  for each row execute function public.chat_messages_rate_limit();

comment on function public.chat_messages_rate_limit() is
  'Chat DOS defense (issue #605): rejects an insert once its sender has posted 10+ messages (site-wide and in-game combined) in the trailing 10 seconds. Real server-side enforcement, not a UX-only client throttle — a modified client hits this the same as the normal UI.';
