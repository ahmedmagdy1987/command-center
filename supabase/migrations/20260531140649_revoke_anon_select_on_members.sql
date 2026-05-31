-- Least-privilege cleanup: public.members was the only base table granting a
-- table-level SELECT to the anon role. Not exploitable today (RLS is enabled and
-- the sole SELECT policy, members_select_self_or_shared, is `to authenticated`
-- with id = (select auth.uid()) OR private.shares_workspace(id), so an
-- unauthenticated/anon caller already reads zero rows), but the grant is
-- unnecessary and inconsistent with the other 7 base tables. Remove it before
-- launch. The app never reads members pre-auth (only members.getCurrent(), which
-- self-guards on an active session), so authenticated reads are unaffected.
-- Idempotent: revoking an absent grant is a harmless no-op.
revoke select on public.members from anon;
