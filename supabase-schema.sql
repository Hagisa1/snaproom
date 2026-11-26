-- SnapRoom: single invite-only shared album
-- Run this script in the Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.album_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

create table if not exists public.album_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  invite_id uuid references public.album_invites(id) on delete set null,
  joined_at timestamptz not null default now()
);

create table if not exists public.shared_photos (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  uploaded_by uuid references auth.users(id) on delete set null,
  caption text not null default '' check (char_length(caption) <= 120),
  created_at timestamptz not null default now(),
  constraint shared_photos_uploader_path_match check (
    uploaded_by is null or storage_path like uploaded_by::text || '/%'
  )
);

create index if not exists shared_photos_created_at_idx
  on public.shared_photos (created_at desc);

-- Preserve photos from the earlier room-based version in the single album.
do $$
begin
  if to_regclass('public.photos') is not null then
    execute $migration$
      insert into public.shared_photos (id, storage_path, caption, created_at, uploaded_by)
      select id, storage_path, caption, created_at, null
      from public.photos
      on conflict do nothing
    $migration$;
  end if;
end
$$;

alter table public.album_invites enable row level security;
alter table public.album_members enable row level security;
alter table public.shared_photos enable row level security;

grant usage on schema public to authenticated;
revoke all on public.album_invites from public, anon, authenticated;
revoke all on public.album_members from public, anon, authenticated;
revoke all on public.shared_photos from public, anon, authenticated;
grant select on public.album_members to authenticated;
grant select, insert, delete on public.shared_photos to authenticated;

drop policy if exists "Members can view their own membership" on public.album_members;
create policy "Members can view their own membership"
  on public.album_members for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Members can view shared photos" on public.shared_photos;
create policy "Members can view shared photos"
  on public.shared_photos for select to authenticated
  using (
    exists (
      select 1 from public.album_members m
      where m.user_id = (select auth.uid())
    )
  );

drop policy if exists "Members can add their own shared photos" on public.shared_photos;
create policy "Members can add their own shared photos"
  on public.shared_photos for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and storage_path like (select auth.uid())::text || '/%'
    and exists (
      select 1 from public.album_members m
      where m.user_id = (select auth.uid())
    )
  );

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

-- The previous tables are retained for data preservation, but the old public
-- room/photo API is disabled. Their photo records were copied above.
do $$
begin
  if to_regclass('public.rooms') is not null then
    execute 'alter table public.rooms enable row level security';
    execute 'revoke all privileges on table public.rooms from public, anon, authenticated';
    execute 'drop policy if exists "Anyone can view rooms" on public.rooms';
    execute 'drop policy if exists "Anyone can create rooms" on public.rooms';
  end if;

  if to_regclass('public.photos') is not null then
    execute 'alter table public.photos enable row level security';
    execute 'revoke all privileges on table public.photos from public, anon, authenticated';
    execute 'drop policy if exists "Anyone can view photos" on public.photos';
    execute 'drop policy if exists "Anyone can add photos to existing rooms" on public.photos';
  end if;
end
$$;

-- Invitation tokens are random 256-bit values. Only their SHA-256 hashes are stored.
create or replace function public.create_album_invite()
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  token_value text;
begin
  token_value := encode(gen_random_bytes(32), 'hex');
  insert into public.album_invites (token_hash)
  values (encode(digest(convert_to(token_value, 'UTF8'), 'sha256'), 'hex'));
  return token_value;
end;
$$;

create or replace function public.join_album(p_invite_token text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  invite_record_id uuid;
begin
  if auth.uid() is null then
    raise exception 'ログインが必要です。' using errcode = '28000';
  end if;

  if p_invite_token is null or p_invite_token !~ '^[a-fA-F0-9]{64}$' then
    raise exception '招待リンクが無効か期限切れです。' using errcode = '28000';
  end if;

  select i.id into invite_record_id
  from public.album_invites i
  where i.token_hash = encode(digest(convert_to(p_invite_token, 'UTF8'), 'sha256'), 'hex')
    and i.revoked_at is null
    and (i.expires_at is null or i.expires_at > now())
  limit 1;

  if invite_record_id is null then
    raise exception '招待リンクが無効か期限切れです。' using errcode = '28000';
  end if;

  insert into public.album_members (user_id, invite_id)
  values (auth.uid(), invite_record_id)
  on conflict (user_id) do nothing;

  return true;
end;
$$;

create or replace function public.revoke_album_invite(p_invite_token text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_invite_token is null or p_invite_token !~ '^[a-fA-F0-9]{64}$' then
    return false;
  end if;

  update public.album_invites
  set revoked_at = coalesce(revoked_at, now())
  where token_hash = encode(digest(convert_to(p_invite_token, 'UTF8'), 'sha256'), 'hex')
    and revoked_at is null;

  return found;
end;
$$;

revoke all on function public.create_album_invite() from public, anon, authenticated;
revoke all on function public.join_album(text) from public, anon, authenticated;
revoke all on function public.revoke_album_invite(text) from public, anon, authenticated;
grant execute on function public.join_album(text) to authenticated;

-- Private image storage. Members can read the album; each member can only
-- upload or clean up files inside their own user-id folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'photo-wall',
  'photo-wall',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Anyone can view SnapRoom images" on storage.objects;
drop policy if exists "Anyone can upload to an existing SnapRoom" on storage.objects;
drop policy if exists "Album members can view photos" on storage.objects;
drop policy if exists "Album members can upload their own photos" on storage.objects;
drop policy if exists "Album members can remove their own uploads" on storage.objects;

create policy "Album members can view photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'photo-wall'
    and exists (
      select 1 from public.album_members m
      where m.user_id = (select auth.uid())
    )
  );

create policy "Album members can upload their own photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'photo-wall'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.album_members m
      where m.user_id = (select auth.uid())
    )
  );

create policy "Album members can remove their own uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'photo-wall'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.album_members m
      where m.user_id = (select auth.uid())
    )
  );

-- Keep the shared album's new photo records in Supabase Realtime.
do $$
begin
  alter publication supabase_realtime add table public.shared_photos;
exception
  when duplicate_object then null;
end
$$;
