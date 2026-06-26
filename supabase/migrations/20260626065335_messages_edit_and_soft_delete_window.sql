-- Soft edit/delete for team chat (public.messages) and direct messages (public.dm_messages).
--
-- * edited_at / deleted_at audit columns (NULL = never edited / not deleted).
-- * The text-or-audio CHECK is relaxed to permit a content-stripped tombstone (deleted_at set,
--   body + audio_path NULL) so a soft-delete leaves nothing sensitive behind.
-- * A BEFORE UPDATE trigger is the AUTHORITATIVE gate: it enforces a 10-minute window for BOTH
--   edit and soft-delete (measured against the immutable created_at), stamps edited_at/deleted_at
--   server-side (clients cannot forge them), strips content on delete, and makes a tombstone
--   immutable (no further edit or re-delete). Hard-delete + sender-only RLS policies are untouched;
--   the app uses soft-delete only.

alter table public.messages    add column if not exists edited_at  timestamptz;
alter table public.messages    add column if not exists deleted_at timestamptz;
alter table public.dm_messages add column if not exists edited_at  timestamptz;
alter table public.dm_messages add column if not exists deleted_at timestamptz;

alter table public.messages    drop constraint if exists messages_text_or_audio_check;
alter table public.messages    add  constraint messages_text_or_audio_check
  check (body is not null or audio_path is not null or deleted_at is not null);
alter table public.dm_messages drop constraint if exists dm_text_or_audio;
alter table public.dm_messages add  constraint dm_text_or_audio
  check (body is not null or audio_path is not null or deleted_at is not null);

create or replace function public.enforce_message_edit_window()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  -- A tombstoned (soft-deleted) message is immutable: no further edits or re-deletes.
  if old.deleted_at is not null then
    raise exception 'message already deleted';
  end if;

  -- Soft-delete: the client signals it by setting deleted_at. Enforce the 10-minute window
  -- against the immutable created_at, then authoritatively stamp the tombstone and strip content.
  if new.deleted_at is not null then
    if now() - old.created_at > interval '10 minutes' then
      raise exception 'delete window expired';
    end if;
    new.deleted_at := now();
    new.edited_at  := old.edited_at;
    new.body := null;
    new.audio_path := null;
    new.audio_duration_seconds := null;
    return new;
  end if;

  -- Edit: any change to the message content. Same 10-minute window; stamp edited_at authoritatively.
  if new.body is distinct from old.body
     or new.audio_path is distinct from old.audio_path
     or new.audio_duration_seconds is distinct from old.audio_duration_seconds then
    if now() - old.created_at > interval '10 minutes' then
      raise exception 'edit window expired';
    end if;
    new.edited_at  := now();
    new.deleted_at := old.deleted_at;
    return new;
  end if;

  -- Any other update: never let the audit columns drift from their server-stamped values.
  new.edited_at  := old.edited_at;
  new.deleted_at := old.deleted_at;
  return new;
end;
$fn$;

-- Hardened like every other SECURITY DEFINER fn here: EXECUTE revoked (the trigger still fires;
-- trigger invocation does not require EXECUTE on the function).
revoke execute on function public.enforce_message_edit_window() from public, anon, authenticated;

drop trigger if exists messages_enforce_edit_window on public.messages;
create trigger messages_enforce_edit_window before update on public.messages
  for each row execute function public.enforce_message_edit_window();

drop trigger if exists dm_messages_enforce_edit_window on public.dm_messages;
create trigger dm_messages_enforce_edit_window before update on public.dm_messages
  for each row execute function public.enforce_message_edit_window();
