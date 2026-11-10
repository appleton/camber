import { describe, expect, it } from "vitest";
import type { AppState } from "./hostAdapter";
import type { ACPNavProject } from "./navTypes";
import {
  ACP_CHAT_WORKSPACE_PATH,
  ACP_IDE_WORKSPACE_PATH,
  acpProtocolCwd,
  acpSessionLoadCwd,
  acpSessionWorkspacePath,
  acpWorkingDirectories,
  acpWorkspaceFolders,
  acpWorkspacePath,
  acpWorkspaceProjectFolders,
} from "./workspaceScope";

describe("workspaceScope", () => {
  it("uses real IDE workspace folders outside desktop", () => {
    const state = appStateFor("vscode", [
      { path: "/repo-a", name: "repo-a", index: 0 },
      { path: "/repo-b", name: "repo-b", index: 1 },
    ]);

    const folders = acpWorkspaceFolders(state, "/ignored");

    expect(folders).toEqual(state.workspaces);
    expect(acpWorkspacePath(state, folders, "/ignored")).toBe(ACP_IDE_WORKSPACE_PATH);
    expect(acpProtocolCwd(folders)).toBe("/repo-a");
    expect(acpWorkingDirectories(folders, "/fallback")).toEqual(["/repo-a", "/repo-b"]);
  });

  it("uses the selected desktop root as the only workspace folder", () => {
    const state = appStateFor("desktop", [
      { path: "/ide-workspace", name: "ide-workspace", index: 0 },
    ]);

    const folders = acpWorkspaceFolders(state, "/repo-worktree");

    expect(folders).toEqual([{ path: "/repo-worktree", name: "repo-worktree", index: -1 }]);
    expect(acpWorkspacePath(state, folders, "/fallback")).toBe("/repo-worktree");
    expect(acpWorkingDirectories(folders, "/fallback")).toEqual(["/repo-worktree"]);
  });

  it("uses a stable navigation scope for chat working directories", () => {
    const state = appStateFor("desktop", []);
    const folders = acpWorkspaceFolders(state, "/state/camber/session-123");

    expect(acpSessionWorkspacePath(state, folders, "/state/camber/session-123", true)).toBe(
      ACP_CHAT_WORKSPACE_PATH,
    );
    expect(acpSessionWorkspacePath(state, folders, "/state/camber/session-123", false)).toBe(
      "/state/camber/session-123",
    );
  });

  it("expands a scoped desktop workspace to matching project folders for display", () => {
    const folders = [{ path: "/repo/worktree", name: "worktree", index: -1 }];
    const projects = [
      navProject("/repo"),
      navProject("/repo/worktree", {
        isWorktree: true,
        parentPath: "/repo",
        nickname: "Renamed Worktree",
      }),
      navProject("/other"),
    ];

    expect(acpWorkspaceProjectFolders(projects, folders)).toEqual([
      { path: "/repo", name: "repo", index: -1 },
      { path: "/repo/worktree", name: "Renamed Worktree", index: -1 },
    ]);
  });

  it("falls back to the scoped workspace folders when no project matches", () => {
    const folders = [{ path: "/repo/worktree", name: "worktree", index: -1 }];

    expect(acpWorkspaceProjectFolders([navProject("/other")], folders)).toBe(folders);
  });
});

describe("acpSessionLoadCwd", () => {
  const openFolders = [{ path: "/currently-open", name: "currently-open", index: 0 }];

  it("reopens a session in its own cwd, not the folder that happens to be open", () => {
    expect(acpSessionLoadCwd("/where-the-session-was-created", openFolders)).toBe(
      "/where-the-session-was-created",
    );
  });

  it("falls back to the open folder when the session recorded no cwd", () => {
    expect(acpSessionLoadCwd(undefined, openFolders)).toBe("/currently-open");
    expect(acpSessionLoadCwd(null, openFolders)).toBe("/currently-open");
    expect(acpSessionLoadCwd("   ", openFolders)).toBe("/currently-open");
  });

  it("falls back to root when there is neither a session cwd nor an open folder", () => {
    expect(acpSessionLoadCwd("", [])).toBe("/");
  });

  it("keeps a cwd whose spaces are part of the path", () => {
    expect(acpSessionLoadCwd(" /padded ", openFolders)).toBe(" /padded ");
  });
});

function appStateFor(host: string, workspaces: AppState["workspaces"]) {
  return {
    environment: {
      assistantHost: host,
    },
    workspaces,
  } as Pick<AppState, "environment" | "workspaces">;
}

function navProject(path: string, overrides: Partial<ACPNavProject> = {}): ACPNavProject {
  return {
    ...navProjectBase(path),
    ...overrides,
  };
}

function navProjectBase(path: string): ACPNavProject {
  return {
    path,
    name: path.split("/").at(-1) || path,
    isWorktree: false,
    collapsed: false,
    displayOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
