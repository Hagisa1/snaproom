-- Allow album members to delete their own photo records.
-- Run this once in the Supabase SQL Editor for an existing project.

begin;

grant delete on public.shared_photos to authenticated;

drop policy if exists "Members can remove their own shared photos" on public.shared_photos;
create policy "Members can remove their own shared photos"
  on public.shared_photos for delete to authenticated
  using (
    uploaded_by = (select auth.uid())
    and exists (
      select 1 from public.album_members m
      where m.user_id = (select auth.uid())
    )
  );

commit;
