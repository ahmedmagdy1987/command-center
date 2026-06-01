-- Phase 2C: drop the legacy owner model — completes "generalize task assignment".
-- The app (2B-2) and all triggers (2B-1) reference no `owner`; the only function touching the column was
-- public.tasks_align_privacy (its trigger was dropped in 2A), dropped here. assignee_id + the ⟨P2⟩ task
-- policies are the model now. Pure schema cleanup; verified in a rolled-back proof that every trigger
-- (set_workspace_id, notify_on_task_assigned/_completed/_comment_added) still fires after the drop.

alter table public.tasks drop column owner;          -- also drops the dependent tasks_owner_check CHECK

drop function if exists public.tasks_align_privacy(); -- orphaned since 2A dropped its trigger
