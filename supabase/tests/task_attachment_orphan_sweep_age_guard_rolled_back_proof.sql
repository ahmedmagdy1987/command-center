-- ============================================================================
-- Command Center — TASK-ATTACHMENT ORPHAN-SWEEP 1-HOUR AGE GUARD PROOF (6 assertions)
-- BUG B (20260715142424_task_attachment_sweep_age_guard.sql): an in-flight upload
-- (blob written, metadata row not yet inserted — src/lib/api.js:977-981) must NOT be
-- swept. The hardened private._sweep_orphan_task_attachments() only collects orphans
-- OLDER than 1 hour, so no live upload can be racing.
-- ============================================================================
-- Victim predicate under test (from the migration):
--   delete from storage.objects o
--    where o.bucket_id='task-attachments'
--      and o.created_at < now() - interval '1 hour'          <-- the age guard (BUG B fix)
--      and not exists (select 1 from public.task_attachments a where a.storage_path=o.name);
--
-- This proof runs as `postgres`: the sweep is a SECURITY DEFINER pg_cron GC, NOT an
-- RLS surface, so there is no impersonation harness. It STILL carries an anti-vacuity
-- guard (all 5 planted objects + the linked metadata row must exist BEFORE the sweep,
-- else "survived / deleted" would be about rows that never existed) and a completeness
-- guard (exactly 6 assertion rows, no NULL pass).
--
-- DISCRIMINATION (why this is not vacuous): every "no-metadata" object is a genuine
-- orphan by the metadata test; A2 (old, deleted) and A3 (young, survives) differ ONLY
-- in created_at. If the `created_at < now()-1h` clause were removed, A3 and A5 would
-- flip to DELETED and go RED. A3 is the CORE property (the in-flight upload survives).
-- A4 survives for the OTHER reason (a metadata row exists) — proving the sweep still
-- honours linkage. A2/A6 prove real orphans are still collected (the sweep isn't inert).
--
-- Fixtures use a unique suffix and the whole script is one begin;…rollback; — nothing
-- commits, including the sweep's own deletions of any pre-existing live orphans.
-- Verified live against nqlzjuxqgajeoypyzlnv: 6/6 pass, 0 residue.
-- ============================================================================

begin;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;

do $sweep$
declare
  v_sfx  text := replace(gen_random_uuid()::text,'-','');
  v_ws   uuid; v_owner uuid; v_task text;
  n_orphan_old  text := 'task-attachments/sweep-'||v_sfx||'/orphan-old.pdf';
  n_inflight    text := 'task-attachments/sweep-'||v_sfx||'/inflight-young.pdf';
  n_linked_old  text := 'task-attachments/sweep-'||v_sfx||'/linked-old.pdf';
  n_b59         text := 'task-attachments/sweep-'||v_sfx||'/boundary-59.pdf';
  n_b61         text := 'task-attachments/sweep-'||v_sfx||'/boundary-61.pdf';
  v_n int;
begin
  -- ---- discover a real workspace + owner (nothing hardcoded); build a task for the linked metadata row ----
  select w.id into v_ws from public.workspaces w
    join public.workspace_members wm on wm.workspace_id=w.id
    group by w.id, w.created_at order by count(*) desc, w.created_at limit 1;
  select wm.user_id into v_owner from public.workspace_members wm
    where wm.workspace_id=v_ws and wm.role='owner' order by wm.created_at limit 1;
  if v_ws is null or v_owner is null then
    raise exception 'PRECONDITION: need a workspace with an owner';
  end if;

  v_task := 'sweep-task-'||v_sfx;
  insert into public.tasks (id,title,privacy,project,workspace_id,created_by,assignee_id)
  values (v_task,'sweep fixture task','workspace','other',v_ws,v_owner,v_owner);

  -- ---- plant 5 bucket objects with CONTROLLED created_at + controlled metadata presence ----
  insert into storage.objects (bucket_id,name,owner,owner_id,metadata,created_at) values
    ('task-attachments', n_orphan_old, v_owner, v_owner::text, jsonb_build_object('size',4096,'mimetype','application/pdf'), now()-interval '2 hours'),
    ('task-attachments', n_inflight,   v_owner, v_owner::text, jsonb_build_object('size',4096,'mimetype','application/pdf'), now()),
    ('task-attachments', n_linked_old, v_owner, v_owner::text, jsonb_build_object('size',4096,'mimetype','application/pdf'), now()-interval '2 hours'),
    ('task-attachments', n_b59,        v_owner, v_owner::text, jsonb_build_object('size',4096,'mimetype','application/pdf'), now()-interval '59 minutes'),
    ('task-attachments', n_b61,        v_owner, v_owner::text, jsonb_build_object('size',4096,'mimetype','application/pdf'), now()-interval '61 minutes');

  -- ONLY the linked object gets a metadata row (workspace_id stamped by the BEFORE INSERT trigger).
  insert into public.task_attachments (task_id,uploaded_by,storage_path,filename,mime_type,size_bytes)
  values (v_task, v_owner, n_linked_old, 'linked.pdf','application/pdf',4096);

  -- ===== ANTI-VACUITY GUARD: everything the sweep will judge must exist first =====
  select count(*) into v_n from storage.objects
   where bucket_id='task-attachments' and name in (n_orphan_old,n_inflight,n_linked_old,n_b59,n_b61);
  if v_n <> 5 then raise exception 'VACUOUS: expected 5 planted objects pre-sweep, found %', v_n; end if;
  select count(*) into v_n from public.task_attachments where storage_path=n_linked_old;
  if v_n <> 1 then raise exception 'VACUOUS: linked metadata row missing pre-sweep (found %)', v_n; end if;
  insert into _r values (1,'A1 anti-vacuity: 5 objects + linked metadata planted pre-sweep','5 objs / 1 meta',v_n::text||' meta',v_n=1);

  -- ============================ INVOKE THE SWEEP ONCE ============================
  perform private._sweep_orphan_task_attachments();

  -- ============================== ASSERT SURVIVORS ==============================
  -- A2: true orphan, OLD, no metadata -> collected.
  select count(*) into v_n from storage.objects where bucket_id='task-attachments' and name=n_orphan_old;
  insert into _r values (2,'A2 old orphan (no metadata, 2h) is swept','0 (gone)',v_n::text,v_n=0);

  -- A3 CORE: in-flight upload, YOUNG, no metadata -> survives (differs from A2 ONLY by age).
  select count(*) into v_n from storage.objects where bucket_id='task-attachments' and name=n_inflight;
  insert into _r values (3,'A3 [CORE] in-flight young orphan (no metadata, now()) SURVIVES','1 (kept)',v_n::text,v_n=1);

  -- A4: linked object (metadata row present), old -> never touched.
  select count(*) into v_n from storage.objects where bucket_id='task-attachments' and name=n_linked_old;
  insert into _r values (4,'A4 linked object (has metadata, 2h) is never touched','1 (kept)',v_n::text,v_n=1);

  -- A5: boundary 59 min < 1h -> survives.
  select count(*) into v_n from storage.objects where bucket_id='task-attachments' and name=n_b59;
  insert into _r values (5,'A5 boundary 59-min orphan (< 1h) survives','1 (kept)',v_n::text,v_n=1);

  -- A6: boundary 61 min > 1h -> collected (sweep still works; guard is bounded, not disabling).
  select count(*) into v_n from storage.objects where bucket_id='task-attachments' and name=n_b61;
  insert into _r values (6,'A6 boundary 61-min orphan (> 1h) is swept','0 (gone)',v_n::text,v_n=0);

  -- completeness guard
  select count(*) into v_n from _r;
  if v_n <> 6 then raise exception 'INCOMPLETE: % assertion rows, expected 6', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end
$sweep$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;

rollback;