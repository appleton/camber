import { camberGitStatus, type GitStatusOutput } from "@camber/helperapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopGitChangesState } from "./DesktopGitChangesState.svelte";

vi.mock("@camber/helperapi", () => ({
  camberGitStatus: vi.fn(),
}));

const mockGitStatus = vi.mocked(camberGitStatus);

function gitStatus(overrides: Partial<GitStatusOutput> = {}): GitStatusOutput {
  return {
    isRepo: true,
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    stashCount: 0,
    additions: 0,
    deletions: 0,
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  // Settle the camberGitStatus promise chain inside refreshNow.
  await Promise.resolve();
  await Promise.resolve();
}

describe("DesktopGitChangesState", () => {
  let state: DesktopGitChangesState;

  beforeEach(() => {
    vi.useFakeTimers();
    mockGitStatus.mockReset();
    state = new DesktopGitChangesState();
  });

  afterEach(() => {
    state.dispose();
    vi.useRealTimers();
  });

  it("refreshes immediately when pointed at a worktree and exposes counts", async () => {
    mockGitStatus.mockResolvedValue(
      gitStatus({
        staged: [{ path: "a.ts", status: "modified" }],
        unstaged: [{ path: "b.ts", status: "modified" }],
        untracked: [{ path: "c.ts", status: "untracked" }],
      }),
    );

    state.setWorktreePath("/repo");
    await flushMicrotasks();

    expect(mockGitStatus).toHaveBeenCalledWith({ path: "/repo" });
    expect(state.changedFileCount).toBe(3);
  });

  it("reports zero changed files for non-repos and unknown status", async () => {
    expect(state.isRepo).toBe(false);
    expect(state.changedFileCount).toBe(0);

    mockGitStatus.mockResolvedValue(gitStatus({ isRepo: false }));
    state.setWorktreePath("/not-a-repo");
    await flushMicrotasks();

    expect(state.isRepo).toBe(false);
    expect(state.changedFileCount).toBe(0);
  });

  it("reports a repository even when its working tree is clean", async () => {
    mockGitStatus.mockResolvedValue(gitStatus());

    state.setWorktreePath("/repo");
    await flushMicrotasks();

    expect(state.isRepo).toBe(true);
    expect(state.changedFileCount).toBe(0);
  });

  it("debounces scheduled refreshes into one git status call", async () => {
    mockGitStatus.mockResolvedValue(gitStatus());
    state.setWorktreePath("/repo");
    await flushMicrotasks();
    mockGitStatus.mockClear();

    state.scheduleRefresh();
    state.scheduleRefresh();
    state.scheduleRefresh();
    expect(mockGitStatus).not.toHaveBeenCalled();

    vi.advanceTimersByTime(750);
    await flushMicrotasks();
    expect(mockGitStatus).toHaveBeenCalledTimes(1);
  });

  it("ignores scheduled refreshes when no worktree is set", () => {
    state.scheduleRefresh();
    vi.advanceTimersByTime(1000);
    expect(mockGitStatus).not.toHaveBeenCalled();
  });

  it("drops stale responses when the worktree changes mid-flight", async () => {
    let resolveFirst: (git: GitStatusOutput) => void = () => {};
    mockGitStatus.mockImplementationOnce(
      () => new Promise<GitStatusOutput>((resolve) => (resolveFirst = resolve)),
    );
    state.setWorktreePath("/repo-a");

    mockGitStatus.mockResolvedValueOnce(
      gitStatus({ untracked: [{ path: "b", status: "untracked" }] }),
    );
    state.setWorktreePath("/repo-b");
    await flushMicrotasks();
    expect(state.changedFileCount).toBe(1);

    // The late repo-a response must not clobber the repo-b snapshot.
    resolveFirst(
      gitStatus({
        untracked: [
          { path: "a1", status: "untracked" },
          { path: "a2", status: "untracked" },
        ],
      }),
    );
    await flushMicrotasks();
    expect(state.changedFileCount).toBe(1);
  });

  it("clears status when a refresh fails", async () => {
    mockGitStatus.mockResolvedValueOnce(
      gitStatus({ unstaged: [{ path: "a.ts", status: "modified" }] }),
    );
    state.setWorktreePath("/repo");
    await flushMicrotasks();
    expect(state.changedFileCount).toBe(1);

    mockGitStatus.mockRejectedValueOnce(new Error("helper unavailable"));
    state.refreshNow();
    await flushMicrotasks();
    expect(state.status).toBeUndefined();
    expect(state.changedFileCount).toBe(0);
  });

  describe("affectsWorktree", () => {
    beforeEach(async () => {
      mockGitStatus.mockResolvedValue(gitStatus());
      state.setWorktreePath("/repo/project");
      await flushMicrotasks();
    });

    it("is false when no worktree is tracked", () => {
      const untracked = new DesktopGitChangesState();
      expect(untracked.affectsWorktree({ changes: [{ path: "/repo/project/a" }] })).toBe(false);
    });

    it("matches paths inside the worktree", () => {
      expect(state.affectsWorktree({ changes: [{ path: "/repo/project/src/a.ts" }] })).toBe(true);
      expect(state.affectsWorktree({ changes: [{ path: "/repo/project" }] })).toBe(true);
    });

    it("rejects paths outside the worktree, including sibling prefixes", () => {
      expect(state.affectsWorktree({ changes: [{ path: "/repo/other/a.ts" }] })).toBe(false);
      expect(state.affectsWorktree({ changes: [{ path: "/repo/project-two/a.ts" }] })).toBe(false);
    });

    it("treats missing or empty payloads as affecting the worktree", () => {
      expect(state.affectsWorktree(undefined)).toBe(true);
      expect(state.affectsWorktree({})).toBe(true);
      expect(state.affectsWorktree({ changes: [] })).toBe(true);
      expect(state.affectsWorktree({ changes: [{}] })).toBe(true);
    });
  });
});
