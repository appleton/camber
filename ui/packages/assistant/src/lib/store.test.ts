import type { WorkspaceFolder } from "@camber/rpc";
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { appState, appStateUpdates, workspaceFromCwd, type AppState } from "./store";

describe("workspaceFromCwd", () => {
  it("creates a workspace folder from an ACP cwd", () => {
    expect(workspaceFromCwd("/Users/poolie/project")).toEqual({
      path: "/Users/poolie/project",
      name: "project",
      index: -1,
    });
  });

  it("ignores empty and root cwd fallbacks", () => {
    expect(workspaceFromCwd("")).toBeUndefined();
    expect(workspaceFromCwd("/")).toBeUndefined();
  });
});

describe("appStateUpdates.ensureWorkspaceForCwd", () => {
  it("populates workspaces from cwd when the host did not provide workspace folders", () => {
    const state = { workspaces: [] as WorkspaceFolder[] } as AppState;

    expect(appStateUpdates.ensureWorkspaceForCwd("/Users/poolie/project")(state)).toMatchObject({
      workspaces: [{ path: "/Users/poolie/project", name: "project", index: -1 }],
    });
  });

  it("replaces a previous cwd-derived workspace when the ACP session cwd changes", () => {
    const state = {
      workspaces: [{ path: "/Users/poolie/old-project", name: "old-project", index: -1 }],
    } as AppState;

    expect(appStateUpdates.ensureWorkspaceForCwd("/Users/poolie/project")(state)).toMatchObject({
      workspaces: [{ path: "/Users/poolie/project", name: "project", index: -1 }],
    });
  });

  it("leaves host-provided workspace folders alone", () => {
    const state = {
      workspaces: [{ path: "/workspace", name: "workspace", index: 0 }],
    } as AppState;

    expect(appStateUpdates.ensureWorkspaceForCwd("/Users/poolie/project")(state)).toBe(state);
  });

  it("keeps desktop workspaces empty", () => {
    const state = {
      ...get(appState),
      environment: { ...get(appState).environment, assistantHost: "desktop" },
      workspaces: [],
    };

    expect(appStateUpdates.ensureWorkspaceForCwd("/Users/poolie/project")(state)).toBe(state);
  });
});
