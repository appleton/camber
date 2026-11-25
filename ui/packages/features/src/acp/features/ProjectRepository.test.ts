import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACP_WORKTREE_RENAMED_EVENT } from "../navTypes";
import { ACPProjectRepositoryWriter } from "./ProjectRepository.svelte";

vi.mock("@camber/helperapi", () => ({
  camberAcpNavGetProjectSettings: vi.fn(),
  camberAcpNavList: vi.fn(),
  camberAcpNavRemoveProject: vi.fn(),
  camberAcpNavRenameProject: vi.fn(),
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
  it("keeps a rename made while a worktree is pending and applies it after creation", async () => {
    const { camberAcpNavList, camberAcpNavRenameProject } = await import("@camber/helperapi");
    const base = {
      path: "/repo/worktrees/feature",
      isWorktree: true,
      parentPath: "/repo",
      collapsed: false,
      displayOrder: 0,
      createdAt: "2026-05-20T10:00:00Z",
      updatedAt: "2026-05-20T10:00:00Z",
    };
    vi.mocked(camberAcpNavList).mockResolvedValue({
      conversations: [],
      projects: [{ ...base, name: "generated" }],
    });
    vi.mocked(camberAcpNavRenameProject).mockResolvedValue({
      projects: [{ ...base, name: "mine" }],
    } as never);
    const repo = new ACPProjectRepositoryWriter();
    const path = repo.addPendingWorktree({ ...base, name: "generated" });

    const renamed = repo.renameProject(path, "  mine  ");
    expect(camberAcpNavRenameProject).not.toHaveBeenCalled();
    expect(repo.projects[0]).toMatchObject({ name: "mine", busy: "creating" });

    // Creation upserts the row with the generated name; the user's name still wins.
    await repo.refresh();
    expect(repo.projects[0]).toMatchObject({ name: "mine" });

    repo.clearWorktreeBusy(path);
    await vi.waitFor(() =>
      expect(camberAcpNavRenameProject).toHaveBeenCalledWith({ path, name: "mine" }),
    );
    await expect(renamed).resolves.toBeUndefined();
  });

  describe("deferred rename of a pending worktree", () => {
    const base = {
      path: "/repo/worktrees/feature",
      isWorktree: true,
      parentPath: "/repo",
      collapsed: false,
      displayOrder: 0,
      createdAt: "2026-05-20T10:00:00Z",
      updatedAt: "2026-05-20T10:00:00Z",
    };

    async function setup(serverRows: boolean) {
      const api = await import("@camber/helperapi");
      vi.mocked(api.camberAcpNavList).mockResolvedValue({
        conversations: [],
        projects: serverRows ? [{ ...base, name: "generated" }] : [],
      });
      const repo = new ACPProjectRepositoryWriter();
      const path = repo.addPendingWorktree({ ...base, name: "generated" });
      if (serverRows) await repo.refresh();
      return { api, repo, path };
    }

    it("keeps the overlay name until the rename RPC resolves", async () => {
      const { api, repo, path } = await setup(true);
      let resolveRpc!: (value: never) => void;
      vi.mocked(api.camberAcpNavRenameProject).mockReturnValue(
        new Promise((resolve) => {
          resolveRpc = resolve;
        }),
      );
      const settled = vi.fn();
      void repo.renameProject(path, "mine").then(settled);

      repo.clearWorktreeBusy(path);
      await vi.waitFor(() => expect(api.camberAcpNavRenameProject).toHaveBeenCalled());
      expect(repo.projects[0]?.name).toBe("mine");
      expect(settled).not.toHaveBeenCalled();

      resolveRpc({ projects: [{ ...base, name: "mine" }] } as never);
      await vi.waitFor(() => expect(settled).toHaveBeenCalled());
      expect(repo.projects[0]?.name).toBe("mine");
    });

    it("rejects the original promise and drops the overlay on RPC failure", async () => {
      const { api, repo, path } = await setup(true);
      const failure = new Error("branch exists");
      vi.mocked(api.camberAcpNavRenameProject).mockRejectedValue(failure);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = repo.renameProject(path, "mine");
      const assertion = expect(result).rejects.toBe(failure);

      repo.clearWorktreeBusy(path);
      await assertion;
      expect(repo.projects[0]?.name).toBe("generated");
    });

    it("resolves a superseded rename and applies only the latest name", async () => {
      const { api, repo, path } = await setup(true);
      vi.mocked(api.camberAcpNavRenameProject).mockResolvedValue({
        projects: [{ ...base, name: "second" }],
      } as never);
      const first = repo.renameProject(path, "first");
      const second = repo.renameProject(path, "second");
      await expect(first).resolves.toBeUndefined();

      repo.clearWorktreeBusy(path);
      await expect(second).resolves.toBeUndefined();
      expect(api.camberAcpNavRenameProject).toHaveBeenCalledTimes(1);
      expect(api.camberAcpNavRenameProject).toHaveBeenCalledWith({ path, name: "second" });
    });

    it("resolves without calling the RPC when creation failed", async () => {
      const { api, repo, path } = await setup(false);
      const result = repo.renameProject(path, "mine");

      repo.clearWorktreeBusy(path);
      await expect(result).resolves.toBeUndefined();
      expect(api.camberAcpNavRenameProject).not.toHaveBeenCalled();
      expect(repo.projects).toEqual([]);
    });
  });

  describe("worktree rename event", () => {
    const base = {
      path: "/repo/worktrees/feature",
      isWorktree: true,
      parentPath: "/repo",
      collapsed: false,
      displayOrder: 0,
      createdAt: "2026-05-20T10:00:00Z",
      updatedAt: "2026-05-20T10:00:00Z",
    };

    function listen(repo: ACPProjectRepositoryWriter) {
      const paths: string[][] = [];
      repo.emitter.addEventListener(ACP_WORKTREE_RENAMED_EVENT, (event) => {
        paths.push((event as CustomEvent<{ paths: string[] }>).detail.paths);
      });
      return paths;
    }

    it("emits when a worktree display name changes, not on unrelated updates", () => {
      const repo = new ACPProjectRepositoryWriter();
      const paths = listen(repo);

      repo.replaceProjects([{ ...base, name: "one" }]);
      expect(paths).toEqual([]);

      repo.replaceProjects([{ ...base, name: "one", collapsed: true, displayOrder: 3 }]);
      expect(paths).toEqual([]);

      repo.replaceProjects([{ ...base, name: "two", collapsed: true }]);
      expect(paths).toEqual([[base.path]]);

      repo.replaceProjects([{ ...base, name: "two", nickname: "nick" }]);
      expect(paths).toEqual([[base.path], [base.path]]);
    });

    it("emits when a deferred rename is applied after creation", async () => {
      const { camberAcpNavRenameProject } = await import("@camber/helperapi");
      vi.mocked(camberAcpNavRenameProject).mockResolvedValue({
        projects: [{ ...base, name: "mine" }],
      } as never);
      const repo = new ACPProjectRepositoryWriter();
      const paths = listen(repo);
      const path = repo.addPendingWorktree({ ...base, name: "generated" });
      const renamed = repo.renameProject(path, "mine");

      repo.replaceProjects([{ ...base, name: "generated" }]);
      expect(paths).toEqual([]);

      repo.clearWorktreeBusy(path);
      await renamed;
      expect(paths).toEqual([[base.path]]);
    });
  });
});
