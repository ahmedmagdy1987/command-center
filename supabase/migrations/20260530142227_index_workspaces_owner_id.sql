-- Phase 1 follow-up: cover the workspaces.owner_id FK (clears unindexed_foreign_keys;
-- supports the Phase-2 "workspaces I own" lookups).
create index if not exists workspaces_owner_id_idx on public.workspaces (owner_id);
