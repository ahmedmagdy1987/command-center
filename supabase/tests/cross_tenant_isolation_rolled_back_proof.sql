-- ============================================================================
-- Command Center — CROSS-TENANT ISOLATION PROOF (48 assertions) — CORRECTED
-- ============================================================================
-- Verified live against nqlzjuxqgajeoypyzlnv 2026-07-15: 48/48 pass, 0 residue.
--
-- Changes vs the reviewed version:
--   1. ADDED  HARNESS GUARD      — raises unless current_user='authenticated',
--             rolbypassrls=false, and auth.uid()=the impersonated uid. Without
--             this the whole script silently passes as bypassrls `postgres`.
--   2. ADDED  ANTI-VACUITY GUARD — raises unless a legitimate member sees every
--             A-group surface non-zero. Makes "outsider sees 0" non-vacuous
--             in-script instead of relying on a separate out-of-band run.
--   3. FIXED  B06 — old B06 (colliding tasks.id -> 23505) passes even as
--             bypassrls postgres with ALL RLS gone => control-independent, proved
--             nothing. Demoted to a PREMISE guard; the assertion slot now tests
--             the real claim: comments_select_visible has NO workspace predicate,
--             so give the outsider a legitimate task+comment in their own WS2 and
--             assert their TOTAL visible comment count is exactly 1. If tasks RLS
--             were dropped, EXISTS() is true for every task -> outsider sees every
--             comment in the DB -> FAILS. That discriminates.
--   4. FIXED  C08/C16 — old versions (outsider soft-delete) never reached
--             enforce_message_edit_window: RLS USING filters the row before the
--             BEFORE UPDATE trigger fires, so they merely duplicated C07/C15's
--             messages_update_own check. Repointed at the trigger's previously
--             UNTESTED `raise 'delete window expired'` branch.
--   5. REMOVED `grant all on _r to authenticated` — dead (every insert into _r is
--             preceded by `reset role`) and a latent footgun.
--   6. ADDED  completeness guard — raises unless exactly 48 rows / no NULL pass.
--
-- Method: fixtures planted as `postgres` (bypassrls) to CONSTRUCT the scenario;
-- every ASSERTION runs as `authenticated` + request.jwt.claims, so RLS is under test.
-- Fully rolled back. An abort mid-script cannot commit (verified: canary row did
-- not leak even when the trailing `rollback;` was unreachable).
-- ============================================================================

begin;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;

create function pg_temp.imp(p_uid uuid) returns void language plpgsql as $fn$
declare v_email text;
begin
  execute 'reset role';
  select u.email into v_email from auth.users u where u.id = p_uid;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role','authenticated','email', coalesce(v_email,''))::text, true);
end $fn$;

do $iso$
declare
  v_ws1 uuid; v_owner uuid; v_co1 uuid; v_co2 uuid;
  v_out uuid := gen_random_uuid(); v_ws2 uuid := gen_random_uuid();
  v_sfx text := replace(gen_random_uuid()::text,'-',''); v_dm_lo uuid; v_dm_hi uuid;
  t_ws text; t_priv text; t_priv_asg text; t_out text; p_proj text;
  m_fresh uuid; m_old uuid; m_tomb uuid;
  d_conv uuid; d_fresh uuid; d_old uuid; d_tomb uuid;
  v_voice_path text; v_att_path text;
  v_n int; v_actual text; v_body text; v_ed timestamptz; v_del timestamptz;
