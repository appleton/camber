import type { SearchFile, SearchFilesOutput } from "@camber/helperapi/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../../hostAdapter";
import { acpDesktopWorkspaceRoot, pathContains, searchProjectFiles } from "./fileSearch";

vi.mock("@camber/helperapi", () => ({
  camberSearchFiles: vi.fn(),
}));

describe("searchProjectFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps existing desktop searches scoped to the containing project root", async () => {
    const { camberSearchFiles } = await import("@camber/helperapi");
    vi.mocked(camberSearchFiles).mockResolvedValue(emptySearchResponse());

    await searchProjectFiles({
      query: "button",
      appState: appStateFor("desktop"),
      activeWorkspaceCwd: "/repo/packages/app",
      projects: [{ path: "/repo" }],
    });

    expect(camberSearchFiles).toHaveBeenCalledWith({
      query: "button",
      workspaces: [{ path: "/repo", name: "repo", index: -1 }],
      excludeOpenFilesOutsideWorkspaces: false,
    });
  });

  it("can scope desktop searches to the exact conversation cwd", async () => {
    const { camberSearchFiles } = await import("@camber/helperapi");
    vi.mocked(camberSearchFiles).mockResolvedValue(emptySearchResponse());

    await searchProjectFiles({
      query: "button",
      appState: appStateFor("desktop"),
      activeWorkspaceCwd: "/repo/packages/app",
      projects: [{ path: "/repo" }],
      desktopWorkspaceScope: "cwd",
      excludeOpenFilesOutsideWorkspaces: true,
    });

    expect(camberSearchFiles).toHaveBeenCalledWith({
      query: "button",
      workspaces: [{ path: "/repo/packages/app", name: "app", index: -1 }],
      excludeOpenFilesOutsideWorkspaces: true,
    });
  });

  it("does not fall back to helper-global workspaces for cwd-scoped desktop searches", async () => {
    const { camberSearchFiles } = await import("@camber/helperapi");

    const result = await searchProjectFiles({
      query: "button",
      appState: appStateFor("desktop"),
      activeWorkspaceCwd: null,
      projects: [{ path: "/repo" }],
      desktopWorkspaceScope: "cwd",
    });

    expect(camberSearchFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "ok", response: { files: [] } });
  });

  it("filters cwd-scoped desktop responses back to the conversation cwd", async () => {
    const { camberSearchFiles } = await import("@camber/helperapi");
    vi.mocked(camberSearchFiles).mockResolvedValue({
      workspaces: ["app"],
      files: [
        searchFile("/repo/packages/app/Button.svelte"),
        searchFile("/repo/packages/other/Button.svelte"),
      ],
      controls: [
        { kind: "current", path: "/repo/packages/app", displayPath: "." },
        { kind: "parent", path: "/repo/packages", displayPath: ".." },
      ],
    });

    const result = await searchProjectFiles({
      query: "button",
      appState: appStateFor("desktop"),
      activeWorkspaceCwd: "/repo/packages/app",
      desktopWorkspaceScope: "cwd",
    });

    expect(result).toEqual({
      kind: "ok",
      response: {
        workspaces: ["app"],
        files: [searchFile("/repo/packages/app/Button.svelte")],
        controls: [{ kind: "current", path: "/repo/packages/app", displayPath: "." }],
      },
    });
  });
});

describe("acpDesktopWorkspaceRoot", () => {
  it("uses the deepest containing desktop project", () => {
    expect(
      acpDesktopWorkspaceRoot(appStateFor("desktop"), "/repo/worktrees/feature/packages/app", [
        { path: "/repo" },
        { path: "/repo/worktrees/feature" },
      ]),
    ).toBe("/repo/worktrees/feature");
  });

  it("normalizes child paths before containment checks", () => {
    expect(pathContains("C:\\Repo\\App\\", "c:/Repo/App/src/Button.svelte")).toBe(true);
  });
});

function appStateFor(
  host: string,
): Pick<AppState, "environment" | "isHelperSupported" | "workspaces"> {
  return {
    environment: {
      assistantHost: host,
      operatingSystem: "darwin",
    },
    isHelperSupported: true,
    workspaces: [{ path: "/ide-workspace", name: "ide-workspace", index: 0 }],
  } as Pick<AppState, "environment" | "isHelperSupported" | "workspaces">;
}

function emptySearchResponse(): SearchFilesOutput {
  return { files: [] };
}

function searchFile(path: string): SearchFile {
  const name = path.split("/").at(-1) ?? path;
  return {
    path,
    name: { value: name, score: 0, indices: [] },
    directory: { value: ".", score: 0, indices: [] },
  };
}
