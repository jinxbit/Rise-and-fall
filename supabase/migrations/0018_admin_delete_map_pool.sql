-- Admin override for map pool deletion (issue #185): lets the same
-- is_admin-flagged account from 0017_admin_delete_any_game.sql delete any
-- saved map from the pool. 0016_map_pool.sql only granted select/insert —
-- there's no owner-delete policy at all — so this admin policy is the only
-- way a map ever gets removed.

create policy "admins can delete any map from the pool"
  on public.map_pool for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.user_id = auth.uid()
        and profiles.is_admin
    )
  );
