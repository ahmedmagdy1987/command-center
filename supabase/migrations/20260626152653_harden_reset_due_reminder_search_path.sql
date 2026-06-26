-- Clear the function_search_path_mutable advisor on the due-reminder reset trigger (it references only
-- NEW/OLD columns, no unqualified objects, so an empty search_path is safe) — advisor-clean like every
-- other function here.
alter function public.reset_due_reminder_stage() set search_path to '';
