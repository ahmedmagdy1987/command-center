-- Workspace slugs: human-readable workspace identifier for the URL (?ws=<slug>).
--
-- The slug is a URL-ONLY alias. The UUID stays canonical everywhere internally
-- (currentWorkspaceId, every api.js call, realtime channel names + workspace_id=eq.<uuid>
-- filters, and localStorage). The app resolves slug->uuid once, on load, and keeps a
-- strict-UUID-regex discriminator so old ?ws=<uuid> bookmarks keep working (and self-upgrade
-- to the slug form on first navigate).
--
-- Slug generation (private._slugify, reusable for a future editable-slug RPC): lowercase,
-- collapse non-alphanumeric runs to '-', trim '-', cap 48 chars. All-non-ASCII names (e.g.
-- Arabic) slugify to '' and fall back to ws-<8 hex>. unaccent is NOT used (it does nothing
-- for Arabic and adds a critical-path dependency); the empty/<2-char fallback covers every
-- non-ASCII case uniformly.
--
-- Uniqueness is GLOBAL (a slug in the URL has no tenant context) and case-insensitive via a
-- functional unique index on lower(slug) -- which also serves the slug->id resolution lookup.
-- Collision handling lives INSIDE the DEFINER create RPC as a suffix loop (-2/-3/...) driven by
-- the unique constraint's unique_violation (race-safe; never a pre-check SELECT). Slug
-- assignment can only happen via the RPC -- workspaces is SELECT-only under RLS.
--
-- RLS is unchanged and already safe: workspaces_select_member scopes SELECT to the caller's
-- memberships, so a client slug->id lookup only resolves slugs for workspaces the user belongs
-- to; an unknown/non-member slug returns 0 rows and the app falls through to its existing
-- precedence (localStorage -> first workspace) and self-corrects the URL.
--
-- Verified by a rolled-back proof before apply: existing rows backfill to command-center /
-- ahmed / amego; an Arabic-name create yields a valid ws-<hex> fallback (no error, no empty
-- slug, no collision-loop spin); duplicate base 'ahmed' yields ahmed-2 then ahmed-3; exact and
-- case-insensitive direct duplicate inserts are both rejected by the index; per-user visible
-- row counts unchanged (additive column); security advisors clean.

-- (1) reusable base slugifier: lowercase, non-alnum runs -> '-', trim '-', cap 48 chars.
--     Returns '' for all-non-ASCII names; the caller applies a ws-<hex> fallback.
create or replace function private._slugify(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(
           substr(
             btrim(regexp_replace(lower(coalesce(p_text,'')), '[^a-z0-9]+', '-', 'g'), '-'),
             1, 48),
           '-')
$$;
revoke all on function private._slugify(text) from public;

-- (2) additive column
alter table public.workspaces add column if not exists slug text;

-- (3) backfill existing rows (dedupe-aware within the set; ws-<8hex> fallback for empty/<2-char)
with base as (
  select id,
         private._slugify(name) as b,
         row_number() over (partition by lower(private._slugify(name)) order by created_at) as rn
  from public.workspaces
  where slug is null
)
update public.workspaces w
   set slug = case
                when base.b = '' or char_length(base.b) < 2
                  then 'ws-' || substr(replace(w.id::text,'-',''),1,8)
                when base.rn = 1 then base.b
                else base.b || '-' || base.rn
              end
from base
where base.id = w.id;

-- (4) global, case-insensitive unique slug index (doubles as the slug->id resolution lookup index)
create unique index if not exists workspaces_slug_lower_key on public.workspaces (lower(slug));

-- (5) lock NOT NULL last (every row now populated)
alter table public.workspaces alter column slug set not null;

-- (6) the create RPC now generates + stores a globally-unique slug.
--     Collision handling = suffix loop driven by the UNIQUE constraint (race-safe; never a pre-check SELECT).
create or replace function private._create_workspace(p_name text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_base text;
  v_slug text;
  v_n    int := 1;
  v_ws   public.workspaces;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a workspace.' using errcode = '28000';
  end if;
  if v_name = '' then
    raise exception 'Workspace name is required.' using errcode = '22023';
  end if;
  if char_length(v_name) > 80 then
    raise exception 'Workspace name must be 80 characters or fewer.' using errcode = '22023';
  end if;

  -- base slug from the name; fall back to ws-<8 hex> for empty/too-short (e.g. all-non-ASCII names)
  v_base := private._slugify(v_name);
  if v_base = '' or char_length(v_base) < 2 then
    v_base := 'ws-' || substr(replace(gen_random_uuid()::text,'-',''),1,8);
  end if;

  -- insert; on a slug clash the unique index raises, we suffix -2/-3/... and retry
  v_slug := v_base;
  loop
    begin
      insert into public.workspaces (name, owner_id, slug)
      values (v_name, v_uid, v_slug)
      returning * into v_ws;
      exit;
    exception when unique_violation then
      v_n := v_n + 1;
      v_slug := v_base || '-' || v_n;
      if v_n > 50 then  -- pathological safety valve: degrade to a random base, keep looping
        v_base := 'ws-' || substr(replace(gen_random_uuid()::text,'-',''),1,8);
        v_slug := v_base;
        v_n := 1;
      end if;
    end;
  end loop;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_ws.id, v_uid, 'owner');

  return v_ws;
end;
$$;
revoke all on function private._create_workspace(text) from public, anon;
grant execute on function private._create_workspace(text) to authenticated;

-- (7) refresh the public INVOKER wrapper so its `select *` re-expands to include the new slug column
create or replace function public.create_workspace(p_name text)
returns public.workspaces
language sql
set search_path = ''
as $$
  select * from private._create_workspace(p_name);
$$;
revoke all on function public.create_workspace(text) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;
