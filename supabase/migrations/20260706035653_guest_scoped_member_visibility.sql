-- [L1] Guest email-roster leak (2026-07-06 red-team audit — SECURITY_AUDIT_2026-07-06.md).
-- members_select_self_or_shared (self OR shares_workspace) let a GUEST — walled off from team
-- chat/projects/others' tasks — read every co-member's email + display_name (proven leak), and
-- the workspace_members_list RPC (gated only by is_workspace_member) returned the full roster
-- with emails to guests too. Close BOTH vectors so a guest resolves only the identities it needs
-- for its own/assigned tasks + its DMs, with no other-member emails. Members/admins/owners are
-- unchanged.
--
-- (1) members SELECT: a caller sees a profile only if it's their own OR they are a NON-GUEST in a
--     workspace shared with the target. A guest therefore sees only its own members row.
-- (2) workspace_members_list RPC: for a GUEST caller, return only self + creators/assignees of
--     tasks the guest can see + DM peers, and NULL every email. Non-guest callers unchanged.
--
-- The client resolves assignee chips / "Added by" / DM peer names exclusively from the RPC roster
-- array (never the members table), so guest screens keep working: task-creator + DM-peer names
-- still resolve; only emails and uninvolved members are withheld.
--
-- Proven rolled-back before apply: a guest reads 0 other-member emails via BOTH the table
-- (can_see self=true, others=false) and the RPC (3 rows = self+task-creator+DM-peer, other-emails=0,
-- uninvolved member excluded) while Tony's + VA's names still resolve; member/owner see the full
-- roster with emails unchanged. Post-apply: member sees 3/3 rows+emails; outsider sees 0. Advisors
-- clean; isolation regression held.

create or replace function private.can_see_member_profile(p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    p_target = auth.uid()
    or exists (
      select 1
      from public.workspace_members me
      join public.workspace_members them on them.workspace_id = me.workspace_id
      where me.user_id = auth.uid()
        and them.user_id = p_target
        and me.role <> 'guest'   -- the CALLER must be a non-guest in the shared workspace
    );
$fn$;

revoke execute on function private.can_see_member_profile(uuid) from public, anon;
grant execute on function private.can_see_member_profile(uuid) to authenticated;

drop policy members_select_self_or_shared on public.members;
create policy members_select_self_or_shared on public.members
  for select to authenticated
  using (private.can_see_member_profile(id));

create or replace function private._workspace_members_list(p_workspace_id uuid)
returns table(user_id uuid, display_name text, email text, role text)
language sql
security definer
set search_path = ''
as $fn$
  with caller as (select auth.uid() as uid, private.workspace_role(p_workspace_id) as r)
  select wm.user_id,
         m.display_name,
         case when (select r from caller) = 'guest' then null else m.email end,
         wm.role
  from public.workspace_members wm
  join public.members m on m.id = wm.user_id
  where wm.workspace_id = p_workspace_id
    and private.is_workspace_member(p_workspace_id)
    and (
      (select r from caller) is distinct from 'guest'
      or wm.user_id = (select uid from caller)                       -- self
      or exists (                                                    -- creator/assignee of a task the guest can see
        select 1 from public.tasks t
        where t.workspace_id = p_workspace_id
          and (select uid from caller) in (t.created_by, t.assignee_id)
          and wm.user_id in (t.created_by, t.assignee_id)
      )
      or exists (                                                    -- DM peer
        select 1 from public.dm_conversations c
        where c.workspace_id = p_workspace_id
          and (select uid from caller) in (c.user_lo, c.user_hi)
          and wm.user_id in (c.user_lo, c.user_hi)
      )
    )
  order by wm.role desc, m.created_at
$fn$;
