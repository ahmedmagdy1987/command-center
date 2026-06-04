-- Direct messages: 1:1 private chat between two members of the same workspace.
--
-- SEPARATE from the broadcast team chat (public.messages), whose SELECT is is_workspace_member
-- (every member sees every row). DMs need the opposite — visible to exactly two participants — so
-- they get their own tables + airtight participant-gated RLS, leaving the proven broadcast policies
-- untouched. Mirrors the project's comments-as-separate-table precedent.
--
-- Model: dm_conversations holds one CANONICAL row per pair per workspace (ordered user_lo<user_hi +
-- UNIQUE(workspace_id,user_lo,user_hi) make self-DMs and duplicate/ swapped pairs physically
-- impossible). dm_messages mirror public.messages (text + voice via the same voice-notes bucket).
-- dm_reads is the project's FIRST server-side read cursor (per participant) -> drives per-conversation
-- unread + read receipts, cross-device.
--
-- Writes are sanctioned-only: conversations are created ONLY by the Option-B RPC
-- get_or_create_dm_conversation (no INSERT policy/grant on dm_conversations); dm_messages.workspace_id
-- is stamped UNCONDITIONALLY from the conversation by a DEFINER BEFORE-INSERT trigger (a client cannot
-- smuggle a row into another tenant); notifications come only from the DEFINER notify_on_dm_message
-- trigger (clients have no INSERT grant on notifications). private.is_dm_participant (DEFINER) gates
-- every policy and avoids dm_messages<->dm_conversations RLS recursion.
--
-- Verified by a 14-check rolled-back RLS proof before apply: participant reads all; same-workspace
-- non-participant AND other-workspace member read ZERO across messages, conversation, dm_reads cursor,
-- voice-note signing, and the DM notification; sender forgery + foreign-conversation insert + direct
-- conversation insert + self-DM all rejected; workspace_id forgery overwritten to the true tenant;
-- conversation canonicalization (3 calls -> 1 id); leaver loses access; per-user baseline unchanged.

-- notifications: free task_id and add a polymorphic ref_id (a DM has no task; ref_id = conversation id)
alter table public.notifications alter column task_id drop not null;
alter table public.notifications add column if not exists ref_id text;

-- ===== tables =====
create table if not exists public.dm_conversations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_lo      uuid not null references auth.users(id) on delete cascade,
  user_hi      uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  constraint dm_conv_ordered check (user_lo < user_hi),
  constraint dm_conv_unique  unique (workspace_id, user_lo, user_hi)
);
create index if not exists dm_conversations_lo_idx on public.dm_conversations(user_lo);
create index if not exists dm_conversations_hi_idx on public.dm_conversations(user_hi);

create table if not exists public.dm_messages (
  id                     uuid primary key default gen_random_uuid(),
  conversation_id        uuid not null references public.dm_conversations(id) on delete cascade,
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  sender_id              uuid references auth.users(id) on delete set null,
  body                   text,
  audio_path             text,
  audio_duration_seconds integer,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint dm_text_or_audio check (body is not null or audio_path is not null)
);
create index if not exists dm_messages_conv_idx on public.dm_messages(conversation_id, created_at);

