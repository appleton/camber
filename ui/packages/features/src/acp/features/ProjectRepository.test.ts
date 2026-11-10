import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACPProjectRepositoryWriter } from "./ProjectRepository.svelte";

vi.mock("@camber/helperapi", () => ({
  camberAcpNavGetProjectSettings: vi.fn(),
  camberAcpNavList: vi.fn(),
  camberAcpNavRemoveProject: vi.fn(),
  camberAcpNavReorderProjects: vi.fn(),
  camberAcpNavReorderWorktrees: vi.fn(),
  camberAcpNavSetProjectCollapsed: vi.fn(),
  camberAcpNavSetProjectSettings: vi.fn(),
  camberAcpNavUpsertProject: vi.fn(),
}));

describe("ACPProjectRepositoryWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a worktree busy through the removal lifecycle", async () => {
    const { camberAcpNavList } = await import("@camber/helperapi");
    vi.mocked(camberAcpNavList).mockResolvedValue({
      conversations: [],
      projects: [
        {
          path: "/repo",
          name: "assistant",
          isWorktree: false,
          collapsed: false,
          displayOrder: 0,
          createdAt: "2026-05-20T09:00:00Z",
          updatedAt: "2026-05-20T09:00:00Z",
        },
        {
          path: "/repo/worktrees/feature",
          name: "feature",
          isWorktree: true,
          parentPath: "/repo",
          collapsed: false,
          displayOrder: 0,
          createdAt: "2026-05-20T10:00:00Z",
          updatedAt: "2026-05-20T10:00:00Z",
        },
      ],
    });
    const repo = new ACPProjectRepositoryWriter();

    await repo.refresh();
    repo.setWorktreeBusy("/repo/worktrees/feature", "tearing_down");
    expect(repo.getWorktreeBusy("/repo/worktrees/feature")).toBe("tearing_down");
    expect(repo.projects[1]).toMatchObject({ busy: "tearing_down" });

    repo.setWorktreeBusy("/repo/worktrees/feature", "deleting");
    expect(repo.projects[1]).toMatchObject({ busy: "deleting" });

    // Busy state survives a server refresh.
    await repo.refresh();
    expect(repo.projects[1]).toMatchObject({ busy: "deleting" });

    repo.clearWorktreeBusy("/repo/worktrees/feature");
    expect(repo.projects[1].busy).toBeUndefined();
    expect(repo.getWorktreeBusy("/repo/worktrees/feature")).toBeUndefined();
  });

  it("clearing busy when path is not tracked is a no-op", async () => {
    const { camberAcpNavList } = await import("@camber/helperapi");
    vi.mocked(camberAcpNavList).mockResolvedValue({
      conversations: [],
      projects: [
        {
          path: "/repo",
          name: "assistant",
          isWorktree: false,
          collapsed: false,
          displayOrder: 0,
          createdAt: "2026-05-20T09:00:00Z",
          updatedAt: "2026-05-20T09:00:00Z",
        },
      ],
    });
    const repo = new ACPProjectRepositoryWriter();
    await repo.refresh();

    expect(() => repo.clearWorktreeBusy("/never-tracked")).not.toThrow();
    expect(repo.projects).toHaveLength(1);
  });

  it("renders a prepared worktree as a busy placeholder, then merges with the server row", async () => {
    const { camberAcpNavList } = await import("@camber/helperapi");
    vi.mocked(camberAcpNavList).mockResolvedValue({
      conversations: [],
      projects: [
        {
          path: "/repo",
          name: "assistant",
          isWorktree: false,
          collapsed: false,
          displayOrder: 0,
          createdAt: "2026-05-20T09:00:00Z",
          updatedAt: "2026-05-20T09:00:00Z",
        },
      ],
    });
    const repo = new ACPProjectRepositoryWriter();

    await repo.refresh();
    const pendingPath = repo.addPendingWorktree({
      path: "/repo/worktrees/feature",
      name: "feature",
      isWorktree: true,
      parentPath: "/repo",
      collapsed: false,
      displayOrder: 0,
      createdAt: "2026-05-20T10:00:00Z",
      updatedAt: "2026-05-20T10:00:00Z",
    });

    expect(repo.projects).toHaveLength(2);
    expect(repo.projects[1]).toMatchObject({
      path: pendingPath,
      name: "feature",
      isWorktree: true,
      parentPath: "/repo",
      busy: "creating",
    });

    repo.setWorktreeBusy(pendingPath, "running_setup");
    expect(repo.projects[1]).toMatchObject({ busy: "running_setup" });

    repo.requestDelete(pendingPath);
    expect(repo.isDeleteRequested(pendingPath)).toBe(true);
    expect(repo.projects[1]).toMatchObject({
      busy: "running_setup",
      deleteRequested: true,
    });

    await repo.refresh();
    expect(repo.projects[1]).toMatchObject({
      busy: "running_setup",
      deleteRequested: true,
    });

    repo.clearWorktreeBusy(pendingPath);

    // After clearing, the placeholder is gone and only the server snapshot remains.
    expect(repo.projects).toEqual([expect.objectContaining({ path: "/repo", name: "assistant" })]);
    expect(repo.isDeleteRequested(pendingPath)).toBe(false);
  });

  it("keeps the last loaded projects visible while a refresh is in flight", async () => {
    const { camberAcpNavList } = await import("@camber/helperapi");
    const project = {
      path: "/repo",
      name: "assistant",
      isWorktree: false,
      collapsed: false,
      displayOrder: 0,
      createdAt: "2026-05-20T09:00:00Z",
      updatedAt: "2026-05-20T09:00:00Z",
    };
    vi.mocked(camberAcpNavList).mockResolvedValueOnce({ conversations: [], projects: [project] });
    const repo = new ACPProjectRepositoryWriter();

    await repo.refresh();
    expect(repo.projects).toHaveLength(1);

    // Second refresh that stays pending so we can observe the loading window.
    let resolveList: (value: { conversations: never[]; projects: (typeof project)[] }) => void;
    vi.mocked(camberAcpNavList).mockImplementationOnce(
      () => new Promise((resolve) => (resolveList = resolve)),
    );
    const pending = repo.refresh();
    // Let fromPromise emit its "loading" state (it awaits a microtask first).
    await Promise.resolve();
    await Promise.resolve();

    // Mid-reload the repo reports "loading" but still exposes the prior list,
    // so consumers never see a transient empty projects state (which would make
    // the desktop chat pane swap the transcript for the empty state and reset
    // scroll).
    expect(repo.refreshState.status).toBe("loading");
    expect(repo.projects).toEqual([expect.objectContaining({ path: "/repo", name: "assistant" })]);

    resolveList!({ conversations: [], projects: [project] });
    await pending;
    expect(repo.projects).toHaveLength(1);
  });

  it("keeps deleteRequested when a server row replaces a pending worktree", async () => {
    const { camberAcpNavList } = await import("@camber/helperapi");
    vi.mocked(camberAcpNavList)
      .mockResolvedValueOnce({
        conversations: [],
        projects: [
          {
            path: "/repo",
            name: "assistant",
            isWorktree: false,
            collapsed: false,
            displayOrder: 0,
            createdAt: "2026-05-20T09:00:00Z",
            updatedAt: "2026-05-20T09:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        conversations: [],
        projects: [
          {
            path: "/repo",
            name: "assistant",
            isWorktree: false,
            collapsed: false,
            displayOrder: 0,
            createdAt: "2026-05-20T09:00:00Z",
            updatedAt: "2026-05-20T09:00:00Z",
          },
          {
            path: "/repo/worktrees/feature",
            name: "server feature",
            isWorktree: true,
            parentPath: "/repo",
            collapsed: false,
            displayOrder: 0,
            createdAt: "2026-05-20T10:00:00Z",
            updatedAt: "2026-05-20T10:00:00Z",
          },
        ],
      });
    const repo = new ACPProjectRepositoryWriter();

    await repo.refresh();
    const pendingPath = repo.addPendingWorktree({
      path: "/repo/worktrees/feature",
      name: "feature",
      isWorktree: true,
      parentPath: "/repo",
      collapsed: false,
      displayOrder: 0,
      createdAt: "2026-05-20T10:00:00Z",
      updatedAt: "2026-05-20T10:00:00Z",
    });
    repo.requestDelete(pendingPath);

    await repo.refresh();

    expect(repo.projects[1]).toMatchObject({
      path: pendingPath,
      name: "server feature",
      busy: "creating",
      deleteRequested: true,
    });
  });
});
