import { camberGitStatus, type GitStatusOutput } from "@camber/helperapi";

/**
 * Event-driven git working-tree tracker for the desktop conversation footer.
 *
 * Keeps a `camber/git/status` snapshot for one worktree so the chat pane can
 * keep repository and staging affordances visible, including for a clean tree.
 * Performance policy: no polling. Refreshes are driven by
 * - the desktop host's file watcher (`camber:desktop-file-tree-changed`,
 *   debounced here since agent edits arrive in bursts),
 * - turn completion, and
 * - window focus (safety net for edits made while unfocused),
 * with a token guard so stale responses never clobber newer ones.
 */

/** Matches the desktop host's file-tree-changed CustomEvent detail. */
export interface DesktopFileTreeChangedEventDetail {
  changes?: { path?: string }[];
}

export const DESKTOP_FILE_TREE_CHANGED_EVENT = "camber:desktop-file-tree-changed";

/**
 * Dispatched (window CustomEvent, no detail) after a git mutation performed
 * inside the app (stage/unstage/discard/commit/stash/checkout in the Changes
 * panel) so working-tree watchers refresh immediately, rather than waiting
 * for the debounced file-watcher report of the resulting `.git/` writes.
 * (The desktop watcher forwards `.git` mutation signals like the index and
 * refs, but filters bookkeeping churn — lock files, objects, fsmonitor
 * cookies — so helper git reads cannot retrigger the refresh that ran them.)
 */
export const DESKTOP_GIT_CHANGED_EVENT = "camber:desktop-git-changed";

const REFRESH_DEBOUNCE_MS = 750;

export class DesktopGitChangesState {
  private current = $state<GitStatusOutput | undefined>(undefined);
  private worktreePath: string | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshToken = 0;

  get status(): GitStatusOutput | undefined {
    return this.current;
  }

  /** Whether the latest status confirms that the tracked directory is a git repo. */
  get isRepo(): boolean {
    return this.current?.isRepo === true;
  }

  /** Total staged + unstaged + untracked files; 0 when not a repo or unknown. */
  get changedFileCount(): number {
    const git = this.current;
    if (!git?.isRepo) return 0;
    return git.staged.length + git.unstaged.length + git.untracked.length;
  }

  /** Total added lines vs HEAD, including untracked text files. */
  get additions(): number {
    const git = this.current;
    return git?.isRepo ? (git.additions ?? 0) : 0;
  }

  /** Total deleted lines vs HEAD; 0 when not a repo or unknown. */
  get deletions(): number {
    const git = this.current;
    return git?.isRepo ? (git.deletions ?? 0) : 0;
  }

  /**
   * Display label for the checked-out branch ("(detached)" when the HEAD is
   * detached); empty when not a repo or unknown.
   */
  get branchLabel(): string {
    const git = this.current;
    if (!git?.isRepo) return "";
    return git.detached ? "(detached)" : git.branch;
  }

  /**
   * Remote tracking branch (e.g. "origin/main"); empty when not a repo,
   * unknown, or the branch has no upstream.
   */
  get upstreamLabel(): string {
    const git = this.current;
    if (!git?.isRepo) return "";
    return git.upstream ?? "";
  }

  /**
   * Points the tracker at a worktree (or nothing). Clears stale state and
   * refreshes immediately when the path actually changes.
   */
  setWorktreePath(path: string | undefined): void {
    const next = path || undefined;
    if (next === this.worktreePath) return;
    this.worktreePath = next;
    this.current = undefined;
    this.cancelScheduledRefresh();
    // Invalidate any in-flight request for the previous worktree.
    this.refreshToken++;
    if (next) this.refreshNow();
  }

  /** Debounced refresh — cheap to call for every file-change event. */
  scheduleRefresh(): void {
    if (!this.worktreePath) return;
    this.cancelScheduledRefresh();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.refreshNow();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** True when any changed path in the event lies inside the tracked worktree. */
  affectsWorktree(detail: DesktopFileTreeChangedEventDetail | undefined): boolean {
    const root = this.worktreePath ? normalizePath(this.worktreePath) : undefined;
    if (!root) return false;
    const changes = detail?.changes;
    // Payloads without concrete paths still mean "something changed".
    if (!changes || changes.length === 0) return true;
    return changes.some((change) => {
      if (!change.path) return true;
      const changed = normalizePath(change.path);
      return changed === root || changed.startsWith(`${root}/`);
    });
  }

  refreshNow(): void {
    const path = this.worktreePath;
    if (!path) return;
    const token = ++this.refreshToken;
    void camberGitStatus({ path })
      .then((git) => {
        if (token !== this.refreshToken || path !== this.worktreePath) return;
        this.current = git;
      })
      .catch(() => {
        if (token !== this.refreshToken || path !== this.worktreePath) return;
        // Treat failures as "unknown" so the affordance hides rather than
        // showing stale counts (e.g. helper restarting, path deleted).
        this.current = undefined;
      });
  }

  dispose(): void {
    this.cancelScheduledRefresh();
    this.refreshToken++;
  }

  private cancelScheduledRefresh(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }
}

function normalizePath(path: string): string {
  let normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/g, "");
  if (/^[A-Z]:\//.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}