create table if not exists public.dm_reads (
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- ===== participant helper (DEFINER -> bypasses dm_conversations RLS; no policy recursion) =====
create or replace function private.is_dm_participant(p_conversation_id uuid)
returns boolean language sql security definer set search_path='' stable as $$
  select exists (
    select 1 from public.dm_conversations c
    where c.id = p_conversation_id and (select auth.uid()) in (c.user_lo, c.user_hi)
  );
$$;
revoke all on function private.is_dm_participant(uuid) from public, anon;
grant execute on function private.is_dm_participant(uuid) to authenticated;

-- ===== unconditional workspace_id stamp from the conversation (kills client workspace_id forgery) =====
create or replace function public.dm_set_workspace_id()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  select c.workspace_id into new.workspace_id from public.dm_conversations c where c.id = new.conversation_id;
  return new;
end;
$$;
revoke all on function public.dm_set_workspace_id() from public, anon, authenticated;
drop trigger if exists dm_messages_set_workspace_id on public.dm_messages;
create trigger dm_messages_set_workspace_id before insert on public.dm_messages
  for each row execute function public.dm_set_workspace_id();

-- ===== notify the OTHER participant (mirrors notify_*; sender is actor; self-send suppressed) =====
create or replace function public.notify_on_dm_message()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_recipient uuid; v_name text;
begin
  select case when new.sender_id = c.user_lo then c.user_hi else c.user_lo end
    into v_recipient from public.dm_conversations c where c.id = new.conversation_id;
  if v_recipient is not null and v_recipient <> new.sender_id then
    select coalesce(m.display_name, m.email, 'Someone') into v_name from public.members m where m.id = new.sender_id;
    insert into public.notifications (recipient_id, actor_id, task_id, ref_id, type, title, message, workspace_id)
    values (v_recipient, new.sender_id, null, new.conversation_id::text, 'dm_received', 'New message',
            'New message from ' || coalesce(v_name,'someone'), new.workspace_id);
  end if;
  return new;
end;
$$;
revoke all on function public.notify_on_dm_message() from public, anon, authenticated;
drop trigger if exists dm_messages_notify on public.dm_messages;
create trigger dm_messages_notify after insert on public.dm_messages
  for each row execute function public.notify_on_dm_message();

-- ===== canonical get-or-create conversation (Option-B: private DEFINER impl + public INVOKER wrapper) =====
create or replace function private._get_or_create_dm_conversation(p_workspace_id uuid, p_peer uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_uid uuid := auth.uid(); v_lo uuid; v_hi uuid; v_id uuid;
begin
  if v_uid is null then raise exception 'You must be signed in.' using errcode='28000'; end if;
  if p_peer is null or p_peer = v_uid then
    raise exception 'Cannot start a conversation with yourself.' using errcode='22023'; end if;
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Not a member of this workspace.' using errcode='42501'; end if;
  if not exists (select 1 from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=p_peer) then
    raise exception 'The other person is not a member of this workspace.' using errcode='42501'; end if;
  v_lo := least(v_uid, p_peer); v_hi := greatest(v_uid, p_peer);
  insert into public.dm_conversations (workspace_id, user_lo, user_hi) values (p_workspace_id, v_lo, v_hi)
    on conflict (workspace_id, user_lo, user_hi) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.dm_conversations where workspace_id=p_workspace_id and user_lo=v_lo and user_hi=v_hi;
  end if;
  return v_id;
end;
$$;
revoke all on function private._get_or_create_dm_conversation(uuid,uuid) from public, anon;
grant execute on function private._get_or_create_dm_conversation(uuid,uuid) to authenticated;

create or replace function public.get_or_create_dm_conversation(p_workspace_id uuid, p_peer uuid)
returns uuid language sql security invoker set search_path='' as $$
  select private._get_or_create_dm_conversation(p_workspace_id, p_peer);
$$;
revoke all on function public.get_or_create_dm_conversation(uuid,uuid) from public, anon;
grant execute on function public.get_or_create_dm_conversation(uuid,uuid) to authenticated;

-- ===== RLS =====
alter table public.dm_conversations enable row level security;
alter table public.dm_messages enable row level security;
alter table public.dm_reads enable row level security;

drop policy if exists dm_conversations_select_participant on public.dm_conversations;
create policy dm_conversations_select_participant on public.dm_conversations for select to authenticated
  using ( (select auth.uid()) in (user_lo, user_hi) and private.is_workspace_member(workspace_id) );

drop policy if exists dm_messages_select_participant on public.dm_messages;
create policy dm_messages_select_participant on public.dm_messages for select to authenticated
  using ( private.is_dm_participant(conversation_id) and private.is_workspace_member(workspace_id) );
drop policy if exists dm_messages_insert_participant on public.dm_messages;
create policy dm_messages_insert_participant on public.dm_messages for insert to authenticated
  with check ( sender_id = (select auth.uid()) and private.is_dm_participant(conversation_id) and private.is_workspace_member(workspace_id) );
drop policy if exists dm_messages_update_own on public.dm_messages;
create policy dm_messages_update_own on public.dm_messages for update to authenticated
  using ( sender_id = (select auth.uid()) and private.is_dm_participant(conversation_id) )
  with check ( sender_id = (select auth.uid()) and private.is_dm_participant(conversation_id) );
drop policy if exists dm_messages_delete_own on public.dm_messages;
create policy dm_messages_delete_own on public.dm_messages for delete to authenticated
  using ( sender_id = (select auth.uid()) and private.is_dm_participant(conversation_id) );

drop policy if exists dm_reads_select_participant on public.dm_reads;
create policy dm_reads_select_participant on public.dm_reads for select to authenticated
  using ( private.is_dm_participant(conversation_id) );           -- both participants' cursors -> read receipts
drop policy if exists dm_reads_insert_own on public.dm_reads;
create policy dm_reads_insert_own on public.dm_reads for insert to authenticated
  with check ( user_id = (select auth.uid()) and private.is_dm_participant(conversation_id) );
drop policy if exists dm_reads_update_own on public.dm_reads;
create policy dm_reads_update_own on public.dm_reads for update to authenticated
  using ( user_id = (select auth.uid()) and private.is_dm_participant(conversation_id) )
  with check ( user_id = (select auth.uid()) and private.is_dm_participant(conversation_id) );

-- ===== grants (least-privilege; conversations are RPC-write-only) =====
grant select, insert, update, delete on public.dm_messages to authenticated;
grant select on public.dm_conversations to authenticated;
grant select, insert, update on public.dm_reads to authenticated;

-- ===== realtime: server-side-filtered UPDATE/DELETE need FULL replica identity; add to the publication =====
alter table public.dm_messages replica identity full;
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='dm_messages') then
    alter publication supabase_realtime add table public.dm_messages;
  end if;
end $$;

-- ===== voice notes in DMs: extend the storage SELECT with a PARTICIPANT-gated clause (not member-gated) =====
alter policy voice_notes_select_member on storage.objects using (
  (bucket_id = 'voice-notes') and (
    ((storage.foldername(name))[1] = ((select auth.uid()))::text)
    or (exists (select 1 from public.messages msg    where msg.audio_path = objects.name and private.is_workspace_member(msg.workspace_id)))
    or (exists (select 1 from public.dm_messages d    where d.audio_path   = objects.name and private.is_dm_participant(d.conversation_id)))
  )
);
