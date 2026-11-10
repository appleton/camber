import { appState, type ACPNavProject, type AppState } from "@camber/features/acp";
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import {
  defaultDesktopConversationCwd,
  resolveConversationWorkspaceScope,
  resolveDesktopWorkspaceRoot,
} from "./workspacePaths";

describe("defaultDesktopConversationCwd", () => {
  it("uses the first desktop project before falling back to host cwd", () => {
    const state = appStateWith({ assistantHost: "desktop", defaultCwd: "/fallback" });

    expect(
      defaultDesktopConversationCwd({
        appState: state,
        isDesktop: true,
        firstProject: project("/repo"),
      }),
    ).toBe("/repo");
    expect(
      defaultDesktopConversationCwd({
        appState: state,
        isDesktop: true,
      }),
    ).toBe("/fallback");
  });

  it("uses the active IDE workspace for non-desktop hosts", () => {
    const state = appStateWith({
      assistantHost: "vscode",
      defaultCwd: "/fallback",
      workspaces: [{ path: "/workspace", name: "workspace", index: 0 }],
    });

    expect(
      defaultDesktopConversationCwd({
        appState: state,
        isDesktop: false,
        firstProject: project("/repo"),
      }),
    ).toBe("/workspace");
  });
});

describe("resolveDesktopWorkspaceRoot", () => {
  it("chooses the most specific project containing the cwd", () => {
    expect(
      resolveDesktopWorkspaceRoot("/repo/packages/app", [
        project("/repo"),
        project("/repo/packages"),
      ]),
    ).toBe("/repo/packages");
  });

  it("normalizes trailing slashes, repeated separators, and drive casing", () => {
    expect(
      resolveDesktopWorkspaceRoot("C:\\Repo\\worktree\\src", [project("c:/Repo/worktree/")]),
    ).toBe("c:/Repo/worktree/");
  });

  it("falls back to the cwd when no desktop project contains it", () => {
    expect(resolveDesktopWorkspaceRoot("/other", [project("/repo")])).toBe("/other");
  });
});

describe("resolveConversationWorkspaceScope", () => {
  it("uses the desktop cwd as workspace path and working directory", () => {
    const state = appStateWith({ assistantHost: "desktop" });

    expect(resolveConversationWorkspaceScope(state, "/repo")).toEqual({
      cwd: "/repo",
      workspacePath: "/repo",
      workingDirectories: ["/repo"],
    });
  });

  it("uses IDE workspace scope outside the desktop host", () => {
    const state = appStateWith({
      assistantHost: "vscode",
      workspaces: [{ path: "/workspace", name: "workspace", index: 0 }],
    });

    expect(resolveConversationWorkspaceScope(state, "/repo")).toEqual({
      cwd: "/workspace",
      workspacePath: "IDE",
      workingDirectories: ["/workspace"],
    });
  });
});

function appStateWith(overrides: Partial<AppState> & { assistantHost?: string } = {}): AppState {
  const initial = get(appState);
  const { assistantHost, environment, ...rest } = overrides;
  return {
    ...initial,
    ...rest,
    environment: {
      ...initial.environment,
      ...environment,
      assistantHost:
        assistantHost ?? environment?.assistantHost ?? initial.environment.assistantHost,
    },
  };
}

function project(path: string): ACPNavProject {
  return {
    path,
    name: path.split("/").filter(Boolean).at(-1) ?? path,
    isWorktree: false,
    collapsed: false,
    displayOrder: 0,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
  };
}
