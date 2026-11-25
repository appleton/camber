import { ACP_WORKTREE_RENAMED_EVENT } from "./navTypes";

interface GithubRefresher {
  refresh(paths?: string[], options?: { force?: boolean }): Promise<void>;
}

// Renaming a worktree also renames its git branch, whatever the source (local
// UI, a deferred rename after creation, or the `camber worktrees rename` CLI
// arriving via acpNav didChange). Force-refresh so the cached branch is not
// served until the next poll. Returns an unsubscribe function.
export function wireACPGithubSync({
  emitter,
  github,
}: {
  emitter: EventTarget;
  github: GithubRefresher;
}): () => void {
  const handleRenamed = () => {
    void github.refresh(undefined, { force: true });
  };
  emitter.addEventListener(ACP_WORKTREE_RENAMED_EVENT, handleRenamed);
  return () => emitter.removeEventListener(ACP_WORKTREE_RENAMED_EVENT, handleRenamed);
}
