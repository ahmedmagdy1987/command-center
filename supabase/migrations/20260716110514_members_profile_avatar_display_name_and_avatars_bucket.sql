-- Profile fields on members (avatar_url/bio/status_text/status_emoji) + impersonation hardening on
-- status_text, status_emoji AND display_name via the shared private._looks_like_role_title (NFKC-folds
-- fullwidth/mathematical + strips zero-width/spacing, blocks role/authority titles; status_emoji is
-- emoji-only including letter-like symbols). display_name is change-gated (existing values grandfathered)
-- and handle_new_user sanitizes its OAuth-derived name so signup can NEVER fail on the new rule. The
-- workspace_members_list roster RPC is recreated ONCE to expose the new fields, preserving the 4 original
-- columns + guest email/bio NULL + guest row-scoping. avatar_url is STORAGE-HOSTED ONLY (our public avatars
-- bucket) -> closes the cross-viewer tracking-pixel vector; the avatars bucket + own-folder write policies
-- ship here (no broad SELECT policy: a public bucket serves via the CDN URL without one, and a broad SELECT
-- would trip the public_bucket_allows_listing advisor). Proven: profile_and_avatar_rolled_back_proof.sql (40/40).
alter table public.members
  add column if not exists avatar_url    text,
  add column if not exists bio           text,
  add column if not exists status_text   text,
  add column if not exists status_emoji  text;

create or replace function private._looks_like_role_title(p_text text) returns boolean
language sql immutable set search_path to '' as $fn$
  select p_text is not null
    and regexp_replace(lower(normalize(p_text, NFKC)), '[^a-z0-9]', '', 'g')
          ~ '(owner|admin|administrator|moderator|superadmin|sysadmin|superuser|founder|official|staff|verified)';
$fn$;
revoke all on function private._looks_like_role_title(text) from public, anon, authenticated;

create or replace function public.members_validate_profile() returns trigger
language plpgsql security definer set search_path to '' as $fn$
begin
  -- display_name: re-validate only when it changes (grandfather existing values) or on INSERT
  if (tg_op = 'INSERT' or new.display_name is distinct from old.display_name) and new.display_name is not null then
    if length(new.display_name) > 60 then
      raise exception 'display name is too long (max 60 characters)' using errcode = '22023';
    end if;
    if private._looks_like_role_title(new.display_name) then
      raise exception 'display name may not impersonate a role or title' using errcode = '42501';
    end if;
  end if;

  if new.status_text is not null then
    if length(new.status_text) > 80 then
      raise exception 'status is too long (max 80 characters)' using errcode = '22023';
    end if;
    if private._looks_like_role_title(new.status_text) then
      raise exception 'status may not impersonate a role or title' using errcode = '42501';
    end if;
  end if;

  if new.status_emoji is not null and length(btrim(new.status_emoji)) > 0 then
    if length(new.status_emoji) > 16 then
      raise exception 'status emoji is too long' using errcode = '22023';
    end if;
    if normalize(new.status_emoji, NFKC) ~ '[[:alnum:]]'
       or new.status_emoji ~ '[①-⓿㈀-㋿\U0001F100-\U0001F1E5\U0001F130-\U0001F189]' then
      raise exception 'status emoji must be an emoji, not letters or letter-like symbols' using errcode = '22023';
    end if;
  end if;

  if new.bio is not null and length(new.bio) > 280 then
    raise exception 'bio is too long (max 280 characters)' using errcode = '22023';
  end if;

  if new.avatar_url is not null and length(btrim(new.avatar_url)) > 0 then
    if length(new.avatar_url) > 2048 then
      raise exception 'avatar_url is too long' using errcode = '22023';
    end if;
    -- storage-hosted ONLY: must be an object in OUR public avatars bucket (project ref hardcoded).
    if new.avatar_url !~ '^https://nqlzjuxqgajeoypyzlnv\.supabase\.co/storage/v1/object/public/avatars/' then
      raise exception 'avatar_url must be an uploaded avatar (storage-hosted)' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$fn$;
revoke all on function public.members_validate_profile() from public, anon, authenticated;

drop trigger if exists members_validate_profile on public.members;
create trigger members_validate_profile
  before insert or update on public.members
  for each row execute function public.members_validate_profile();

-- writable profile columns (identity columns stay locked by members_lock_identity + no grant)
grant update (avatar_url, bio, status_text, status_emoji) on public.members to authenticated;

-- handle_new_user: sanitize the derived display_name so signup NEVER fails on the new rule
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path to '' as $fn$
declare
  member_count integer;
  v_name text;
begin
  select count(*) into member_count from public.members;
  v_name := coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'), ''), split_part(new.email, '@', 1));
  if v_name is null or btrim(v_name) = '' or private._looks_like_role_title(v_name) then
    v_name := split_part(new.email, '@', 1);
  end if;
  if v_name is null or btrim(v_name) = '' or private._looks_like_role_title(v_name) then
    v_name := 'member';
  end if;
  v_name := left(v_name, 60);
  insert into public.members (id, email, display_name, role)
  values (new.id, new.email, v_name, case when member_count = 0 then 'owner' else 'member' end);
  return new;
end;
$fn$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ONE roster-RPC recreate: preserve 4 cols + guest scoping, append the 4 new cols (return type changes,
-- so DROP + CREATE). Guests: email + bio NULL; avatar/status shown. Row-scoping unchanged.
drop function if exists public.workspace_members_list(uuid);
drop function if exists private._workspace_members_list(uuid);

create function private._workspace_members_list(p_workspace_id uuid)
returns table(user_id uuid, display_name text, email text, role text,
              avatar_url text, bio text, status_text text, status_emoji text)
language sql security definer set search_path to '' as $fn$
  with caller as (select auth.uid() as uid, private.workspace_role(p_workspace_id) as r)
  select wm.user_id, m.display_name,
         case when (select r from caller) = 'guest' then null else m.email end,
         wm.role, m.avatar_url,
         case when (select r from caller) = 'guest' then null else m.bio end,
         m.status_text, m.status_emoji
  from public.workspace_members wm
  join public.members m on m.id = wm.user_id
  where wm.workspace_id = p_workspace_id
    and private.is_workspace_member(p_workspace_id)
    and (
      (select r from caller) is distinct from 'guest'
      or wm.user_id = (select uid from caller)
      or exists (select 1 from public.tasks t
                 where t.workspace_id = p_workspace_id
                   and (select uid from caller) in (t.created_by, t.assignee_id)
                   and wm.user_id in (t.created_by, t.assignee_id))
      or exists (select 1 from public.dm_conversations c
                 where c.workspace_id = p_workspace_id
                   and (select uid from caller) in (c.user_lo, c.user_hi)
                   and wm.user_id in (c.user_lo, c.user_hi))
    )
  order by wm.role desc, m.created_at
$fn$;
revoke all on function private._workspace_members_list(uuid) from public, anon;
grant execute on function private._workspace_members_list(uuid) to authenticated;

create function public.workspace_members_list(p_workspace_id uuid)
returns table(user_id uuid, display_name text, email text, role text,
              avatar_url text, bio text, status_text text, status_emoji text)
language sql set search_path to '' as $fn$
  select * from private._workspace_members_list(p_workspace_id)
$fn$;
revoke all on function public.workspace_members_list(uuid) from public, anon;
grant execute on function public.workspace_members_list(uuid) to authenticated;

-- avatars storage bucket (public, image-only, 2 MB) + own-folder write policies (no broad SELECT).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars','avatars', true, 2097152, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;
drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects for insert to authenticated
  with check (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects for update to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own on storage.objects for delete to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
