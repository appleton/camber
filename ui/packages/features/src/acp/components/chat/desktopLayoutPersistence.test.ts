import { SplitsController, type SplitNode, type TabID } from "@camber/splits";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDesktopSplitsLayout,
  clearStoredDefaultDesktopLayout,
  DESKTOP_DEFAULT_LAYOUT_CHANGED_EVENT,
  DESKTOP_LAYOUT_CONVERSATION_LIMIT,
  isDesktopDefaultLayoutCandidate,
  readStoredApplyDefaultDesktopLayoutToChats,
  readStoredDefaultDesktopLayout,
  readStoredDesktopLayout,
  readStoredWorktreeSetupSurface,
  renameStoredDesktopLayout,
  restorableTerminalCwd,
  shouldApplyStoredDefaultDesktopLayout,
  terminalPlacementForWorktreeSetupSurface,
  writeStoredApplyDefaultDesktopLayoutToChats,
  writeStoredDefaultDesktopLayout,
  writeStoredDesktopLayout,
  writeStoredWorktreeSetupSurface,
  type PersistedDesktopLayout,
} from "./desktopLayoutPersistence";
import type { DesktopSplitsEntry } from "./desktopSplitsCache";

describe("desktop layout persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("captures restorable descriptors without live terminal or file preview state", () => {
    const entry = createEntry("conversation-1");
    const chatTabId = entry.mainController.allTabIds[0]!;
    const terminalTabId = entry.mainController.createTab("Terminal", { icon: null })!;
    const fileTabId = entry.bottomPanelController.createTab("file.ts", { icon: "file" })!;
    entry.descriptors = {
      [chatTabId]: { kind: "chat" },
      [terminalTabId]: {
        kind: "terminal",
        worktreePath: "/repo",
        status: "ready",
        terminalId: "terminal-live",
        requestId: "request-live",
      },
      [fileTabId]: {
        kind: "file",
        path: "/repo/file.ts",
        cwd: "/repo",
        line: 12,
        column: 3,
        openToken: 4,
      },
    };

    const layout = captureDesktopSplitsLayout(entry, {
      rightSidebarVisible: true,
      bottomPanelVisible: true,
      activeSurface: "rightSidebar",
    });

    expect(layout?.descriptors[terminalTabId]).toEqual({
      kind: "terminal",
      worktreePath: "/repo",
    });
    expect(layout?.descriptors[fileTabId]).toBeUndefined();
    expect(layout && tabIdsForSplitNode(layout.surfaces.bottomPanel.rootNode)).not.toContain(
      fileTabId,
    );
    expect(layout?.rightSidebarVisible).toBe(true);
    expect(layout?.bottomPanelVisible).toBe(true);
    expect(layout?.activeSurface).toBe("rightSidebar");
  });

  it("captures diff tabs as worktree-only, keeping their pane in the layout", () => {
    const entry = createEntry("conversation-diff");
    const diffTabId = entry.mainController.createTab("Review Diff", { icon: "diff" })!;
    entry.descriptors[diffTabId] = {
      kind: "diff",
      worktreePath: "/repo",
      relativePath: "src/app.ts",
      openToken: 7,
    };

    const layout = captureDesktopSplitsLayout(entry, {
      rightSidebarVisible: false,
      bottomPanelVisible: false,
    })!;

    // Worktree only: the session and the last targeted file are transient.
    expect(layout.descriptors[diffTabId]).toEqual({ kind: "diff", worktreePath: "/repo" });
    expect(tabIdsForSplitNode(layout.surfaces.main.rootNode)).toContain(diffTabId);

    // Round-trips through storage normalization.
    writeStoredDesktopLayout("conversation-diff", layout);
    expect(readStoredDesktopLayout("conversation-diff")?.descriptors[diffTabId]).toEqual({
      kind: "diff",
      worktreePath: "/repo",
    });
  });

  it("captures diff tabs in the default layout as shape only", () => {
    const entry = createEntry("conversation-diff-default");
    const diffTabId = entry.mainController.createTab("Review Diff", { icon: "diff" })!;
    entry.descriptors[diffTabId] = { kind: "diff", worktreePath: "/repo", openToken: 1 };

    const layout = captureDesktopSplitsLayout(entry, {
      rightSidebarVisible: false,
      bottomPanelVisible: false,
      shapeOnlyTerminals: true,
    })!;

    // Like terminals: a template layout must not pin a foreign worktree.
    expect(layout.descriptors[diffTabId]).toEqual({ kind: "diff", worktreePath: "" });
  });

  it("persists subagent chat tabs per conversation but excludes them from defaults", () => {
    const entry = createEntry("conversation-subagent");
    const subagentTabId = entry.mainController.createTab("Auth researcher", {
      icon: "agent",
    })!;
    entry.descriptors[subagentTabId] = {
      kind: "subagent-chat",
      conversationId: "conversation-subagent",
      subagentKey: "claude:task-1",
      title: "Auth researcher",
    };
    const codexTabId = entry.mainController.createTab("Codex researcher", {
      icon: "agent",
    })!;
    entry.descriptors[codexTabId] = {
      kind: "subagent-chat",
      conversationId: "conversation-subagent",
      subagentKey: "codex:thread-1",
      title: "Codex researcher",
    };

    const conversationLayout = captureDesktopSplitsLayout(entry, {
      rightSidebarVisible: false,
      bottomPanelVisible: false,
    })!;
    expect(conversationLayout.descriptors[subagentTabId]).toEqual({
      kind: "subagent-chat",
      conversationId: "conversation-subagent",
      subagentKey: "claude:task-1",
      title: "Auth researcher",
    });
    expect(conversationLayout.descriptors[codexTabId]).toBeUndefined();
    expect(tabIdsForSplitNode(conversationLayout.surfaces.main.rootNode)).not.toContain(codexTabId);

    writeStoredDesktopLayout("conversation-subagent", conversationLayout);
    expect(readStoredDesktopLayout("conversation-subagent")?.descriptors[subagentTabId]).toEqual(
      conversationLayout.descriptors[subagentTabId],
    );

    const defaultLayout = captureDesktopSplitsLayout(entry, {
      rightSidebarVisible: false,
      bottomPanelVisible: false,
      excludeConversationSpecificTabs: true,
    })!;
    expect(defaultLayout.descriptors[subagentTabId]).toBeUndefined();
    expect(tabIdsForSplitNode(defaultLayout.surfaces.main.rootNode)).not.toContain(subagentTabId);

    const legacyLayout: PersistedDesktopLayout = {
      version: 1,
      surfaces: {
        main: entry.mainController.serializeState(),
        rightSidebar: entry.rightSidebarController.serializeState(),
        bottomPanel: entry.bottomPanelController.serializeState(),
      },
      descriptors: {
        ...conversationLayout.descriptors,
        [codexTabId]: {
          kind: "subagent-chat",
          conversationId: "conversation-subagent",
          subagentKey: "codex:thread-1",
          title: "Codex researcher",
        },
      },
      rightSidebarVisible: false,
      bottomPanelVisible: false,
    };
    writeStoredDesktopLayout("legacy-codex-subagent", legacyLayout);
    const migratedLayout = readStoredDesktopLayout("legacy-codex-subagent")!;
    expect(migratedLayout.descriptors[codexTabId]).toBeUndefined();
    expect(tabIdsForSplitNode(migratedLayout.surfaces.main.rootNode)).not.toContain(codexTabId);
  });

  it("captures the files tree subview so changes mode round-trips", () => {
    window.localStorage.setItem(
      "camber.desktop.filesTreePrefs.v1",
      JSON.stringify({
        version: 1,
        worktrees: { "/repo": { viewMode: "changes", expandedDirectoryPaths: ["src"] } },
      }),
    );
    const entry = createEntry("conversation-files");
    const filesTabId = entry.mainController.createTab("Files", { icon: "folder-open" })!;
    entry.descriptors[filesTabId] = { kind: "files", rootPath: "/repo" };

    const layout = captureDesktopSplitsLayout(entry, {
      rightSidebarVisible: false,
      bottomPanelVisible: false,
    })!;
    expect(layout.descriptors[filesTabId]).toEqual({
      kind: "files",
      rootPath: "/repo",
      viewMode: "changes",
    });

    writeStoredDesktopLayout("conversation-files", layout);
    expect(readStoredDesktopLayout("conversation-files")?.descriptors[filesTabId]).toEqual({
      kind: "files",
      rootPath: "/repo",
      viewMode: "changes",
    });
  });

  it("writes, reads, and renames persisted conversation layouts", () => {
    const layout = captureDesktopSplitsLayout(createEntry("draft"), {
      rightSidebarVisible: false,
      bottomPanelVisible: true,
    })!;

    writeStoredDesktopLayout("new:camber:/repo", layout);
    renameStoredDesktopLayout("new:camber:/repo", "conversation-1");

    expect(readStoredDesktopLayout("new:camber:/repo")).toBeUndefined();
    expect(readStoredDesktopLayout("conversation-1")).toEqual(layout);
  });

  it("stores a default layout separately from conversation layouts", () => {
    const layout = captureDesktopSplitsLayout(createEntry("default"), {
      rightSidebarVisible: true,
      bottomPanelVisible: false,
    })!;

    writeStoredDefaultDesktopLayout(layout);

    expect(readStoredDefaultDesktopLayout()).toEqual(layout);
    expect(readStoredDesktopLayout("conversation-1")).toBeUndefined();
  });

  it("always applies defaults to project sessions and requires an opt-in for chats", () => {
    expect(readStoredApplyDefaultDesktopLayoutToChats()).toBe(false);
    expect(shouldApplyStoredDefaultDesktopLayout(false)).toBe(true);
    expect(shouldApplyStoredDefaultDesktopLayout(true)).toBe(false);

    writeStoredApplyDefaultDesktopLayoutToChats(true);

    expect(readStoredApplyDefaultDesktopLayoutToChats()).toBe(true);
    expect(shouldApplyStoredDefaultDesktopLayout(false)).toBe(true);
    expect(shouldApplyStoredDefaultDesktopLayout(true)).toBe(true);

    writeStoredApplyDefaultDesktopLayoutToChats(false);
    expect(shouldApplyStoredDefaultDesktopLayout(true)).toBe(false);
  });

  it("caps persisted conversation layouts and refreshes recency on write or rename", () => {
    const layout = captureDesktopSplitsLayout(createEntry("default"), {
      rightSidebarVisible: false,
      bottomPanelVisible: false,
    })!;

    for (let index = 0; index < DESKTOP_LAYOUT_CONVERSATION_LIMIT; index++) {
      writeStoredDesktopLayout(`conversation-${index}`, layout);
    }

    writeStoredDesktopLayout("conversation-0", layout);
    renameStoredDesktopLayout("conversation-2", "conversation-renamed");
    writeStoredDesktopLayout("conversation-overflow", layout);
    writeStoredDesktopLayout("conversation-overflow-2", layout);

    expect(readStoredDesktopLayout("conversation-0")).toEqual(layout);
    expect(readStoredDesktopLayout("conversation-renamed")).toEqual(layout);
    expect(readStoredDesktopLayout("conversation-overflow")).toEqual(layout);
    expect(readStoredDesktopLayout("conversation-overflow-2")).toEqual(layout);
    expect(readStoredDesktopLayout("conversation-1")).toBeUndefined();
    expect(readStoredDesktopLayout("conversation-2")).toBeUndefined();
    expect(readStoredDesktopLayout("conversation-3")).toBeUndefined();
  });

  it("clears the stored default layout without clearing conversation layouts", () => {
    const layout = captureDesktopSplitsLayout(createEntry("default"), {
      rightSidebarVisible: true,
      bottomPanelVisible: false,
    })!;
    const listener = vi.fn();
    window.addEventListener(DESKTOP_DEFAULT_LAYOUT_CHANGED_EVENT, listener);

    writeStoredDesktopLayout("conversation-1", layout);
    writeStoredDefaultDesktopLayout(layout);
    clearStoredDefaultDesktopLayout();

    expect(readStoredDefaultDesktopLayout()).toBeUndefined();
    expect(readStoredDesktopLayout("conversation-1")).toEqual(layout);
    expect(listener).toHaveBeenCalledTimes(2);
    window.removeEventListener(DESKTOP_DEFAULT_LAYOUT_CHANGED_EVENT, listener);
  });

  it("captures and round-trips a live terminal's cwd", () => {
    const entry = createEntry("conversation-1");
    const terminalTabId = entry.mainController.createTab("Terminal", { icon: null })!;
    entry.descriptors[terminalTabId] = {
      kind: "terminal",
      worktreePath: "/repo",
      status: "ready",
      terminalId: "terminal-live",
      requestId: "request-live",
    };

    const layout = captureDesktopSplitsLayout(entry, {
      rightSidebarVisible: false,
      bottomPanelVisible: false,
      terminalCwd: (terminalId) => (terminalId === "terminal-live" ? "/repo/src" : undefined),
    })!;
    writeStoredDesktopLayout("conversation-1", layout);

    expect(readStoredDesktopLayout("conversation-1")?.descriptors[terminalTabId]).toEqual({
      kind: "terminal",
      worktreePath: "/repo",
      cwd: "/repo/src",
    });
  });

  it("captures the default layout as shape only, dropping terminal worktree and cwd", () => {
    const entry = createEntry("conversation-1");
    const terminalTabId = entry.mainController.createTab("Terminal", { icon: null })!;
    entry.descriptors[terminalTabId] = {
      kind: "terminal",
      worktreePath: "/repo-a",
      status: "ready",
      terminalId: "terminal-live",
      requestId: "request-live",
    };

    const layout = captureDesktopSplitsLayout(entry, {
      rightSidebarVisible: false,
      bottomPanelVisible: false,
      shapeOnlyTerminals: true,
      terminalCwd: () => "/repo-a/src",
    })!;

    // No worktree path or cwd leaks from the saving conversation into the template.
    expect(layout.descriptors[terminalTabId]).toEqual({ kind: "terminal", worktreePath: "" });
  });

  it("only restores a terminal cwd inside its worktree", () => {
    expect(restorableTerminalCwd("/repo/src", "/repo")).toBe("/repo/src");
    expect(restorableTerminalCwd("/repo/src", "/repo/")).toBe("/repo/src");
    // The worktree root is the spawn default; no need to override.
    expect(restorableTerminalCwd("/repo", "/repo")).toBeUndefined();
    // A sibling path must not match by prefix alone.
    expect(restorableTerminalCwd("/repo-other/src", "/repo")).toBeUndefined();
    expect(restorableTerminalCwd("/elsewhere", "/repo")).toBeUndefined();
    expect(restorableTerminalCwd(undefined, "/repo")).toBeUndefined();
    expect(restorableTerminalCwd("/repo/src", "")).toBeUndefined();
  });

  it("normalizes separators and drive casing when validating a terminal cwd", () => {
    // OSC7 reports forward slashes; the worktree path may be native or differently cased.
    expect(restorableTerminalCwd("C:/repo/src", "C:\\repo")).toBe("C:/repo/src");
    expect(restorableTerminalCwd("c:/repo/src", "C:/repo")).toBe("c:/repo/src");
    // Same directory once normalized — no override needed.
    expect(restorableTerminalCwd("C:\\repo", "C:/repo")).toBeUndefined();
    // Different drive is not contained.
    expect(restorableTerminalCwd("D:/other/src", "C:/repo")).toBeUndefined();
  });

  it("treats persisted pending conversations as default-layout candidates", () => {
    expect(isDesktopDefaultLayoutCandidate("new:camber:/repo")).toBe(true);
    expect(isDesktopDefaultLayoutCandidate("conversation-1", "conversation-1")).toBe(true);
    expect(isDesktopDefaultLayoutCandidate("conversation-1", null)).toBe(false);
    expect(isDesktopDefaultLayoutCandidate("conversation-1", "conversation-2")).toBe(false);
  });

  it("round-trips the worktree setup surface and normalizes unknown values", () => {
    expect(readStoredWorktreeSetupSurface()).toBe("sidebar");

    writeStoredWorktreeSetupSurface("bottomPanel");
    expect(readStoredWorktreeSetupSurface()).toBe("bottomPanel");

    writeStoredWorktreeSetupSurface("mainTab");
    expect(readStoredWorktreeSetupSurface()).toBe("mainTab");

    window.localStorage.setItem("camber.desktop.worktreeSetupSurface.v1", "garbage");
    expect(readStoredWorktreeSetupSurface()).toBe("sidebar");
  });

  it("maps worktree setup surfaces to terminal placements", () => {
    expect(terminalPlacementForWorktreeSetupSurface("sidebar")).toBe("splitRight");
    expect(terminalPlacementForWorktreeSetupSurface("bottomPanel")).toBe("bottomPanel");
    expect(terminalPlacementForWorktreeSetupSurface("mainTab")).toBe("mainTab");
  });
});

function createEntry(key: string): DesktopSplitsEntry {
  const mainController = new SplitsController();
  const rightSidebarController = emptyController();
  const bottomPanelController = emptyController();
  const chatTabId = mainController.allTabIds[0] as TabID;
  mainController.updateTab(chatTabId, {
    title: "Chatting with Camber",
    icon: "agent",
    isClosable: false,
  });

  return {
    cacheKey: key,
    mainController,
    rightSidebarController,
    bottomPanelController,
    descriptors: {
      [chatTabId]: { kind: "chat" },
    },
    terminalPromises: new Map(),
    dispose: vi.fn(),
  };
}

function emptyController(): SplitsController {
  const controller = new SplitsController();
  const tabId = controller.allTabIds[0];
  if (tabId) {
    controller.closeTab(tabId);
  }
  return controller;
}

function tabIdsForSplitNode(node: SplitNode): TabID[] {
  if (node.type === "pane") {
    return node.pane.tabs.map((tab) => tab.id);
  }

  return [...tabIdsForSplitNode(node.split.first), ...tabIdsForSplitNode(node.split.second)];
}
