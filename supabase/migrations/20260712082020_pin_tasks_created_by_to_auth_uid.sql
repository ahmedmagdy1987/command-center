-- [V-2] Pin tasks.created_by to auth.uid() on INSERT (2026-07-12 audit — SECURITY_AUDIT_2026-07-12.md).
-- tasks_insert_role only constrained created_by inside the 'private' branch; a privacy='workspace'
-- insert skipped it, so a non-guest member could forge authorship ("Added by <victim>") and misdirect
-- the task_completed notification to the spoofed creator. comments.author_id / messages.sender_id are
-- already pinned to auth.uid(); tasks was the outlier. Add the same pin so the author is always the
-- caller, for BOTH privacy branches. No cross-tenant reach (is_workspace_member is still ANDed) and no
-- legitimate insert path is affected: the app always sends created_by = session.user.id
-- (api.js tasks.create / tasks.bulkInsert force it as the final spread key), and no RPC/trigger inserts
-- tasks. Guests remain constrained to self-assigned tasks (the trailing guest clause is unchanged).
--
-- Proven rolled-back before apply: current policy lets member VA store created_by=<owner> (spoof
-- succeeds); with this policy applied in-txn the spoof is blocked (42501), a normal insert
-- (created_by=self) succeeds for owner/admin/member/guest, and a NULL created_by is rejected (42501).
-- Isolation 48/48 + role 40/40 regressions held; advisors clean.

drop policy if exists tasks_insert_role on public.tasks;
create policy tasks_insert_role on public.tasks for insert to authenticated
with check (private.is_workspace_member(workspace_id)
  and (select auth.uid()) = created_by
  and (privacy='workspace' or (privacy='private' and ((select auth.uid())=created_by or (select auth.uid())=assignee_id)))
  and (private.workspace_role(workspace_id) <> 'guest' or (select auth.uid())=assignee_id));