begin
  -- 0. discover actors (nothing hardcoded)
  select w.id into v_ws1 from public.workspaces w join public.workspace_members wm on wm.workspace_id=w.id
  group by w.id, w.created_at order by count(*) desc, w.created_at limit 1;
  select wm.user_id into v_owner from public.workspace_members wm
  where wm.workspace_id=v_ws1 and wm.role='owner' order by wm.created_at limit 1;
  select wm.user_id into v_co1 from public.workspace_members wm
  where wm.workspace_id=v_ws1 and wm.user_id<>v_owner and wm.role<>'guest' order by wm.created_at limit 1;
  select wm.user_id into v_co2 from public.workspace_members wm
  where wm.workspace_id=v_ws1 and wm.user_id not in (v_owner,v_co1) and wm.role<>'guest' order by wm.created_at limit 1;
  if v_ws1 is null or v_owner is null or v_co1 is null or v_co2 is null then
    raise exception 'PRECONDITION: need a workspace with an owner + 2 non-guest co-members';
  end if;
  v_dm_lo := least(v_co1,v_co2); v_dm_hi := greatest(v_co1,v_co2);

  -- 1. throwaway tenant
  insert into auth.users (id,email,aud,role)
  values (v_out,'iso-outsider-'||v_sfx||'@example.invalid','authenticated','authenticated');
  insert into public.workspaces (id,name,owner_id,slug) values (v_ws2,'ISO Throwaway WS2',v_out,'iso-throwaway-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values (v_ws2,v_out,'owner');

  -- 2. fixtures inside WS1
  t_ws:='iso-tws-'||v_sfx; t_priv:='iso-tpriv-'||v_sfx; t_priv_asg:='iso-tpasg-'||v_sfx;
  t_out:='iso-tout-'||v_sfx; p_proj:='iso-proj-'||v_sfx;

  insert into public.projects (id,name,workspace_id,created_by) values (p_proj,'ISO Project',v_ws1,v_owner);
  insert into public.tasks (id,title,privacy,project,workspace_id,created_by,assignee_id) values
    (t_ws,'ISO shared task','workspace',p_proj,v_ws1,v_owner,v_owner),
    (t_priv,'ISO private task (owner)','private',p_proj,v_ws1,v_owner,v_owner),
    (t_priv_asg,'ISO private task (co1)','private',p_proj,v_ws1,v_owner,v_co1);
  insert into public.comments (task_id,author_id,body,workspace_id) values
    (t_ws,v_owner,'ISO comment on shared task',v_ws1),
    (t_priv,v_owner,'ISO comment on private task',v_ws1),
    (t_priv_asg,v_owner,'ISO comment on assigned task',v_ws1);
  insert into public.invitations (workspace_id,email,role,invited_by)
  values (v_ws1,'iso-invitee-'||v_sfx||'@example.invalid','member',v_owner);
  insert into public.messages (sender_id,body,workspace_id) values (v_owner,'ISO fresh msg',v_ws1) returning id into m_fresh;
  insert into public.messages (sender_id,body,workspace_id,created_at)
  values (v_owner,'ISO old msg',v_ws1,now()-interval '1 hour') returning id into m_old;
  insert into public.messages (sender_id,body,workspace_id) values (v_owner,'ISO tombstone msg',v_ws1) returning id into m_tomb;

  v_voice_path := v_owner::text||'/iso-'||v_sfx||'.webm';
  insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
  values ('voice-notes',v_voice_path,v_owner,v_owner::text,jsonb_build_object('size',2048,'mimetype','audio/webm'));
  insert into public.messages (sender_id,audio_path,audio_duration_seconds,workspace_id) values (v_owner,v_voice_path,3,v_ws1);

  v_att_path := v_ws1::text||'/'||t_ws||'/iso-'||v_sfx||'.pdf';
  insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
  values ('task-attachments',v_att_path,v_owner,v_owner::text,jsonb_build_object('size',4096,'mimetype','application/pdf'));
  insert into public.task_attachments (task_id,uploaded_by,storage_path,filename,mime_type,size_bytes)
  values (t_ws,v_owner,v_att_path,'iso.pdf','application/pdf',4096);

  select c.id into d_conv from public.dm_conversations c
  where c.workspace_id=v_ws1 and c.user_lo=v_dm_lo and c.user_hi=v_dm_hi;
  if d_conv is null then
    insert into public.dm_conversations (workspace_id,user_lo,user_hi) values (v_ws1,v_dm_lo,v_dm_hi) returning id into d_conv;
  end if;
  insert into public.dm_messages (conversation_id,sender_id,body) values (d_conv,v_co1,'ISO fresh dm') returning id into d_fresh;
  insert into public.dm_messages (conversation_id,sender_id,body,created_at)
  values (d_conv,v_co1,'ISO old dm',now()-interval '1 hour') returning id into d_old;
  insert into public.dm_messages (conversation_id,sender_id,body) values (d_conv,v_co1,'ISO tombstone dm') returning id into d_tomb;
  if not exists (select 1 from public.dm_reads r where r.conversation_id=d_conv and r.user_id=v_co1) then
    insert into public.dm_reads (conversation_id,user_id,last_read_at) values (d_conv,v_co1,now());
  end if;

  -- ===== HARNESS GUARD: impersonation must be real, else every assertion is worthless =====
  perform pg_temp.imp(v_out);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role not switched (current_user=%)', current_user; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: assertion role bypasses RLS'; end if;
  if auth.uid() is distinct from v_out then execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid() != impersonated uid'; end if;
  execute 'reset role';

  -- ===== ANTI-VACUITY GUARD: a legit member must SEE what the outsider must not =====
  perform pg_temp.imp(v_owner);
  select count(*) into v_n from public.tasks where workspace_id=v_ws1; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: tasks'; end if;
  select count(*) into v_n from public.projects where workspace_id=v_ws1; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: projects'; end if;
  select count(*) into v_n from public.comments where workspace_id=v_ws1; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: comments'; end if;
  select count(*) into v_n from public.messages where workspace_id=v_ws1; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: messages'; end if;
  select count(*) into v_n from public.notifications where workspace_id=v_ws1; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: notifications'; end if;
  select count(*) into v_n from public.workspaces where id=v_ws1; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: workspaces'; end if;
  select count(*) into v_n from public.workspace_members where workspace_id=v_ws1; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: workspace_members'; end if;
  select count(*) into v_n from public.members where id in (v_owner,v_co1,v_co2); if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: members'; end if;
  select count(*) into v_n from public.invitations where workspace_id=v_ws1; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: invitations'; end if;
  select count(*) into v_n from public.task_attachments where workspace_id=v_ws1; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: task_attachments'; end if;
  select count(*) into v_n from storage.objects where bucket_id='voice-notes' and name=v_voice_path; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: voice obj'; end if;
  select count(*) into v_n from storage.objects where bucket_id='task-attachments' and name=v_att_path; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: attach obj'; end if;
  execute 'reset role';
  perform pg_temp.imp(v_co1);
  select count(*) into v_n from public.dm_conversations where id=d_conv; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: dm_conversations'; end if;
  select count(*) into v_n from public.dm_messages where conversation_id=d_conv; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: dm_messages'; end if;
  select count(*) into v_n from public.dm_reads where conversation_id=d_conv; if v_n=0 then execute 'reset role'; raise exception 'VACUOUS: dm_reads'; end if;
  execute 'reset role';

  -- ===== PREMISE (was the old B06 "assertion"): tasks.id is a global PK. =====
  -- Not an assertion: this passes even with ALL RLS removed, so it discriminates nothing.
  perform pg_temp.imp(v_out);
  begin
    insert into public.tasks (id,title,privacy,workspace_id,created_by) values (t_priv,'colliding id','workspace',v_ws2,v_out);
    v_actual := 'ALLOWED';
  exception when others then v_actual := sqlstate; end;
  execute 'reset role';
  if v_actual <> '23505' then raise exception 'PREMISE BROKEN: colliding tasks.id gave % not 23505', v_actual; end if;

  -- ========================= GROUP A — 23 cross-table =========================
  perform pg_temp.imp(v_out); select count(*) into v_n from public.tasks where workspace_id=v_ws1;
  execute 'reset role'; insert into _r values (1,'A01 outsider reads WS1 tasks','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.projects where workspace_id=v_ws1;
  execute 'reset role'; insert into _r values (2,'A02 outsider reads WS1 projects','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.comments where workspace_id=v_ws1;
  execute 'reset role'; insert into _r values (3,'A03 outsider reads WS1 comments','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.messages where workspace_id=v_ws1;
  execute 'reset role'; insert into _r values (4,'A04 outsider reads WS1 team messages','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.notifications where workspace_id=v_ws1;
  execute 'reset role'; insert into _r values (5,'A05 outsider reads WS1 notifications','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.workspaces where id=v_ws1;
  execute 'reset role'; insert into _r values (6,'A06 outsider reads WS1 workspace row','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.workspace_members where workspace_id=v_ws1;
  execute 'reset role'; insert into _r values (7,'A07 outsider reads WS1 workspace_members','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.members where id in (v_owner,v_co1,v_co2);
  execute 'reset role'; insert into _r values (8,'A08 outsider reads WS1 member roster','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.invitations where workspace_id=v_ws1;
  execute 'reset role'; insert into _r values (9,'A09 outsider reads WS1 invitations','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.dm_conversations where workspace_id=v_ws1;
  execute 'reset role'; insert into _r values (10,'A10 outsider reads WS1 dm_conversations','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.dm_messages where workspace_id=v_ws1;
  execute 'reset role'; insert into _r values (11,'A11 outsider reads WS1 dm_messages','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.dm_reads where conversation_id=d_conv;
  execute 'reset role'; insert into _r values (12,'A12 outsider reads WS1 dm_reads','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from public.task_attachments where workspace_id=v_ws1;
  execute 'reset role'; insert into _r values (13,'A13 outsider reads WS1 task_attachments','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from storage.objects where bucket_id='voice-notes' and name=v_voice_path;
  execute 'reset role'; insert into _r values (14,'A14 outsider reads WS1 voice-note object','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_out); select count(*) into v_n from storage.objects where bucket_id='task-attachments' and name=v_att_path;
  execute 'reset role'; insert into _r values (15,'A15 outsider reads WS1 task-attachment object','0',v_n::text,v_n=0);

  perform pg_temp.imp(v_out);
  begin insert into public.tasks (id,title,privacy,project,workspace_id,created_by)
    values ('iso-evil-'||v_sfx,'evil','workspace',p_proj,v_ws1,v_out); v_actual:='ALLOWED';
  exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (16,'A16 outsider INSERT task into WS1','42501',v_actual,v_actual='42501');
  perform pg_temp.imp(v_out); update public.tasks set title='hijacked' where workspace_id=v_ws1; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (17,'A17 outsider UPDATE WS1 tasks','0 rows',v_n::text||' rows',v_n=0);
  perform pg_temp.imp(v_out); delete from public.tasks where workspace_id=v_ws1; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (18,'A18 outsider DELETE WS1 tasks','0 rows',v_n::text||' rows',v_n=0);
  perform pg_temp.imp(v_out);
  begin insert into public.projects (id,name,workspace_id,created_by) values ('iso-evilproj-'||v_sfx,'evil',v_ws1,v_out); v_actual:='ALLOWED';
  exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (19,'A19 outsider INSERT project into WS1','42501',v_actual,v_actual='42501');
  perform pg_temp.imp(v_out);
  begin insert into public.comments (task_id,author_id,body,workspace_id) values (t_ws,v_out,'evil',v_ws1); v_actual:='ALLOWED';
  exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (20,'A20 outsider INSERT comment on WS1 task','42501',v_actual,v_actual='42501');
  perform pg_temp.imp(v_out);
  begin insert into public.messages (sender_id,body,workspace_id) values (v_out,'evil',v_ws1); v_actual:='ALLOWED';
  exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (21,'A21 outsider INSERT message into WS1','42501',v_actual,v_actual='42501');
  perform pg_temp.imp(v_out);
  begin insert into public.workspace_members (workspace_id,user_id,role) values (v_ws1,v_out,'owner'); v_actual:='ALLOWED';
  exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (22,'A22 outsider self-joins WS1 (direct INSERT)','42501',v_actual,v_actual='42501');
  perform pg_temp.imp(v_out);
  begin perform public.project_task_count(p_proj,v_ws1); v_actual:='ALLOWED';
  exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (23,'A23 outsider RPC IDOR project_task_count(WS1)','42501',v_actual,v_actual='42501');

  -- ========================= GROUP B — 6 comments-inheritance =========================
  perform pg_temp.imp(v_out); select count(*) into v_n from public.comments where task_id=t_priv;
  execute 'reset role'; insert into _r values (24,'B01 outsider reads comment on WS1 private task','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_co1); select count(*) into v_n from public.comments where task_id=t_priv;
  execute 'reset role'; insert into _r values (25,'B02 co-member reads comment on another''s private task','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_owner); select count(*) into v_n from public.comments where task_id=t_priv;
  execute 'reset role'; insert into _r values (26,'B03 creator reads comment on own private task','1',v_n::text,v_n=1);
  perform pg_temp.imp(v_co1); select count(*) into v_n from public.comments where task_id=t_priv_asg;
  execute 'reset role'; insert into _r values (27,'B04 assignee reads comment on private task assigned to them','1',v_n::text,v_n=1);
  perform pg_temp.imp(v_co1); select count(*) into v_n from public.comments where task_id=t_ws;
  execute 'reset role'; insert into _r values (28,'B05 co-member reads comment on workspace-privacy task','1',v_n::text,v_n=1);
  -- B06 (REPLACED — see header note 3)
  perform pg_temp.imp(v_out);
  begin
    insert into public.tasks (id,title,privacy,project,workspace_id,created_by,assignee_id)
    values (t_out,'outsider own task','workspace','other',v_ws2,v_out,v_out);
    insert into public.comments (task_id,author_id,body,workspace_id) values (t_out,v_out,'outsider own comment',v_ws2);
    select count(*) into v_n from public.comments; v_actual := v_n::text;
  exception when others then v_actual := 'ERR:'||sqlstate; end;
  execute 'reset role';
  insert into _r values (29,'B06 comments-inheritance confines outsider to own ws (TOTAL visible comments)','1',v_actual,v_actual='1');

  -- ========================= GROUP C — 16 edit / soft-delete =========================
  perform pg_temp.imp(v_owner);
  update public.messages set body='ISO edited', edited_at='2000-01-01'::timestamptz where id=m_fresh; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (30,'C01 msg: sender edits own fresh message','1 rows',v_n::text||' rows',v_n=1);
  perform pg_temp.imp(v_owner); select edited_at into v_ed from public.messages where id=m_fresh;
  v_actual := case when v_ed is not null and v_ed > now()-interval '2 minutes' then 'SERVER_STAMPED' else 'CLIENT_VALUE:'||coalesce(v_ed::text,'NULL') end;
  execute 'reset role'; insert into _r values (31,'C02 msg: edited_at stamped server-side','SERVER_STAMPED',v_actual,v_actual='SERVER_STAMPED');
  perform pg_temp.imp(v_co1); update public.messages set body='hijacked' where id=m_fresh; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (32,'C03 msg: non-sender co-member edits another''s message','0 rows',v_n::text||' rows',v_n=0);
  perform pg_temp.imp(v_owner);
  begin update public.messages set body='too late' where id=m_old; v_actual:='ALLOWED';
  exception when others then v_actual:=sqlerrm; end;
  execute 'reset role'; insert into _r values (33,'C04 msg: sender edits message older than 10 min','edit window expired',v_actual,v_actual='edit window expired');
  perform pg_temp.imp(v_owner);
  update public.messages set deleted_at='2000-01-01'::timestamptz where id=m_tomb;
  select body, deleted_at into v_body, v_del from public.messages where id=m_tomb;
  v_actual := case when v_body is null and v_del is not null and v_del > now()-interval '2 minutes' then 'TOMBSTONED'
                   else 'body='||coalesce(v_body,'NULL')||' deleted_at='||coalesce(v_del::text,'NULL') end;
  execute 'reset role'; insert into _r values (34,'C05 msg: soft-delete strips content + server-stamps deleted_at','TOMBSTONED',v_actual,v_actual='TOMBSTONED');
  perform pg_temp.imp(v_owner);
  begin update public.messages set body='resurrected' where id=m_tomb; v_actual:='ALLOWED';
  exception when others then v_actual:=sqlerrm; end;
  execute 'reset role'; insert into _r values (35,'C06 msg: tombstone is immutable','message already deleted',v_actual,v_actual='message already deleted');
  perform pg_temp.imp(v_out); update public.messages set body='evil' where id=m_fresh; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (36,'C07 msg: outsider edits WS1 message','0 rows',v_n::text||' rows',v_n=0);
  -- C08 (REPLACED — see header note 4)
  perform pg_temp.imp(v_owner);
  begin update public.messages set deleted_at=now() where id=m_old; v_actual:='ALLOWED';
  exception when others then v_actual:=sqlerrm; end;
  execute 'reset role'; insert into _r values (37,'C08 msg: sender soft-deletes message older than 10 min','delete window expired',v_actual,v_actual='delete window expired');

  perform pg_temp.imp(v_co1);
  update public.dm_messages set body='ISO dm edited', edited_at='2000-01-01'::timestamptz where id=d_fresh; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (38,'C09 dm: sender edits own fresh DM','1 rows',v_n::text||' rows',v_n=1);
  perform pg_temp.imp(v_co1); select edited_at into v_ed from public.dm_messages where id=d_fresh;
  v_actual := case when v_ed is not null and v_ed > now()-interval '2 minutes' then 'SERVER_STAMPED' else 'CLIENT_VALUE:'||coalesce(v_ed::text,'NULL') end;
  execute 'reset role'; insert into _r values (39,'C10 dm: edited_at stamped server-side','SERVER_STAMPED',v_actual,v_actual='SERVER_STAMPED');
  perform pg_temp.imp(v_co2); update public.dm_messages set body='hijacked' where id=d_fresh; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (40,'C11 dm: other participant edits sender''s DM','0 rows',v_n::text||' rows',v_n=0);
  perform pg_temp.imp(v_co1);
  begin update public.dm_messages set body='too late' where id=d_old; v_actual:='ALLOWED';
  exception when others then v_actual:=sqlerrm; end;
  execute 'reset role'; insert into _r values (41,'C12 dm: sender edits DM older than 10 min','edit window expired',v_actual,v_actual='edit window expired');
  perform pg_temp.imp(v_co1);
  update public.dm_messages set deleted_at='2000-01-01'::timestamptz where id=d_tomb;
  select body, deleted_at into v_body, v_del from public.dm_messages where id=d_tomb;
  v_actual := case when v_body is null and v_del is not null and v_del > now()-interval '2 minutes' then 'TOMBSTONED'
                   else 'body='||coalesce(v_body,'NULL')||' deleted_at='||coalesce(v_del::text,'NULL') end;
  execute 'reset role'; insert into _r values (42,'C13 dm: soft-delete strips content + server-stamps deleted_at','TOMBSTONED',v_actual,v_actual='TOMBSTONED');
  perform pg_temp.imp(v_co1);
  begin update public.dm_messages set body='resurrected' where id=d_tomb; v_actual:='ALLOWED';
  exception when others then v_actual:=sqlerrm; end;
  execute 'reset role'; insert into _r values (43,'C14 dm: tombstone is immutable','message already deleted',v_actual,v_actual='message already deleted');
  perform pg_temp.imp(v_out); update public.dm_messages set body='evil' where id=d_fresh; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (44,'C15 dm: outsider edits WS1 DM','0 rows',v_n::text||' rows',v_n=0);
  -- C16 (REPLACED — see header note 4)
  perform pg_temp.imp(v_co1);
  begin update public.dm_messages set deleted_at=now() where id=d_old; v_actual:='ALLOWED';
  exception when others then v_actual:=sqlerrm; end;
  execute 'reset role'; insert into _r values (45,'C16 dm: sender soft-deletes DM older than 10 min','delete window expired',v_actual,v_actual='delete window expired');

  -- ========================= GROUP D — 3 DM-participant =========================
  perform pg_temp.imp(v_owner); select count(*) into v_n from public.dm_conversations where id=d_conv;
  execute 'reset role'; insert into _r values (46,'D01 co-member non-participant reads dm_conversations','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_owner); select count(*) into v_n from public.dm_messages where conversation_id=d_conv;
  execute 'reset role'; insert into _r values (47,'D02 co-member non-participant reads dm_messages','0',v_n::text,v_n=0);
  perform pg_temp.imp(v_owner); select count(*) into v_n from public.dm_reads where conversation_id=d_conv;
  execute 'reset role'; insert into _r values (48,'D03 co-member non-participant reads dm_reads','0',v_n::text,v_n=0);
  execute 'reset role';

  -- completeness guard
  select count(*) into v_n from _r;
  if v_n <> 48 then raise exception 'INCOMPLETE: % assertion rows, expected 48', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end
$iso$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;

rollback;
