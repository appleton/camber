-- Backfill display_order for existing worktrees so the persisted order matches
-- the previous "newest first" (created_at DESC) rendering: the newest worktree
-- in each parent gets 0, the next gets 1, and so on. New worktrees created from
-- now on are assigned a lower display_order than their siblings, keeping them
-- first. Root projects already carry a meaningful display_order and are left
-- untouched.
UPDATE projects
SET display_order = (
  SELECT COUNT(*)
  FROM projects AS sibling
  WHERE sibling.is_worktree = 1
    AND sibling.parent_path IS projects.parent_path
    AND (
      sibling.created_at > projects.created_at
      OR (sibling.created_at = projects.created_at AND sibling.path < projects.path)
    )
)
WHERE is_worktree = 1;
