-- Fix: innocent statuses rejected as impersonation ("staff meeting", "verified the
-- deploy", the name "Staffan") — _looks_like_role_title SUBSTRING-matched over the
-- folded+stripped text, so any value CONTAINING a role word anywhere was blocked.
--
-- NEW RULE — ANCHORED: the WHOLE value (after the same NFKC fold + strip of
-- separators/decoration, unchanged from 20260716110514) must BE a role title,
-- optionally article/scope-prefixed ("the admin", "workspace owner") or pluralized
-- ("admins"). Contained-in-a-sentence usage passes.
--
--   Still BLOCKED: 'Admin' · 'ADMIN!' · 'A D M I N' · fullwidth 'ａｄｍｉｎ' ·
--     math-bold lookalikes (NFKC folds them) · 'Workspace Owner' · 'The Admin' ·
--     'Admins' · 'owner.' · 'Verified' · 'sysadmin' · 'superuser' · '-- Admin --'
--   Now ALLOWED: 'staff meeting' · 'verified the deploy' · 'on official leave' ·
--     'Staffan' · any normal sentence containing a role word
--   ACCEPTED WIDENING (ratified 2026-07-18): a role word with a SUFFIX now passes —
--     'Admin — Tony', 'Owner | Ops'. Blocking those while allowing 'staff meeting'
--     is not expressible in one regex; a leading-anchor rule would re-reject
--     'verified the deploy'. Decided trade-off, not an oversight.
--   Unchanged residuals (out of scope, per the original design): Cyrillic/Greek
--     confusables and leetspeak stay allowed.
--
-- Proven by a rolled-back 31/31 proof (2026-07-18): 3 RED anti-vacuity + RLS-live
-- control + 14 still-blocked + 7 now-allowed + 4 end-to-end through the live
-- members_validate_profile trigger + a no-regression scan showing 0 of 8 already-
-- stored values (display names, statuses, workspace names) become newly blocked.
-- Recon: live body matched ledger 20260716110514 (no drift); every blocked-value
-- assertion in the existing 143-suite uses a BARE role word, so none depended on
-- substring matching and no test required editing.
--
-- Strictly NARROWER than the old rule, so every value already stored under the old
-- rule still passes — zero regression risk for existing rows.

create or replace function private._looks_like_role_title(p_text text) returns boolean
language sql immutable set search_path to '' as $fn$
  -- Anchored (^…$): the whole folded/stripped value must be a role title — optionally
  -- 'the'-prefixed, scope-prefixed, or pluralized — never merely contain one.
  select p_text is not null
    and regexp_replace(lower(normalize(p_text, NFKC)), '[^a-z0-9]', '', 'g')
          ~ '^(the)?(workspace|team|site|app|global|super|sys)?(owner|admin|administrator|moderator|superadmin|sysadmin|superuser|founder|official|staff|verified)s?$';
$fn$;
revoke all on function private._looks_like_role_title(text) from public, anon, authenticated;
