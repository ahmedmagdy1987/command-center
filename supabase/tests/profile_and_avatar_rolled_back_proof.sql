-- ============================================================================
-- PROFILE + AVATAR + DISPLAY_NAME HARDENING (members) — ROLLED-BACK PROOF
-- 42 assertions. Rolled back. Proves the single profile+avatar+display_name migration.
--
-- ⚠ THIS FILE RE-CREATES public.members_validate_profile AND private._looks_like_role_title INSIDE
--   ITS OWN TRANSACTION. That is the standing landmine (first flagged for _looks_like_role_title in
--   20260718195827): if either rule changes again, change it HERE TOO or this suite silently proves a
--   body that no longer ships.
--
-- UPDATED FOR avatars_private_bucket_and_signed_urls: `avatar_url` no longer stores an absolute public
--   URL, it stores the bare storage PATH, pinned to the ROW OWNER'S OWN uid folder. That pin is a
--   CONTROL, not tidiness — the column now GRANTS READ ACCESS to the object it names (via
--   avatars_select_shared_workspace), so a foreign path would publish another user's private image to
--   your workspace (W22). W18 plants the new shape, W19/W20 keep the arbitrary-https and javascript:
--   rejections, and W21 pins the rejection of the OLD public-URL shape. The bucket is created PRIVATE.
-- ============================================================================
-- IMPERSONATION DEFENSE (precise scope): status_text, status_emoji AND display_name reject role/authority
--   titles written as ASCII / FULLWIDTH / MATHEMATICAL / ZERO-WIDTH-split / SPACED (NFKC + separator-strip),
--   plus (status_emoji) enclosed/circled/squared/CJK letter-like symbols. Shared check: private._looks_like_role_title.
--   display_name is CHANGE-GATED (existing values grandfathered; only re-validated when it actually changes or on
--   INSERT) and handle_new_user SANITIZES its OAuth-derived name so signup can NEVER fail on the new rule.
--   OUT OF SCOPE (documented residual, per request): Cyrillic/Greek confusables + leetspeak (W08/W09 assert allowed).
--   avatar_url: STORAGE-HOSTED ONLY (our public avatars bucket) + length cap — an arbitrary https host is
--   rejected, closing the cross-viewer tracking-pixel vector. The avatars bucket + own-folder write policies
--   ship here too (S01/S02). display_name: change-gated (grandfathered) + handle_new_user sanitizes so signup
--   never fails. OUT OF SCOPE residual (documented): Cyrillic/Greek confusables + leetspeak (W08/W09 allowed).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- (1) THE MIGRATION DDL UNDER TEST
-- ---------------------------------------------------------------------------
alter table public.members
  add column if not exists avatar_url    text,
  add column if not exists bio           text,
  add column if not exists status_text   text,
  add column if not exists status_emoji  text;

-- shared homoglyph-normalized role/title check (used by the trigger AND handle_new_user)
-- ANCHORED since 20260718 (see that migration): the WHOLE folded/stripped value must BE a
-- role title — optionally 'the'-prefixed, scope-prefixed, or pluralized — never merely
-- CONTAIN one. Kept in sync with live here so this suite tests the rule that actually ships.
-- Every blocked-value assertion below uses a BARE role word, so all of them still hold.
create or replace function private._looks_like_role_title(p_text text) returns boolean
language sql immutable set search_path to '' as $fn$
  select p_text is not null
    and regexp_replace(lower(normalize(p_text, NFKC)), '[^a-z0-9]', '', 'g')
          ~ '^(the)?(workspace|team|site|app|global|super|sys)?(owner|admin|administrator|moderator|superadmin|sysadmin|superuser|founder|official|staff|verified)s?$';
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
    -- PATH, not URL (avatars_private_bucket_and_signed_urls). The bucket is private, so there is no
    -- stable URL to store; this value is what avatars_select_shared_workspace and
    -- _sweep_orphan_avatars compare to storage.objects.name. Pinned to THIS ROW'S OWN uid folder,
    -- because avatar_url now GRANTS READ ACCESS to the object it names — a foreign path would let one
    -- user publish another user's image to their workspace. Single segment only (no '/' in the class)
    -- forecloses sub-paths and traversal. An arbitrary https host is still rejected, so the
    -- cross-viewer tracking-pixel vector stays closed.
    if new.avatar_url !~ ('^' || new.id::text || '/[A-Za-z0-9._-]{1,200}$') then
      raise exception 'avatar_url must be a storage path in your own avatars folder (<your-user-id>/<file>)'
        using errcode = '22023';
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

