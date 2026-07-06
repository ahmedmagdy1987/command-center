-- [L2] Least-privilege cleanup (2026-07-06 red-team audit — SECURITY_AUDIT_2026-07-06.md).
-- anon/authenticated carried TRUNCATE/REFERENCES/TRIGGER on every public table — Postgres
-- GRANT-ALL / default-privilege residue. Not reachable via PostgREST (no TRUNCATE verb) or
-- Realtime, so not actively exploitable, but a least-privilege violation. Remove it, and clean
-- the `postgres` role's default privileges so future public tables don't re-acquire it.
-- Data privileges (SELECT/INSERT/UPDATE/DELETE, granted explicitly per table) are untouched;
-- RLS remains the enforcement gate.
--
-- Proven rolled-back before apply: after the revoke, anon has (none) on public tables and
-- authenticated retains exactly DELETE,INSERT,SELECT,UPDATE (TRUNCATE/REFERENCES/TRIGGER gone);
-- authenticated can still SELECT/INSERT/UPDATE/DELETE tasks; notifications-INSERT and
-- workspace_members-INSERT remain denied; anon still has no SELECT. Isolation regression held.

revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;
