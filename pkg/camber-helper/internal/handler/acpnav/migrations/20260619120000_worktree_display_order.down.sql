-- Revert worktree ordering to the column default; rendering falls back to
-- created_at DESC.
UPDATE projects
SET display_order = 0
WHERE is_worktree = 1;
