-- Revert root project ordering to the column default; rendering falls back to
-- the remaining sort keys (created_at DESC, name).
UPDATE projects
SET display_order = 0
WHERE is_worktree = 0;
