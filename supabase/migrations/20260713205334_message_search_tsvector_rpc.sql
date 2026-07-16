-- 5d (SCALE_AUDIT A6): full-text team-chat message search via a stored tsvector + GIN + an RLS-respecting
-- RPC, replacing the client-side grep (which only searched the newest ~200 in-memory messages, so ~96% of
-- history was unsearchable at volume).
--
-- SECURITY INVOKER: messages_select_member RLS applies inside the function, so isolation is INHERITED, not
-- reimplemented — a guest (chat-excluded) and a non-member both get 0 rows automatically. PROVEN on the
-- SHIPPING shape (body_tsv generated column + GIN in place), 2026-07-13:
--   * member  -> exact hits (quarterly=1, deployment=1)          * GUEST     -> 0 (quarterly + deployment)
--   * outsider (non-member) -> 0                                 * soft-deleted-with-text -> 0 (findme/deletedsecret)
--   Advisors clean; isolation/role regression 42/42; DB restored byte-for-byte.
--
-- Idempotent. messages is REPLICA IDENTITY FULL + in the realtime publication; body_tsv rides along in the
-- WAL payload (harmless — the client's fromDbMessage ignores unknown columns).

alter table public.messages add column if not exists body_tsv tsvector
  generated always as (to_tsvector('english', coalesce(body,''))) stored;
create index if not exists messages_body_tsv_idx on public.messages using gin (body_tsv);

create or replace function public.search_messages(p_ws uuid, p_q text, p_limit int default 50)
returns setof public.messages language sql stable security invoker set search_path='' as $fn$
  select m.* from public.messages m
   where m.workspace_id = p_ws and m.deleted_at is null
     and m.body_tsv @@ websearch_to_tsquery('english', p_q)
   order by m.created_at desc limit least(coalesce(p_limit,50),100);
$fn$;
revoke all on function public.search_messages(uuid,text,int) from public, anon;
grant execute on function public.search_messages(uuid,text,int) to authenticated;