-- avatars storage bucket (PRIVATE since avatars_private_bucket_and_signed_urls, image-only, 2 MB) +
-- own-folder write policies. Reads are signed URLs, not a CDN public URL, so SELECT is now load-bearing
-- for rendering; avatar_url stores the object PATH (pinned to the row owner's own folder, above).
-- `on conflict do nothing` would NOT flip an existing row, so `public` is set explicitly below.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars','avatars', false, 2097152, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;
update storage.buckets set public = false where id = 'avatars';
drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects for insert to authenticated
  with check (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects for update to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own on storage.objects for delete to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- SELECT is SCOPED to the caller's OWN folder (migration 20260716131220). Bucket-wide SELECT would let
-- clients list the bucket (public_bucket_allows_listing advisor) — but SOME select is required, because
-- upload({upsert:true}) issues INSERT ... ON CONFLICT DO UPDATE which must READ the conflicting row;
-- with no SELECT policy every upload died with 42501. This block mirrors the LIVE policy set; the
-- upsert path itself is covered by avatars_upload_rls_rolled_back_proof.sql.
drop policy if exists avatars_select_own on storage.objects;
create policy avatars_select_own on storage.objects for select to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Own-folder SELECT alone would degrade every co-worker's face to initials under a private bucket
-- (signing requires SELECT). The conversion adds a second, ADDITIVE policy gated on the object being
-- REFERENCED by a members row the caller may see. Restated here so this file mirrors the live set;
-- the visibility behaviour itself is asserted in avatars_upload_rls_rolled_back_proof.sql.
-- Mirrors the LIVE body as of 20260722080911: the guest-scoped `can_see_member_avatar` replaced
-- `shares_workspace` (which that migration DROPPED — restating the old body here would now fail at
-- function-creation time, not at assertion time).
create or replace function private.is_visible_avatar_object(p_name text) returns boolean
language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.members m
     where m.avatar_url = p_name
       and private.can_see_member_avatar(m.id)
  );
$fn$;
revoke execute on function private.is_visible_avatar_object(text) from public, anon;
grant  execute on function private.is_visible_avatar_object(text) to authenticated;

drop policy if exists avatars_select_shared_workspace on storage.objects;
create policy avatars_select_shared_workspace on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and private.is_visible_avatar_object(name));

-- ---------------------------------------------------------------------------
-- (2) HARNESS
-- ---------------------------------------------------------------------------
create function pg_temp.imp(p_uid uuid) returns void language plpgsql as $fn$
declare v_email text;
begin
  execute 'reset role';
  select u.email into v_email from auth.users u where u.id = p_uid;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'email', coalesce(v_email, ''))::text, true);
end $fn$;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;

-- ---------------------------------------------------------------------------
-- (3) THE PROOF
-- ---------------------------------------------------------------------------
do $pf$
declare
  v_sfx text := replace(gen_random_uuid()::text, '-', '');
  v_owner uuid := gen_random_uuid(); v_member uuid := gen_random_uuid();
  v_peer uuid := gen_random_uuid(); v_guest uuid := gen_random_uuid(); v_out uuid := gen_random_uuid();
  v_dn5 uuid := gen_random_uuid(); v_dn6 uuid := gen_random_uuid(); v_dn7 uuid := gen_random_uuid();
  v_ws uuid := gen_random_uuid();
  v_actual text; v_msg text; v_n int; v_email text; v_bio text; v_avatar text; v_status text; v_avatar_url text;
  c_role  constant text := 'status may not impersonate a role or title';
  c_av    constant text := 'avatar_url must be a storage path in your own avatars folder (<your-user-id>/<file>)';
  c_dn    constant text := 'display name may not impersonate a role or title';
  c_emoji constant text := 'status emoji must be an emoji, not letters or letter-like symbols';
