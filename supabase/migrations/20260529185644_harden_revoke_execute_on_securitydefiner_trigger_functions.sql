-- Recovered VERBATIM from supabase_migrations.schema_migrations.statements (version 20260529185644)
-- on 2026-07-16. This was the FIRST ledger entry but had no local file (the "missing 20260529185644"
-- rebuild gap). It is the exact SQL that was applied; committed here for ledger fidelity. No-op live.
--
-- Close the REST RPC exposure on two SECURITY DEFINER trigger functions.
-- Both are invoked by the trigger system (row trigger / event trigger) and do
-- NOT require EXECUTE for that, so removing the PUBLIC grant has no functional
-- impact on signup (handle_new_user) or RLS auto-enable (rls_auto_enable).
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
