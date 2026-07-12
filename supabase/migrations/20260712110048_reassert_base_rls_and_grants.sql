-- [V-3] Re-assert RLS + least-privilege grants for the pre-ledger base tables
-- (2026-07-12 audit — SECURITY_AUDIT_2026-07-12.md).
-- tasks / projects / members were created out-of-band before the first local migration (documented
-- in 20260701161427's header), so supabase/migrations/ never enables RLS or sets their grants —
-- unlike every other table. The LIVE DB is correct (all three deny anon and enforce RLS), but a
-- repo-only rebuild (staging / DR) that also lacks the out-of-band rls_auto_enable event trigger
-- would recreate them RLS-DISABLED with Postgres/Supabase default GRANT-ALL to anon — fully
-- readable/writable. Re-assert the exact live state so the migration set is a complete, replayable
-- source of truth for these three tables' RLS + grants. No behavior change on the (correct) live DB.
--
-- Grants mirror live exactly: tasks/projects = SELECT,INSERT,UPDATE,DELETE for authenticated;
-- members = SELECT,INSERT,UPDATE (no DELETE); anon/public = nothing. TRUNCATE/REFERENCES/TRIGGER are
-- intentionally NOT granted (kept revoked by 20260706034646). RLS remains the enforcement gate.
--
-- Proven rolled-back before apply: the statements are a no-op against live (RLS+grants signature
-- identical before/after for all three tables); and applied to a simulated rebuild-hazard table
-- (RLS disabled + anon grant-all) they yield RLS enabled + anon revoked. Isolation 48/48 held;
-- advisors clean.

alter table public.tasks    enable row level security;
alter table public.projects enable row level security;
alter table public.members  enable row level security;

revoke all on public.tasks    from anon, public;
revoke all on public.projects from anon, public;
revoke all on public.members  from anon, public;

grant select, insert, update, delete on public.tasks    to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update          on public.members  to authenticated;
