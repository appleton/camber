import type { AssistantTerminalTab } from "@camber/rpc";
import type { PaneID, PixelRect, SplitsController, Tab, TabID } from "@camber/splits";
import type {
  AssistantTerminalCommandMode,
  AssistantTerminalPlacement,
} from "../../features/AssistantTerminalRepository.svelte";

export const DESKTOP_SPLITS_CACHE_LIMIT = 10;

export type DesktopTabDescriptor =
  | {
      kind: "chat";
    }
  | {
      kind: "subagent-chat";
      conversationId: string;
      subagentKey: string;
      title: string;
    }
  | {
      kind: "terminal";
      worktreePath: string;
      status: "pending" | "ready" | "failed";
      terminalId?: string;
      requestId: string;
      error?: string;
    }
  | {
      kind: "trajectory";
    }
  | {
      kind: "files";
      rootPath: string;
    }
  | {
      kind: "github";
      worktreePath: string;
    }
  | {
      kind: "file";
      path: string;
      cwd?: string;
      line?: number;
      column?: number;
      openToken: number;
    }
  | {
      /**
       * Singleton all-files git diff viewer. At most one diff tab exists per
       * layout: opening a diff refocuses the existing tab (optionally
       * scrolling to a requested file).
       */
      kind: "diff";
      worktreePath: string;
      /** File to scroll into view when the tab is (re)targeted. */
      relativePath?: string;
      openToken: number;
    };

export interface TerminalCreateOptions {
  worktreePath: string;
  cwd?: string;
  command?: string;
  env?: Record<string, string>;
  commandMode?: AssistantTerminalCommandMode;
  placement?: AssistantTerminalPlacement;
  selectWhenReady?: boolean;
  /**
   * Whether opening the terminal takes keyboard focus. False for terminals the
   * app opens on its own behalf (worktree setup): they claim a tab and become
   * visible, but leave the keyboard where the user put it.
   */
  focus?: boolean;
}

export type RestorableDesktopTabDescriptor =
  | {
      kind: "subagent-chat";
      conversationId: string;
      subagentKey: string;
      title: string;
    }
  | {
      kind: "terminal";
      worktreePath: string;
      cwd?: string;
    }
  | {
      kind: "trajectory";
    }
  | {
      kind: "files";
      rootPath: string;
    }
  | {
      kind: "github";
      worktreePath: string;
    }
  | {
      kind: "file";
      path: string;
      cwd?: string;
      line?: number;
      column?: number;
    };

export interface ClosedDesktopTab {
  tabId: TabID;
  tab: Pick<Tab, "title" | "icon" | "isDirty" | "isClosable">;
  descriptor: RestorableDesktopTabDescriptor;
  surface: DesktopSplitSurface;
  paneId: PaneID;
  paneFrame?: PixelRect;
  wasOnlyTabInPane: boolean;
}

export type DesktopSplitSurface = "main" | "rightSidebar" | "bottomPanel";

export interface DesktopSplitsEntry {
  cacheKey: string;
  mainController: SplitsController;
  rightSidebarController: SplitsController;
  bottomPanelController: SplitsController;
  descriptors: Record<TabID, DesktopTabDescriptor>;
  subagentRevisionByTab?: Record<TabID, string>;
  unreadSubagentTabIds?: Set<TabID>;
  terminalPromises: Map<TabID, Promise<AssistantTerminalTab | undefined>>;
  lastClosedTab?: ClosedDesktopTab;
  pendingClosedTab?: ClosedDesktopTab;
  pendingDefaultLayoutHydration?: boolean;
  disposed?: boolean;
  dispose: () => void;
}

export type DesktopSplitsCacheEvictionReason = "lru" | "replace" | "dispose";

export interface DesktopSplitsCacheOptions {
  maxEntries?: number;
  onEvictEntry?: (entry: DesktopSplitsEntry, reason: DesktopSplitsCacheEvictionReason) => void;
}

export class DesktopSplitsCache {
  private readonly maxEntries: number;
  private readonly onEvictEntry?: DesktopSplitsCacheOptions["onEvictEntry"];
  private readonly entries = new Map<string, DesktopSplitsEntry>();
  private readonly entriesByController = new WeakMap<SplitsController, DesktopSplitsEntry>();

  constructor(options: DesktopSplitsCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DESKTOP_SPLITS_CACHE_LIMIT;
    this.onEvictEntry = options.onEvictEntry;
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  entryForController(controller: SplitsController): DesktopSplitsEntry | undefined {
    return this.entriesByController.get(controller);
  }

  get(key: string): DesktopSplitsEntry | undefined {
    return this.entries.get(stableDesktopSplitsKey(key));
  }

  getOrCreate(key: string, createEntry: (key: string) => DesktopSplitsEntry): DesktopSplitsEntry {
    const stableKey = stableDesktopSplitsKey(key);
    const existing = this.entries.get(stableKey);
    if (existing) {
      this.touch(stableKey, existing);
      return existing;
    }

    const entry = createEntry(stableKey);
    entry.cacheKey = stableKey;
    entry.disposed = false;
    this.entries.set(stableKey, entry);
    this.entriesByController.set(entry.mainController, entry);
    this.entriesByController.set(entry.rightSidebarController, entry);
    this.entriesByController.set(entry.bottomPanelController, entry);
    this.evictOverflow();
    return entry;
  }

  rename(fromKey: string, toKey: string): DesktopSplitsEntry | undefined {
    const stableFromKey = stableDesktopSplitsKey(fromKey);
    const stableToKey = stableDesktopSplitsKey(toKey);
    if (stableFromKey === stableToKey) {
      const existing = this.entries.get(stableToKey);
      if (existing) this.touch(stableToKey, existing);
      return existing;
    }

    const entry = this.entries.get(stableFromKey);
    if (!entry) {
      const existing = this.entries.get(stableToKey);
      if (existing) this.touch(stableToKey, existing);
      return existing;
    }

    const replaced = this.entries.get(stableToKey);
    if (replaced && replaced !== entry) {
      this.evict(stableToKey, replaced, "replace");
    }

    this.entries.delete(stableFromKey);
    entry.cacheKey = stableToKey;
    this.entries.set(stableToKey, entry);
    this.touch(stableToKey, entry);
    this.evictOverflow();
    return entry;
  }

  disposeAll(): void {
    for (const [key, entry] of [...this.entries]) {
      this.evict(key, entry, "dispose");
    }
  }

  private touch(key: string, entry: DesktopSplitsEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) return;
      const [key, entry] = oldest;
      this.evict(key, entry, "lru");
    }
  }

  private evict(
    key: string,
    entry: DesktopSplitsEntry,
    reason: DesktopSplitsCacheEvictionReason,
  ): void {
    this.entries.delete(key);
    this.entriesByController.delete(entry.mainController);
    this.entriesByController.delete(entry.rightSidebarController);
    this.entriesByController.delete(entry.bottomPanelController);
    entry.disposed = true;
    entry.dispose();
    this.onEvictEntry?.(entry, reason);
  }
}

export function terminalIdsForDesktopSplitsEntry(entry: DesktopSplitsEntry): string[] {
  const terminalIds: string[] = [];
  for (const descriptor of Object.values(entry.descriptors)) {
    if (descriptor.kind === "terminal" && descriptor.terminalId) {
      terminalIds.push(descriptor.terminalId);
    }
  }
  return terminalIds;
}

export function stableDesktopSplitsKey(key: string): string {
  return key || "desktop-chat";
}
