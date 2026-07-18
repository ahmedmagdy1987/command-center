-- Invitation defense-in-depth: _accept_invitation rejects unconfirmed emails.
--
-- WHY: the whole email-bound invite model trusts that auth.users.email is VERIFIED.
-- That guarantee rested solely on the dashboard "Confirm email" toggle (verified ON
-- 2026-07-18 via /auth/v1/settings mailer_autoconfirm:false) — but a toggle can be
-- flipped. This asserts the invariant in the DB itself.
--
-- HONEST LIMITATION: if "Confirm email" is ever flipped OFF (autoconfirm), GoTrue
-- stamps email_confirmed_at AT SIGNUP without verification — so this guard alone does
-- NOT block an attacker who signs up with a victim's invited email while autoconfirm
-- is on. What it DOES close: accounts existing without a confirmed email through any
-- other path (admin-created users, interrupted confirm flows, future auth providers,
-- pre-toggle legacy accounts), and it turns a silent config dependency into an
-- explicit, tested server-side rule. Not a substitute for keeping Confirm email ON.
--
-- Body is the 20260602041903 body verbatim plus the guard (marked NEW); invite-as-role
-- behavior preserved (inv.role is applied).
--
-- Proven by a rolled-back 17/17 proof (2026-07-18): RED confirmed an unconfirmed
-- account accepts today AND gets the membership row; after the fix unconfirmed → 42501
-- with no membership row and the invite left 'pending'; the guard precedes the token
-- lookup so a garbage token yields no P0002 validity oracle; confirmed still accepts,
-- idempotent re-accept works, expired/revoked/wrong-email rejections intact,
-- unauthenticated still 'not authenticated', invite-as-role preserved (joined as
-- guest), DEFINER + search_path + authenticated-only EXECUTE survive the replace.
-- Recon: live body matched the ledger (no drift); 0 pre-existing unconfirmed users,
-- so no real user is locked out.

create or replace function private._accept_invitation(p_token uuid)
returns public.workspaces language plpgsql security definer set search_path = '' as $$
declare inv public.invitations; v_email text; v_confirmed timestamptz; ws public.workspaces;
begin
  select email, email_confirmed_at into v_email, v_confirmed
    from auth.users where id = (select auth.uid());
  if v_email is null then raise exception 'not authenticated' using errcode = '42501'; end if;

  -- NEW — defense-in-depth: the invite is EMAIL-BOUND, so the binding is only as
  -- strong as the email's verification. Enforce it here, independent of the
  -- dashboard Confirm-email toggle. Checked before the token is even looked at,
  -- so an unconfirmed account learns nothing about any token's validity.
  if v_confirmed is null then
    raise exception 'confirm your email address before accepting an invitation' using errcode = '42501';
  end if;

  select * into inv from public.invitations where token = p_token for update;
  if inv.id is null then raise exception 'invitation not found' using errcode = 'P0002'; end if;
  if inv.status = 'revoked' then raise exception 'this invitation was revoked'; end if;
  if inv.status = 'accepted' then
    select * into ws from public.workspaces where id = inv.workspace_id; return ws;   -- idempotent
  end if;
  if inv.expires_at <= now() then raise exception 'this invitation has expired'; end if;
  if lower(inv.email) <> lower(v_email) then raise exception 'this invitation is for a different email'; end if;

  if not exists (select 1 from public.workspace_members where workspace_id = inv.workspace_id and user_id = (select auth.uid())) then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (inv.workspace_id, (select auth.uid()), inv.role);
  end if;
  update public.invitations set status = 'accepted', accepted_at = now(), accepted_by = (select auth.uid()) where id = inv.id;
  select * into ws from public.workspaces where id = inv.workspace_id;
  return ws;
end; $$;

-- Idempotent replay: re-assert the grants (CREATE OR REPLACE preserves ACLs on an
-- existing function, but a from-zero replay needs them stated).
revoke all on function private._accept_invitation(uuid) from public;
grant execute on function private._accept_invitation(uuid) to authenticated;
