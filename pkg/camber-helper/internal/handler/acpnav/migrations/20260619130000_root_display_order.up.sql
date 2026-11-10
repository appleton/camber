-- Backfill display_order for existing root projects so the new display_order
-- ordering preserves the previous alphabetical (name COLLATE NOCASE, path)
-- rendering instead of collapsing every project to display_order 0 (which would
-- re-sort them to newest-created-first on the first launch after upgrade). New
-- root projects created from now on are appended (MAX + 1) by the upsert.
UPDATE projects
SET display_order = (
  SELECT COUNT(*)
  FROM projects AS sibling
  WHERE sibling.is_worktree = 0
    AND (
      sibling.name COLLATE NOCASE < projects.name COLLATE NOCASE
      OR (sibling.name COLLATE NOCASE = projects.name COLLATE NOCASE AND sibling.path < projects.path)
    )
)
WHERE is_worktree = 0;
