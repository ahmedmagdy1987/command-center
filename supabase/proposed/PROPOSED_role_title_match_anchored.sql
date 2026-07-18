-- ============================================================================
-- PROPOSED — NOT APPLIED, NOT A LEDGER MIGRATION (2026-07-18)
-- Fix: innocent statuses rejected as impersonation ("staff meeting",
-- "verified the deploy", the name "Staffan") — _looks_like_role_title
-- currently SUBSTRING-matches over the folded+stripped text, so any value
-- CONTAINING a role word anywhere is blocked.
--
-- NEW RULE — ANCHORED: the WHOLE value (after the same NFKC fold + strip of
-- separators/decoration, unchanged from 20260716110514) must BE a role title,
-- optionally article/scope-prefixed ("the admin", "workspace owner") or
-- pluralized ("admins"). Contained-in-a-sentence usage passes.
--
--   Still BLOCKED: 'Admin' · 'ADMIN!' · 'A D M I N' · fullwidth 'ａｄｍｉｎ' ·
--     mathematical-bold lookalikes (NFKC folds them) · 'Workspace Owner' ·
--     'The Admin' · 'Admins' · 'Verified' · 'sysadmin'
--   Now ALLOWED: 'staff meeting' · 'verified the deploy' · 'on official
--     leave' · 'Staffan' (the old rule's known false positive) · any normal
--     sentence containing a role word
--   Unchanged residuals (out of scope, as ratified in the original design):
--     Cyrillic/Greek confusables and leetspeak stay allowed (proof W08/W09).
--
-- Strictly NARROWER than the old rule, so every value already stored under the
-- old rule still passes — zero regression risk for existing rows.
--
-- PRE-APPLY RECON (MCP session):
--   1. Live prosrc of private._looks_like_role_title matches 20260716110514
--      (no out-of-band drift).
--   2. Check supabase/tests/profile_and_avatar_rolled_back_proof.sql for
--      assertions that DEPEND on substring blocking (e.g. a sentence expected
--      to be rejected) — update those in the same commit as the migration.
-- APPLY DISCIPLINE: rolled-back proof green -> owner approval -> apply_migration
--   -> advisors -> 48/48 + 143/143 regression -> ledger-named file -> commit+push.
-- ============================================================================

create or replace function private._looks_like_role_title(p_text text) returns boolean
language sql immutable set search_path to '' as $fn$
  -- Anchored (^…$): the whole folded/stripped value must be a role title — optionally
  -- 'the'-prefixed, scope-prefixed, or pluralized — never merely contain one.
  select p_text is not null
    and regexp_replace(lower(normalize(p_text, NFKC)), '[^a-z0-9]', '', 'g')
          ~ '^(the)?(workspace|team|site|app|global|super|sys)?(owner|admin|administrator|moderator|superadmin|sysadmin|superuser|founder|official|staff|verified)s?$';
$fn$;
revoke all on function private._looks_like_role_title(text) from public, anon, authenticated;