begin
  -- neutral emails (no role-word local parts) so signup sanitization only fires where intended
  insert into auth.users (id, email, aud, role) values
    (v_owner, 'pf1-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_member,'pf2-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_peer,  'pf3-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_guest, 'pf4-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_out,   'pf5-'||v_sfx||'@example.invalid','authenticated','authenticated');

  insert into public.workspaces (id,name,owner_id,slug) values (v_ws,'PF WS',v_owner,'pf-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (v_ws,v_owner,'owner'),(v_ws,v_member,'member'),(v_ws,v_peer,'member'),(v_ws,v_guest,'guest');

  insert into public.tasks (id,title,privacy,project,status,workspace_id,created_by,assignee_id)
  values ('pf-t-'||v_sfx,'peer task','workspace','other','inbox',v_ws,v_member,v_guest);

  -- a bare own-uid PATH — the private-bucket shape. The old absolute public URL is now rejected (W19).
  v_avatar_url := v_member::text||'/a.png';
  update public.members set status_text='on a call', status_emoji='🛠️',
         avatar_url=v_avatar_url, bio='building things' where id=v_member;

  -- ===== HARNESS GUARD =====
  perform pg_temp.imp(v_member);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role'; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: bypassrls'; end if;
  if auth.uid() is distinct from v_member then execute 'reset role'; raise exception 'HARNESS BROKEN: uid'; end if;
  execute 'reset role';

  -- ===== ANTI-VACUITY GUARD =====
  select status_text into v_status from public.members where id=v_member;
  if v_status <> 'on a call' then raise exception 'VACUOUS: planted profile not set'; end if;
  select bio into v_bio from public.members where id=v_member;
  if v_bio is null then raise exception 'VACUOUS: planted bio null'; end if;
  if not private._looks_like_role_title('Admin') then raise exception 'VACUOUS: role check is dead'; end if;

  -- ===================== STATUS_TEXT =====================
  begin perform pg_temp.imp(v_member); update public.members set status_text='out for lunch' where id=v_member;
    execute 'reset role'; select status_text into v_status from public.members where id=v_member; raise exception 'PD_UNDO';
  exception when others then execute 'reset role'; if sqlerrm<>'PD_UNDO' then raise; end if; end;
  insert into _r values (1,'W01 benign status_text allowed + stored','out for lunch',coalesce(v_status,'NULL'),v_status='out for lunch');

  perform pg_temp.imp(v_member);
  begin update public.members set status_text='Admin' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (2,'W02 literal role word rejected','42501|'||c_role,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_role);

  perform pg_temp.imp(v_member);
  begin update public.members set status_text='Ａｄｍｉｎ' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (3,'W03 FULLWIDTH lookalike rejected','42501|'||c_role,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_role);

  perform pg_temp.imp(v_member);
  begin update public.members set status_text='𝗢𝘄𝗻𝗲𝗿' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (4,'W04 MATHEMATICAL lookalike rejected','42501|'||c_role,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_role);

  perform pg_temp.imp(v_member);
  begin update public.members set status_text='a'||chr(8203)||'d'||chr(8203)||'m'||chr(8203)||'i'||chr(8203)||'n' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (5,'W05 ZERO-WIDTH lookalike rejected','42501|'||c_role,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_role);

  perform pg_temp.imp(v_member);
  begin update public.members set status_text=repeat('x',81) where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (6,'W06 over length cap rejected','22023|status is too long (max 80 characters)',v_actual||'|'||v_msg,v_actual='22023' and v_msg='status is too long (max 80 characters)');

  perform pg_temp.imp(v_member);
  begin update public.members set status_text='superuser' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (7,'W07 expanded blocklist word (superuser) rejected','42501|'||c_role,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_role);

  begin perform pg_temp.imp(v_member); update public.members set status_text='оwner' where id=v_member;
    execute 'reset role'; select status_text into v_status from public.members where id=v_member; raise exception 'PD_UNDO';
  exception when others then execute 'reset role'; if sqlerrm<>'PD_UNDO' then raise; end if; end;
  insert into _r values (8,'W08 RESIDUAL (out of scope): Cyrillic confusable ALLOWED','оwner',coalesce(v_status,'NULL'),v_status='оwner');

  begin perform pg_temp.imp(v_member); update public.members set status_text='0wner' where id=v_member;
    execute 'reset role'; select status_text into v_status from public.members where id=v_member; raise exception 'PD_UNDO';
  exception when others then execute 'reset role'; if sqlerrm<>'PD_UNDO' then raise; end if; end;
  insert into _r values (9,'W09 RESIDUAL (out of scope): leetspeak ALLOWED','0wner',coalesce(v_status,'NULL'),v_status='0wner');

  -- ===================== STATUS_EMOJI =====================
  begin perform pg_temp.imp(v_member); update public.members set status_emoji='🔥' where id=v_member;
    execute 'reset role'; select status_emoji into v_status from public.members where id=v_member; raise exception 'PD_UNDO';
  exception when others then execute 'reset role'; if sqlerrm<>'PD_UNDO' then raise; end if; end;
  insert into _r values (10,'W10 benign status_emoji allowed + stored','🔥',coalesce(v_status,'NULL'),v_status='🔥');

  begin perform pg_temp.imp(v_member); update public.members set status_emoji='🇺🇸' where id=v_member;
    execute 'reset role'; select status_emoji into v_status from public.members where id=v_member; raise exception 'PD_UNDO';
  exception when others then execute 'reset role'; if sqlerrm<>'PD_UNDO' then raise; end if; end;
  insert into _r values (11,'W11 flag emoji allowed (range check spares regional indicators)','🇺🇸',coalesce(v_status,'NULL'),v_status='🇺🇸');

  perform pg_temp.imp(v_member);
  begin update public.members set status_emoji='admin' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (12,'W12 ascii-letters emoji rejected','22023|'||c_emoji,v_actual||'|'||v_msg,v_actual='22023' and v_msg=c_emoji);

  perform pg_temp.imp(v_member);
  begin update public.members set status_emoji='Ａ' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (13,'W13 FULLWIDTH letter emoji rejected','22023|'||c_emoji,v_actual||'|'||v_msg,v_actual='22023' and v_msg=c_emoji);

  perform pg_temp.imp(v_member);
  begin update public.members set status_emoji='Ⓜ' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (14,'W14 CIRCLED-letter emoji rejected (letter-like symbol)','22023|'||c_emoji,v_actual||'|'||v_msg,v_actual='22023' and v_msg=c_emoji);

  perform pg_temp.imp(v_member);
  begin update public.members set status_emoji='ОФИЦ' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (15,'W15 CYRILLIC-letters emoji rejected','22023|'||c_emoji,v_actual||'|'||v_msg,v_actual='22023' and v_msg=c_emoji);

  -- ===================== BIO + AVATAR =====================
  begin perform pg_temp.imp(v_member); update public.members set bio='I coordinate the roadmap.' where id=v_member;
    execute 'reset role'; select bio into v_status from public.members where id=v_member; raise exception 'PD_UNDO';
  exception when others then execute 'reset role'; if sqlerrm<>'PD_UNDO' then raise; end if; end;
  insert into _r values (16,'W16 benign bio allowed + stored','I coordinate the roadmap.',coalesce(v_status,'NULL'),v_status='I coordinate the roadmap.');

  perform pg_temp.imp(v_member);
  begin update public.members set bio=repeat('y',281) where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (17,'W17 bio over length cap rejected','22023|bio is too long (max 280 characters)',v_actual||'|'||v_msg,v_actual='22023' and v_msg='bio is too long (max 280 characters)');

  begin perform pg_temp.imp(v_member); update public.members set avatar_url=v_member::text||'/new.png' where id=v_member;
    execute 'reset role'; select avatar_url into v_status from public.members where id=v_member; raise exception 'PD_UNDO';
  exception when others then execute 'reset role'; if sqlerrm<>'PD_UNDO' then raise; end if; end;
  insert into _r values (18,'W18 bare own-uid storage PATH allowed + stored (private-bucket shape)',
    v_member::text||'/new.png', coalesce(v_status,'NULL'), v_status=v_member::text||'/new.png');

  perform pg_temp.imp(v_member);
  begin update public.members set avatar_url='https://evil.example/px.gif?ws=1' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (19,'W19 arbitrary-https avatar_url rejected (tracking-pixel closed)','22023|'||c_av,v_actual||'|'||v_msg,v_actual='22023' and v_msg=c_av);

  perform pg_temp.imp(v_member);
  begin update public.members set avatar_url='javascript:alert(1)' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (20,'W20 javascript: avatar_url rejected','22023|'||c_av,v_actual||'|'||v_msg,v_actual='22023' and v_msg=c_av);

  -- ===================== WRITE-PATH INTEGRITY =====================
  perform pg_temp.imp(v_member);
  begin update public.members set email='hijack-'||v_sfx||'@x.test' where id=v_member; v_actual:='ALLOWED'; exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (21,'I01 member cannot change own email (no column grant)','42501',v_actual,v_actual='42501');

  perform pg_temp.imp(v_member);
  begin update public.members set role='owner' where id=v_member; v_actual:='ALLOWED'; exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (22,'I02 member cannot change own members.role','42501',v_actual,v_actual='42501');

  perform pg_temp.imp(v_member);
  update public.members set status_text='hi' where id=v_peer; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (23,'I03 member cannot update another member profile (row-pinned)','0 rows',v_n::text||' rows',v_n=0);

  begin execute 'reset role'; grant update (email) on public.members to authenticated;
    perform pg_temp.imp(v_member);
    begin update public.members set email='hijack2-'||v_sfx||'@x.test' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
    execute 'reset role'; raise exception 'PD_UNDO';
  exception when others then execute 'reset role'; if sqlerrm<>'PD_UNDO' then raise; end if; end;
  insert into _r values (24,'I04 lock trigger blocks email even WITH update(email) grant','42501|members.email is immutable (identity is owned by auth.users)',v_actual||'|'||v_msg,v_actual='42501' and v_msg='members.email is immutable (identity is owned by auth.users)');

  -- ===================== ROSTER RECREATE =====================
  perform pg_temp.imp(v_member);
  select status_text, email, avatar_url, bio into v_status, v_email, v_avatar, v_bio
    from public.workspace_members_list(v_ws) where user_id=v_member;
  execute 'reset role';
  insert into _r values (25,'R01 member roster: v_member status+avatar+email present','on a call|'||v_avatar_url||'|hasEmail',
    coalesce(v_status,'NULL')||'|'||coalesce(v_avatar,'NULL')||'|'||case when v_email is not null then 'hasEmail' else 'NULL' end,
    v_status='on a call' and v_avatar=v_avatar_url and v_email is not null);
  insert into _r values (26,'R02 member roster: v_member bio present (discriminates guest-only NULLing)','building things',coalesce(v_bio,'NULL'),v_bio='building things');

  perform pg_temp.imp(v_guest);
  select email, bio, avatar_url, status_text into v_email, v_bio, v_avatar, v_status
    from public.workspace_members_list(v_ws) where user_id=v_member;
  execute 'reset role';
  insert into _r values (27,'R03 guest roster: email+bio NULL, avatar+status shown','NULL|NULL|'||v_avatar_url||'|on a call',
    coalesce(v_email,'NULL')||'|'||coalesce(v_bio,'NULL')||'|'||coalesce(v_avatar,'NULL')||'|'||coalesce(v_status,'NULL'),
    v_email is null and v_bio is null and v_avatar=v_avatar_url and v_status='on a call');

  perform pg_temp.imp(v_guest);
  select count(*) into v_n from public.workspace_members_list(v_ws) where user_id=v_peer;
  execute 'reset role'; insert into _r values (28,'R04 guest row-scoping: non-peer v_peer NOT visible','0',v_n::text,v_n=0);

  perform pg_temp.imp(v_member);
  select count(*) into v_n from public.workspace_members_list(v_ws) where user_id=v_peer;
  execute 'reset role'; insert into _r values (29,'R05 member roster: non-guest sees v_peer','1',v_n::text,v_n=1);

  perform pg_temp.imp(v_out);
  select count(*) into v_n from public.workspace_members_list(v_ws);
  execute 'reset role'; insert into _r values (30,'R06 non-member roster caller: 0 rows (is_workspace_member gate)','0',v_n::text,v_n=0);

  -- ===================== DISPLAY_NAME HARDENING =====================
  perform pg_temp.imp(v_member);
  begin update public.members set display_name='Admin' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (31,'DN01 member cannot set display_name to a role word','42501|'||c_dn,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_dn);

  perform pg_temp.imp(v_member);
  begin update public.members set display_name='Ａｄｍｉｎ' where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (32,'DN02 display_name FULLWIDTH lookalike rejected','42501|'||c_dn,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_dn);

  begin perform pg_temp.imp(v_member); update public.members set display_name='Jordan Lee' where id=v_member;
    execute 'reset role'; select display_name into v_status from public.members where id=v_member; raise exception 'PD_UNDO';
  exception when others then execute 'reset role'; if sqlerrm<>'PD_UNDO' then raise; end if; end;
  insert into _r values (33,'DN03 benign display_name allowed + stored','Jordan Lee',coalesce(v_status,'NULL'),v_status='Jordan Lee');

  perform pg_temp.imp(v_member);
  begin update public.members set display_name=repeat('J',61) where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (34,'DN04 display_name over length cap rejected','22023|display name is too long (max 60 characters)',v_actual||'|'||v_msg,v_actual='22023' and v_msg='display name is too long (max 60 characters)');

  -- signup sanitization: a role-word OAuth full_name must SUCCEED (never error) and be sanitized
  begin
    execute 'reset role';
    insert into auth.users (id,email,raw_user_meta_data,aud,role)
    values (v_dn5,'pf-dn5-'||v_sfx||'@example.invalid', jsonb_build_object('full_name','Owner'),'authenticated','authenticated');
    v_actual:='SIGNUP_OK';
  exception when others then v_actual:='SIGNUP_FAIL:'||sqlerrm; end;
  select display_name into v_status from public.members where id=v_dn5;
  insert into _r values (35,'DN05 signup w/ role-word OAuth name SUCCEEDS + sanitized','SIGNUP_OK|pf-dn5-'||v_sfx,v_actual||'|'||coalesce(v_status,'NULL'),v_actual='SIGNUP_OK' and v_status='pf-dn5-'||v_sfx);

  begin
    execute 'reset role';
    insert into auth.users (id,email,raw_user_meta_data,aud,role)
    values (v_dn6,'pf-dn6-'||v_sfx||'@example.invalid', jsonb_build_object('full_name','Ｏｗｎｅｒ'),'authenticated','authenticated');
    v_actual:='SIGNUP_OK';
  exception when others then v_actual:='SIGNUP_FAIL:'||sqlerrm; end;
  select display_name into v_status from public.members where id=v_dn6;
  insert into _r values (36,'DN06 signup w/ FULLWIDTH role OAuth name SUCCEEDS + sanitized','SIGNUP_OK|pf-dn6-'||v_sfx,v_actual||'|'||coalesce(v_status,'NULL'),v_actual='SIGNUP_OK' and v_status='pf-dn6-'||v_sfx);

  begin
    execute 'reset role';
    insert into auth.users (id,email,raw_user_meta_data,aud,role)
    values (v_dn7,'pf-dn7-'||v_sfx||'@example.invalid', jsonb_build_object('full_name','Sam Rivera'),'authenticated','authenticated');
    v_actual:='SIGNUP_OK';
  exception when others then v_actual:='SIGNUP_FAIL:'||sqlerrm; end;
  select display_name into v_status from public.members where id=v_dn7;
  insert into _r values (37,'DN07 signup w/ benign OAuth name keeps it (normal path)','SIGNUP_OK|Sam Rivera',v_actual||'|'||coalesce(v_status,'NULL'),v_actual='SIGNUP_OK' and v_status='Sam Rivera');

  -- grandfathering: an existing role-word display_name (planted past the trigger) does NOT block other edits
  execute 'reset role';
  alter table public.members disable trigger members_validate_profile;
  update public.members set display_name='Admin' where id=v_peer;
  alter table public.members enable trigger members_validate_profile;
  perform pg_temp.imp(v_peer);
  begin update public.members set status_text='working' where id=v_peer; v_actual:='ALLOWED'; exception when others then v_actual:=sqlstate; end;
  execute 'reset role';
  select display_name into v_status from public.members where id=v_peer;
  insert into _r values (38,'DN08 grandfathering: unchanged role-word display_name does not block other edits','ALLOWED|Admin',v_actual||'|'||coalesce(v_status,'NULL'),v_actual='ALLOWED' and v_status='Admin');

  -- ===================== AVATARS BUCKET STORAGE POLICY =====================
  perform pg_temp.imp(v_member);
  begin insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', v_member::text||'/a.png', v_member, v_member::text, jsonb_build_object('size',1024,'mimetype','image/png'));
    v_actual:='ok'; exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (39,'S01 member CAN upload to their OWN avatars folder','ok',v_actual,v_actual='ok');

  perform pg_temp.imp(v_member);
  begin insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', v_owner::text||'/evil.png', v_member, v_member::text, jsonb_build_object('size',1024,'mimetype','image/png'));
    v_actual:='ALLOWED'; exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (40,'S02 member CANNOT upload to ANOTHER user avatars folder','42501',v_actual,v_actual='42501');

  -- ===== AVATAR_URL IS NOW A CAPABILITY (private-bucket conversion) =====
  -- The column no longer merely describes a picture: avatars_select_shared_workspace grants READ on
  -- the object it names to everyone sharing a workspace with this member. Two rejections therefore
  -- matter more than they used to, and both are pinned here.
  perform pg_temp.imp(v_member);
  begin update public.members set
          avatar_url='https://nqlzjuxqgajeoypyzlnv.supabase.co/storage/v1/object/public/avatars/'||v_member||'/a.png'
        where id=v_member; v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (41,'W21 the OLD public-URL shape is now rejected (column stores a path)','22023|'||c_av,v_actual||'|'||v_msg,v_actual='22023' and v_msg=c_av);

  perform pg_temp.imp(v_member);
  begin update public.members set avatar_url=v_peer::text||'/a.png' where id=v_member;
        v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (42,'W22 [CONTROL] ANOTHER user''s path rejected — avatar_url is a read grant, so a foreign path would publish their image','22023|'||c_av,v_actual||'|'||v_msg,v_actual='22023' and v_msg=c_av);

  -- ===== completeness =====
  select count(*) into v_n from _r; if v_n <> 42 then raise exception 'INCOMPLETE: % rows, expected 42', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end
$pf$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;

rollback;
