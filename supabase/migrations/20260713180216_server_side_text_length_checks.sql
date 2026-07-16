-- 5a (SCALE_AUDIT A5): server-side length CHECK constraints mirroring the client maxLength caps, so the
-- server is authoritative. Client maxLength is UX only — bypassable by any direct supabase-js call holding
-- the anon key, so a member could otherwise persist a multi-MB task/message that poisons every co-member's
-- whole-array fetch + render. These CHECKs make the DB the real limit.
--
-- Preflight (2026-07-13) confirmed no existing row violates: max title=125, all bodies/names < 20.
-- NULL-tolerant on the nullable text columns (messages/dm_messages.body is NULL for voice notes and for
-- soft-delete tombstones; description/blocked_reason/display_name are nullable). Caps match the client:
--   task title 500, description 20000, blocked_reason 1000; comments/messages/dm body 10000;
--   project + workspace name 80; member display_name 120.
-- drop-if-exists + add = idempotent; the ADD validates existing rows (instant at current volume).

alter table public.tasks       drop constraint if exists tasks_title_len_chk;
alter table public.tasks       add  constraint tasks_title_len_chk          check (char_length(title) <= 500);
alter table public.tasks       drop constraint if exists tasks_description_len_chk;
alter table public.tasks       add  constraint tasks_description_len_chk    check (description is null or char_length(description) <= 20000);
alter table public.tasks       drop constraint if exists tasks_blocked_reason_len_chk;
alter table public.tasks       add  constraint tasks_blocked_reason_len_chk check (blocked_reason is null or char_length(blocked_reason) <= 1000);

alter table public.comments    drop constraint if exists comments_body_len_chk;
alter table public.comments    add  constraint comments_body_len_chk       check (body is null or char_length(body) <= 10000);
alter table public.messages    drop constraint if exists messages_body_len_chk;
alter table public.messages    add  constraint messages_body_len_chk       check (body is null or char_length(body) <= 10000);
alter table public.dm_messages drop constraint if exists dm_messages_body_len_chk;
alter table public.dm_messages add  constraint dm_messages_body_len_chk    check (body is null or char_length(body) <= 10000);

alter table public.projects    drop constraint if exists projects_name_len_chk;
alter table public.projects    add  constraint projects_name_len_chk       check (char_length(name) <= 80);
alter table public.workspaces  drop constraint if exists workspaces_name_len_chk;
alter table public.workspaces  add  constraint workspaces_name_len_chk     check (char_length(name) <= 80);
alter table public.members     drop constraint if exists members_display_name_len_chk;
alter table public.members     add  constraint members_display_name_len_chk check (display_name is null or char_length(display_name) <= 120);
