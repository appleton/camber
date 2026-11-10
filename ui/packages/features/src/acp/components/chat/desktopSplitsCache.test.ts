import { SplitsController, type TabID } from "@camber/splits";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_SPLITS_CACHE_LIMIT,
  DesktopSplitsCache,
  terminalIdsForDesktopSplitsEntry,
  type DesktopSplitsCacheEvictionReason,
  type DesktopSplitsEntry,
} from "./desktopSplitsCache";

function createEntry(key: string, terminalId?: string): DesktopSplitsEntry {
  const mainController = new SplitsController();
  const rightSidebarController = new SplitsController();
  const bottomPanelController = new SplitsController();
  const tabId = mainController.allTabIds[0] as TabID;
  return {
    cacheKey: key,
    mainController,
    rightSidebarController,
    bottomPanelController,
    descriptors: {
      [tabId]: terminalId
        ? {
            kind: "terminal",
            worktreePath: "/workspace",
            status: "ready",
            terminalId,
            requestId: `${key}-request`,
          }
        : { kind: "chat" },
    },
    terminalPromises: new Map(),
    dispose: vi.fn(),
  };
}

function createEntryWithRightSidebarTerminal(key: string, terminalId: string): DesktopSplitsEntry {
  const entry = createEntry(key);
  const tabId = entry.rightSidebarController.allTabIds[0] as TabID;
  entry.descriptors[tabId] = {
    kind: "terminal",
    worktreePath: "/workspace",
    status: "ready",
    terminalId,
    requestId: `${key}-right-sidebar-request`,
  };
  return entry;
}

function createEntryWithBottomPanelTerminal(key: string, terminalId: string): DesktopSplitsEntry {
  const entry = createEntry(key);
  const tabId = entry.bottomPanelController.allTabIds[0] as TabID;
  entry.descriptors[tabId] = {
    kind: "terminal",
    worktreePath: "/workspace",
    status: "ready",
    terminalId,
    requestId: `${key}-bottom-panel-request`,
  };
  return entry;
}

describe("DesktopSplitsCache", () => {
  it("keeps at most ten conversation entries and evicts the least recently used entry", () => {
    const evicted: Array<{
      key: string;
      reason: DesktopSplitsCacheEvictionReason;
      terminalIds: string[];
    }> = [];
    const cache = new DesktopSplitsCache({
      onEvictEntry: (entry, reason) => {
        evicted.push({
          key: entry.cacheKey,
          reason,
          terminalIds: terminalIdsForDesktopSplitsEntry(entry),
        });
      },
    });

    for (let index = 0; index < DESKTOP_SPLITS_CACHE_LIMIT; index++) {
      cache.getOrCreate(`conversation-${index}`, (key) => createEntry(key, `terminal-${index}`));
    }
    cache.getOrCreate("conversation-0", createEntry);
    cache.getOrCreate("conversation-10", (key) => createEntry(key, "terminal-10"));

    expect(cache.size).toBe(DESKTOP_SPLITS_CACHE_LIMIT);
    expect(cache.keys()).not.toContain("conversation-1");
    expect(cache.keys()).toContain("conversation-0");
    expect(cache.keys()).toContain("conversation-10");
    expect(evicted).toEqual([
      {
        key: "conversation-1",
        reason: "lru",
        terminalIds: ["terminal-1"],
      },
    ]);
  });

  it("renames a draft entry without evicting it", () => {
    const evictEntry = vi.fn();
    const cache = new DesktopSplitsCache({ onEvictEntry: evictEntry });
    const draft = cache.getOrCreate("new:camber:/workspace", (key) =>
      createEntry(key, "terminal-draft"),
    );

    const renamed = cache.rename("new:camber:/workspace", "conversation-id");

    expect(renamed).toBe(draft);
    expect(cache.get("new:camber:/workspace")).toBeUndefined();
    expect(cache.get("conversation-id")).toBe(draft);
    expect(draft.cacheKey).toBe("conversation-id");
    expect(evictEntry).not.toHaveBeenCalled();
  });

  it("evicts the replaced target when renaming over an existing entry", () => {
    const evicted: Array<{ key: string; reason: DesktopSplitsCacheEvictionReason }> = [];
    const cache = new DesktopSplitsCache({
      onEvictEntry: (entry, reason) => evicted.push({ key: entry.cacheKey, reason }),
    });
    const draft = cache.getOrCreate("draft", (key) => createEntry(key, "terminal-draft"));
    const existing = cache.getOrCreate("conversation-id", (key) =>
      createEntry(key, "terminal-existing"),
    );

    const renamed = cache.rename("draft", "conversation-id");

    expect(renamed).toBe(draft);
    expect(cache.get("conversation-id")).toBe(draft);
    expect(existing.disposed).toBe(true);
    expect(evicted).toEqual([{ key: "conversation-id", reason: "replace" }]);
  });

  it("indexes entries by all split controllers and reports terminal ids from side surfaces", () => {
    const cache = new DesktopSplitsCache();
    const rightEntry = cache.getOrCreate("conversation-right", (key) =>
      createEntryWithRightSidebarTerminal(key, "terminal-right"),
    );
    const bottomEntry = cache.getOrCreate("conversation-bottom", (key) =>
      createEntryWithBottomPanelTerminal(key, "terminal-bottom"),
    );

    expect(cache.entryForController(rightEntry.mainController)).toBe(rightEntry);
    expect(cache.entryForController(rightEntry.rightSidebarController)).toBe(rightEntry);
    expect(cache.entryForController(rightEntry.bottomPanelController)).toBe(rightEntry);
    expect(cache.entryForController(bottomEntry.bottomPanelController)).toBe(bottomEntry);
    expect(terminalIdsForDesktopSplitsEntry(rightEntry)).toEqual(["terminal-right"]);
    expect(terminalIdsForDesktopSplitsEntry(bottomEntry)).toEqual(["terminal-bottom"]);
  });
});
