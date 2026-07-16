-- Server-side backstop for the four jsonb columns on public.tasks. The client caps in
-- src/lib/sanitize.js (tags 50x100, subtasks 200, links 50, recurring 2000 chars) are UX only:
-- a direct PostgREST call bypasses them entirely (proven live: a 401-element subtasks blob is
-- accepted today). These CHECKs are the authoritative limit.
--
-- Metric: octet_length(x::text), NOT pg_column_size. pg_column_size reports the COMPRESSED
-- on-disk size of a TOASTed datum (measured: 2,000,020 in-memory vs 22,918 stored for the same
-- value -- 87x), so a CHECK on it would mean one thing at INSERT and another at revalidation
-- (ALTER TABLE VALIDATE / pg_dump restore). octet_length(x::text) is IMMUTABLE and identical in
-- both phases. octet_length not length: the client caps CHARACTERS, the DB stores BYTES, and a
-- 4-byte UTF-8 payload is 4x its character count.
--
-- Ordering: the CASE gates typeof BEFORE jsonb_array_length (which RAISES 22023 on a non-array),
-- and gates the O(1) count BEFORE the ::text serialization (so a mass-element payload is rejected
-- without ever being serialized). CASE, not AND: Postgres does not guarantee AND evaluation order,
-- so a future plan change could turn a clean 23514 into a raw 22023.
--
-- NULLs: a CHECK expression returning NULL PASSES. Every CASE branch returns an explicit boolean,
-- so a NULL array column is rejected by the CHECK itself, independent of NOT NULL. recurring is
-- nullable by design (null = "no recurrence") and is allowed explicitly via the same
-- (x IS NULL OR ...) form already used by tasks_blocked_reason_len_chk.
--
-- Caps are >= the MEASURED worst-case client-legal payload in 4-byte UTF-8, so the client degrades
-- gracefully and the DB is the backstop:
--   tags     20,200 octets -> 65,536    (3.24x)   count 50  -> 100
--   subtasks 459,200 octets -> 1,048,576 (2.28x)  count 200 -> 400
--   links    202,200 octets -> 262,144  (1.30x)   count 50  -> 100
--   recurring 8,012 octets -> 16,384    (2.05x)   (not an array; size only)
--
-- Locking: ADD CONSTRAINT takes ACCESS EXCLUSIVE and full-scans to validate. 24 live rows -> instant.
-- All 24 live rows satisfy every cap (violation count = 0, verified live before adding).
-- Proven: 35/35 rolled-back, 10/10 live.

alter table public.tasks drop constraint if exists tasks_tags_shape_chk;
alter table public.tasks drop constraint if exists tasks_subtasks_shape_chk;
alter table public.tasks drop constraint if exists tasks_links_shape_chk;
alter table public.tasks drop constraint if exists tasks_recurring_size_chk;

alter table public.tasks
  add constraint tasks_tags_shape_chk check (
    case when tags is null                  then false
         when jsonb_typeof(tags) <> 'array' then false
         when jsonb_array_length(tags) > 100 then false
         else octet_length(tags::text) <= 65536
    end),
  add constraint tasks_subtasks_shape_chk check (
    case when subtasks is null                  then false
         when jsonb_typeof(subtasks) <> 'array' then false
         when jsonb_array_length(subtasks) > 400 then false
         else octet_length(subtasks::text) <= 1048576
    end),
  add constraint tasks_links_shape_chk check (
    case when links is null                  then false
         when jsonb_typeof(links) <> 'array' then false
         when jsonb_array_length(links) > 100 then false
         else octet_length(links::text) <= 262144
    end),
  add constraint tasks_recurring_size_chk check (
    recurring is null or octet_length(recurring::text) <= 16384);

comment on constraint tasks_tags_shape_chk on public.tasks is
  'Backstop for src/lib/sanitize.js MAX_TAGS=50 / MAX_TAG_LEN=100. Array-typed, <=100 elements, <=64KB serialized. Measured client-legal worst case (4-byte UTF-8) = 20,200 octets.';
comment on constraint tasks_subtasks_shape_chk on public.tasks is
  'Backstop for src/lib/sanitize.js MAX_SUBTASKS=200 (id<=64, title<=500). Array-typed, <=400 elements, <=1MB serialized. Measured client-legal worst case = 459,200 octets.';
comment on constraint tasks_links_shape_chk on public.tasks is
  'Backstop for src/lib/sanitize.js MAX_LINKS=50 (label<=500). Array-typed, <=100 elements, <=256KB serialized. NOTE: safeLinkUrl does not cap url length, so this byte cap is currently the ONLY bound on a link url.';
comment on constraint tasks_recurring_size_chk on public.tasks is
  'Backstop for src/lib/sanitize.js MAX_RECURRING_CHARS=2000. NULL allowed (no recurrence). <=16KB serialized; measured client-legal worst case (4-byte UTF-8) = 8,012 octets. Type deliberately unrestricted (live rows hold jsonb objects).';
