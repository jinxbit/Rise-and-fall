-- Web Push subscriptions for async "your turn" notifications, sent the same
-- way the Discord ping is (see 0013_discord_notify_backend.sql): a Supabase
-- Edge Function with the service-role key does the sending, so browsers
-- never need to read another player's subscription — only their own.
--
-- One row per browser/device (a player may have several), keyed by the
-- push endpoint the browser's PushManager hands back.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

comment on table public.push_subscriptions is 'Web Push subscriptions (one per browser/device) used to send async "your turn" notifications server-side.';

create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

create policy "users can read their own push subscriptions"
  on public.push_subscriptions for select
  to authenticated
  using (user_id = auth.uid());

create policy "users can insert their own push subscriptions"
  on public.push_subscriptions for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "users can delete their own push subscriptions"
  on public.push_subscriptions for delete
  to authenticated
  using (user_id = auth.uid());
