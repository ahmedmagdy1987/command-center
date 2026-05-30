-- ===========================================================================
-- messages: ONE shared workspace channel (text + voice notes). Every member sees all.
-- Idempotent.
-- ===========================================================================
create table if not exists public.messages (
  id                     uuid primary key default gen_random_uuid(),
  sender_id              uuid references auth.users (id) on delete set null,
  body                   text,                 -- null if voice-only
  audio_path             text,                 -- Storage path; null if text-only
  audio_duration_seconds int,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint messages_text_or_audio_check check (body is not null or audio_path is not null)
);

create index if not exists messages_created_at_idx on public.messages (created_at);
create index if not exists messages_sender_id_idx  on public.messages (sender_id);

-- RLS: any workspace member reads/sends; edit/delete only your own.
alter table public.messages enable row level security;

drop policy if exists messages_select_member on public.messages;
create policy messages_select_member on public.messages
  for select to authenticated
  using (exists (select 1 from public.members m where m.id = (select auth.uid())));

drop policy if exists messages_insert_member on public.messages;
create policy messages_insert_member on public.messages
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and exists (select 1 from public.members m where m.id = (select auth.uid()))
  );

drop policy if exists messages_update_own on public.messages;
create policy messages_update_own on public.messages
  for update to authenticated
  using (sender_id = (select auth.uid()))
  with check (sender_id = (select auth.uid()));

drop policy if exists messages_delete_own on public.messages;
create policy messages_delete_own on public.messages
  for delete to authenticated
  using (sender_id = (select auth.uid()));

grant select, insert, update, delete on public.messages to authenticated;

-- Realtime + full replica identity (so UPDATE/DELETE carry the full row).
alter table public.messages replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname='supabase_realtime' and schemaname='public' and tablename='messages')
  then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- ===========================================================================
-- Storage: private bucket for voice notes + member-scoped policies.
-- Objects live at  <auth.uid()>/<uuid>.<ext>  (path-based ownership for delete).
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice-notes', 'voice-notes', false, 10485760,
        array['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/aac','audio/wav'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "voice_notes_select_member" on storage.objects;
create policy "voice_notes_select_member" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'voice-notes'
    and exists (select 1 from public.members m where m.id = (select auth.uid()))
  );

drop policy if exists "voice_notes_insert_member" on storage.objects;
create policy "voice_notes_insert_member" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'voice-notes'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.members m where m.id = (select auth.uid()))
  );

drop policy if exists "voice_notes_delete_own" on storage.objects;
create policy "voice_notes_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'voice-notes'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
