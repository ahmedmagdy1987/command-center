-- @mention notifications (comments + team chat). Explicit mentions uuid[] (no text parsing).
-- VISIBILITY-GATED: a mention notifies a user ONLY if they could already see the surface — a comment
-- mention requires the mentioned user can see the task (guests: own/assigned only); a team-chat mention
-- requires a non-guest member. Non-members / unauthorized mentions are silently dropped. Mention
-- supersedes comment_added for the same recipient (no double-notify). notifications RLS unchanged.

alter table public.comments add column if not exists mentions uuid[] not null default '{}';
alter table public.messages add column if not exists mentions uuid[] not null default '{}';

-- Visibility helpers evaluated for an ARBITRARY user (not auth.uid()). Mirror the live policies:
--   can_see_task   == tasks_select_role for p_user
--   can_see_team_chat == messages_select_member for p_user
create or replace function private.can_see_task(p_user uuid, p_task text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task
      and exists (select 1 from public.workspace_members wm where wm.workspace_id = t.workspace_id and wm.user_id = p_user)
      and (t.privacy = 'workspace' or (t.privacy = 'private' and (t.created_by = p_user or t.assignee_id = p_user)))
      and (coalesce((select wm2.role from public.workspace_members wm2 where wm2.workspace_id = t.workspace_id and wm2.user_id = p_user), '') <> 'guest'
           or t.created_by = p_user or t.assignee_id = p_user)
  );
$$;
create or replace function private.can_see_team_chat(p_user uuid, p_ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members wm where wm.workspace_id = p_ws and wm.user_id = p_user)
     and coalesce((select wm2.role from public.workspace_members wm2 where wm2.workspace_id = p_ws and wm2.user_id = p_user), '') <> 'guest';
$$;
revoke all on function private.can_see_task(uuid,text)        from public, anon;
revoke all on function private.can_see_team_chat(uuid,uuid)   from public, anon;

-- Dedup: comment_added no longer notifies a participant who is also @mentioned (they get the mention).
-- Copy + recipients otherwise unchanged.
create or replace function public.notify_on_comment_added()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_creator uuid; v_assignee uuid; v_ws uuid; v_title text;
begin
  select t.created_by, t.assignee_id, t.workspace_id, t.title
    into v_creator, v_assignee, v_ws, v_title
  from public.tasks t where t.id = new.task_id;
  insert into public.notifications (recipient_id, actor_id, task_id, type, title, message, workspace_id)
  select distinct r, new.author_id, new.task_id, 'comment_added', 'New comment',
         'New comment on "' || coalesce(v_title, 'Untitled') || '".', v_ws
  from (values (v_creator), (v_assignee)) as x(r)
  where r is not null and r <> new.author_id and not (r = any (coalesce(new.mentions, '{}'::uuid[])));
  return new;
end; $$;

-- NEW: comment mention -> only mentioned users who can SEE the task
create or replace function public.notify_on_comment_mention()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ws uuid; v_title text; v_name text; m uuid;
begin
  if new.mentions is null or array_length(new.mentions, 1) is null then return new; end if;
  select t.workspace_id, t.title into v_ws, v_title from public.tasks t where t.id = new.task_id;
  select coalesce(mm.display_name, mm.email, 'Someone') into v_name from public.members mm where mm.id = new.author_id;
  for m in select distinct u from unnest(new.mentions) as u loop
    if m is not null and m <> new.author_id and private.can_see_task(m, new.task_id) then
      insert into public.notifications (recipient_id, actor_id, task_id, type, title, message, workspace_id)
      values (m, new.author_id, new.task_id, 'mention', 'Mentioned you',
              coalesce(v_name, 'Someone') || ' mentioned you in a comment on "' || coalesce(v_title, 'Untitled') || '".', v_ws);
    end if;
  end loop;
  return new;
end; $$;

-- NEW: team-chat mention -> only non-guest members (guests are excluded from team chat)
create or replace function public.notify_on_message_mention()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_name text; m uuid;
begin
  if new.mentions is null or array_length(new.mentions, 1) is null then return new; end if;
  select coalesce(mm.display_name, mm.email, 'Someone') into v_name from public.members mm where mm.id = new.sender_id;
  for m in select distinct u from unnest(new.mentions) as u loop
    if m is not null and m <> new.sender_id and private.can_see_team_chat(m, new.workspace_id) then
      insert into public.notifications (recipient_id, actor_id, task_id, ref_id, type, title, message, workspace_id)
      values (m, new.sender_id, null, null, 'mention', 'Mentioned you',
              coalesce(v_name, 'Someone') || ' mentioned you in #Team.', new.workspace_id);
    end if;
  end loop;
  return new;
end; $$;

revoke all on function public.notify_on_comment_mention() from public, anon, authenticated;
revoke all on function public.notify_on_message_mention() from public, anon, authenticated;

drop trigger if exists notify_on_comment_mention on public.comments;
create trigger notify_on_comment_mention after insert on public.comments
  for each row execute function public.notify_on_comment_mention();
drop trigger if exists notify_on_message_mention on public.messages;
create trigger notify_on_message_mention after insert on public.messages
  for each row execute function public.notify_on_message_mention();
