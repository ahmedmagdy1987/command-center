-- ============================================================================================
-- Guest avatar over-exposure — scope the avatar visibility predicate to the ROSTER's guest rule
-- Proven 13/13 rolled-back (supabase/tests/guest_scoped_avatar_visibility_rolled_back_proof.sql),
-- including the anti-vacuity mutation (reverting the predicate makes the leak return).
-- Re-verified 7/7 live post-apply against the real DB.
--
-- THE DEFECT (found by the post-deploy audit of 20260722061442, confirmed by RUNNING against live).
-- `private.is_visible_avatar_object` gated on `private.shares_workspace` — a plain membership-overlap
-- check with NO guest clause. Result, reproduced live: a GUEST could SELECT (and therefore sign a URL
-- for) the avatar object of an ARBITRARY co-member — someone the roster deliberately hides from them
-- and whose `members` row they cannot read at all. Measured: guest → non-peer avatar object = 1 row,
-- while the same guest got 0 from `public.members` and 0 from `workspace_members_list`.
--
-- WHY IT HAPPENED, because the shape will recur. The policy helper is SECURITY DEFINER *on purpose*
-- (a storage policy whose correctness rides on another table's RLS is a coupling that breaks
-- quietly). But going DEFINER means the guest exclusion baked into `public.members`' own policy no
-- longer applies, so the share check had to be re-applied explicitly — and it reached for
-- `shares_workspace`, the PRE-2026-07-06 helper, instead of the guest-scoped rule that
-- 20260706035653 introduced everywhere else. Contrast `voice_notes_select_member`, which uses a
-- NON-definer EXISTS over `messages` and therefore inherits the guest exclusion for free (verified:
-- a guest reads 0 of a team-chat voice-note object).
-- **Lesson: the moment a storage policy helper becomes DEFINER, every visibility rule it used to
-- inherit must be restated by hand. Enumerate them; do not assume.**
--
-- THE FIX IS NOT `can_see_member_profile`. That helper's guest branch is `me.role <> 'guest'`, so for
-- a GUEST CALLER it collapses to `p_target = auth.uid()` — self only. Using it would have returned 0
-- for a guest's genuine task/DM peers and degraded their faces to initials, contradicting the
-- product decision. Proven live: the roster returns 2 peers to that guest, so those faces must render.
--
-- THE RULE APPLIED HERE mirrors `private._workspace_members_list`'s guest clause: a non-guest sees any
-- co-member; a guest sees themselves, plus anyone they share a TASK or a DM with. Avatars carry no
-- workspace context, so it generalises to "in AT LEAST ONE shared workspace, the roster would show me
-- this person".
--
-- ⚠⚠ SYNC DEBT — DELIBERATE, RECORDED, NOT AN OVERSIGHT.
--    `private.can_see_member_avatar` (here) and `private._workspace_members_list` (the roster RPC)
--    now implement the SAME guest rule in TWO places, and they CAN DRIFT. They were left separate on
--    purpose: re-pointing the roster RPC at this helper touches a function carrying 40+ live
--    assertions, and that blast radius is not worth it inside a security fix. **If you change the
--    guest visibility rule, change it in BOTH.** A matching warning sits inline on the roster RPC in
--    20260716110514, and in CLAUDE.md under *Guest predicate sync debt*.
--
-- NON-GUESTS ARE UNAFFECTED, provably: for a non-guest caller the predicate reduces to the same
-- membership overlap `shares_workspace` performed, and `me.role <> 'guest'` short-circuits the OR
-- before the task/DM subqueries are ever evaluated — so this is also not a hot-path cost for them.
-- ============================================================================================

-- ------------------------------------------------------------------ 1. the guest-scoped predicate
create or replace function private.can_see_member_avatar(p_target uuid) returns boolean
language sql stable security definer set search_path to '' as $fn$
  -- MIRRORS the guest clause of private._workspace_members_list. KEEP THE TWO IN SYNC (see header).
  select p_target = (select auth.uid())
      or exists (
        select 1
        from public.workspace_members me
        join public.workspace_members them on them.workspace_id = me.workspace_id
        where me.user_id = (select auth.uid())
          and them.user_id = p_target
          and (
            me.role <> 'guest'
            or exists (select 1 from public.tasks t
                        where t.workspace_id = me.workspace_id
                          and (select auth.uid()) in (t.created_by, t.assignee_id)
                          and p_target in (t.created_by, t.assignee_id))
            or exists (select 1 from public.dm_conversations c
                        where c.workspace_id = me.workspace_id
                          and (select auth.uid()) in (c.user_lo, c.user_hi)
                          and p_target in (c.user_lo, c.user_hi))
          )
      );
$fn$;
revoke execute on function private.can_see_member_avatar(uuid) from public, anon;
grant  execute on function private.can_see_member_avatar(uuid) to authenticated;

-- ------------------------------------------------------------------ 2. re-point the predicate
-- No policy changes: avatars_select_shared_workspace already delegates here, so the whole fix lands
-- inside the helper. avatars_select_own is untouched and still covers your own not-yet-referenced
-- upload (which by definition no members row points at).
create or replace function private.is_visible_avatar_object(p_name text) returns boolean
language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.members m
     where m.avatar_url = p_name
       and private.can_see_member_avatar(m.id)
  );
$fn$;

-- ------------------------------------------------------------------ 3. retire the old semantic
-- `private.shares_workspace` (Phase 3A, 20260530193541) was the LAST pre-guest-scoping visibility
-- helper still in use, and after step 2 it has ZERO references anywhere: no policy, no function, no
-- view, no constraint (asserted D01 in the proof). Dropping it removes the footgun rather than
-- leaving a guest-blind helper lying around for the next person to reach for — which is exactly how
-- this defect happened. `members_select_self_or_shared` was re-pointed off it by 20260706035653.
drop function if exists private.shares_workspace(uuid);
