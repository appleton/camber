import type { SerializedSplitsState, SplitNode, TabID } from "@camber/splits";
import type { AssistantTerminalPlacement } from "../../features/AssistantTerminalRepository.svelte";
import { subagentKeyProvidesTranscript } from "../../subagents";
import { readDesktopFilesTreePrefs } from "./desktopFilesTreePrefs";
import {
  stableDesktopSplitsKey,
  type DesktopSplitsEntry,
  type DesktopSplitSurface,
  type DesktopTabDescriptor,
} from "./desktopSplitsCache";

const DESKTOP_LAYOUT_STORAGE_KEY = "camber.desktop.layouts.v1";
const DESKTOP_LAYOUT_STORE_VERSION = 1;
const DESKTOP_LAYOUT_VERSION = 1;
const WORKTREE_SETUP_SURFACE_STORAGE_KEY = "camber.desktop.worktreeSetupSurface.v1";
export const DESKTOP_LAYOUT_CONVERSATION_LIMIT = 50;
export const DESKTOP_DEFAULT_LAYOUT_CHANGED_EVENT = "camber:desktop-default-layout-changed";

/** Where worktree setup scripts open their visible terminal on desktop. */
export type DesktopWorktreeSetupSurface = "sidebar" | "bottomPanel" | "mainTab";

export function readStoredWorktreeSetupSurface(): DesktopWorktreeSetupSurface {
  try {
    const value = globalThis.localStorage?.getItem(WORKTREE_SETUP_SURFACE_STORAGE_KEY);
    return normalizeWorktreeSetupSurface(value);
  } catch {
    return "sidebar";
  }
}

export function writeStoredWorktreeSetupSurface(surface: DesktopWorktreeSetupSurface): void {
  globalThis.localStorage?.setItem(WORKTREE_SETUP_SURFACE_STORAGE_KEY, surface);
}

export function terminalPlacementForWorktreeSetupSurface(
  surface: DesktopWorktreeSetupSurface,
): AssistantTerminalPlacement {
  switch (surface) {
    case "bottomPanel":
      return "bottomPanel";
    case "mainTab":
      return "mainTab";
    default:
      return "splitRight";
  }
}

function normalizeWorktreeSetupSurface(value: unknown): DesktopWorktreeSetupSurface {
  return value === "bottomPanel" || value === "mainTab" ? value : "sidebar";
}

export type PersistedDesktopTabDescriptor =
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
      cwd?: string;
    }
  | {
      /**
       * Legacy: the task review panel is gone. Still parsed so old layouts
       * load; restore turns these tabs into a files tab in its changes view.
       */
      kind: "review";
      selectedVersionId?: string;
    }
  | {
      kind: "trajectory";
    }
  | {
      kind: "files";
      rootPath: string;
      /** Sidebar subview at capture time; "changes" restores in review mode. */
      viewMode?: "tree" | "changes";
    }
  | {
      kind: "github";
      worktreePath: string;
    }
  | {
      /**
       * Legacy: the standalone Changes panel is gone. Still parsed so old
       * layouts load; restore turns these into a files tab in changes view.
       */
      kind: "changes";
      worktreePath: string;
    }
  | {
      kind: "file";
      path: string;
      cwd?: string;
      line?: number;
      column?: number;
    }
  | {
      /**
       * The singleton Review Diff tab. Only the worktree is captured: the
       * diff itself is a live helper session re-opened on restore, and a
       * stale relativePath would yank the restored view to whichever file
       * happened to be targeted when the layout was saved.
       */
      kind: "diff";
      worktreePath: string;
    };

export interface PersistedDesktopLayout {
  version: 1;
  surfaces: Record<DesktopSplitSurface, SerializedSplitsState>;
  descriptors: Record<TabID, PersistedDesktopTabDescriptor>;
  rightSidebarVisible: boolean;
  bottomPanelVisible: boolean;
  activeSurface?: DesktopSplitSurface;
}

interface PersistedDesktopLayoutStore {
  version: 1;
  conversations: Record<string, PersistedDesktopLayout>;
  defaultLayout?: PersistedDesktopLayout;
  applyDefaultLayoutToChats: boolean;
}

export interface CaptureDesktopLayoutOptions {
  rightSidebarVisible: boolean;
  bottomPanelVisible: boolean;
  activeSurface?: DesktopSplitSurface;
  /** Looks up a live terminal's current working directory at capture time. */
  terminalCwd?: (terminalId: string) => string | undefined;
  /**
   * Capture terminals as shape only — no worktree path or cwd. Used for the
   * shared *default* layout, which is a template reused across conversations:
   * a persisted path would belong to whichever worktree it was saved in, so
   * terminals must rebase to the restoring conversation's own worktree.
   */
  shapeOnlyTerminals?: boolean;
  /** Omit tabs whose contents only make sense for this specific conversation. */
  excludeConversationSpecificTabs?: boolean;
}

export function captureDesktopSplitsLayout(
  entry: DesktopSplitsEntry,
  options: CaptureDesktopLayoutOptions,
): PersistedDesktopLayout | undefined {
  const excludedTabIds = excludedDesktopLayoutTabIds(entry, options);
  const surfaces: PersistedDesktopLayout["surfaces"] = {
    main: sanitizeSerializedSplitsState(entry.mainController.serializeState(), excludedTabIds),
    rightSidebar: sanitizeSerializedSplitsState(
      entry.rightSidebarController.serializeState(),
      excludedTabIds,
    ),
    bottomPanel: sanitizeSerializedSplitsState(
      entry.bottomPanelController.serializeState(),
      excludedTabIds,
    ),
  };
  const tabIds = new Set<TabID>();
  for (const surface of Object.values(surfaces)) {
    for (const tabId of tabIdsForSplitNode(surface.rootNode)) {
      tabIds.add(tabId);
    }
  }

  const descriptors: Record<TabID, PersistedDesktopTabDescriptor> = {};
  for (const tabId of tabIds) {
    const descriptor = persistedDescriptorForDesktopTab(entry.descriptors[tabId], options);
    if (!descriptor) {
      return undefined;
    }
    descriptors[tabId] = descriptor;
  }

  return {
    version: DESKTOP_LAYOUT_VERSION,
    surfaces,
    descriptors,
    rightSidebarVisible: options.rightSidebarVisible,
    bottomPanelVisible: options.bottomPanelVisible,
    activeSurface: options.activeSurface,
  };
}

function excludedDesktopLayoutTabIds(
  entry: DesktopSplitsEntry,
  options: CaptureDesktopLayoutOptions,
): Set<TabID> {
  const excluded = new Set<TabID>();
  for (const [tabId, descriptor] of Object.entries(entry.descriptors)) {
    // File tabs are transient views, not layout structure. (Diff tabs are
    // persisted: the diff view re-opens its helper session on restore.)
    if (
      descriptor.kind === "file" ||
      (descriptor.kind === "subagent-chat" &&
        !subagentKeyProvidesTranscript(descriptor.subagentKey)) ||
      (options.excludeConversationSpecificTabs && descriptor.kind === "subagent-chat")
    ) {
      excluded.add(tabId);
    }
  }
  return excluded;
}

function sanitizeSerializedSplitsState(
  snapshot: SerializedSplitsState,
  excludedTabIds: Set<TabID>,
): SerializedSplitsState {
  if (excludedTabIds.size === 0) {
    return snapshot;
  }

  return {
    ...snapshot,
    rootNode: removeTabsFromSplitNode(snapshot.rootNode, excludedTabIds),
  };
}

function removeTabsFromSplitNode(node: SplitNode, excludedTabIds: Set<TabID>): SplitNode {
  if (node.type === "pane") {
    const tabs = node.pane.tabs.filter((tab) => !excludedTabIds.has(tab.id));
    const selectedTabId = tabs.some((tab) => tab.id === node.pane.selectedTabId)
      ? node.pane.selectedTabId
      : tabs[0]?.id;

    return {
      type: "pane",
      pane: {
        ...node.pane,
        tabs,
        selectedTabId,
      },
    };
  }

  return {
    type: "split",
    split: {
      ...node.split,
      first: removeTabsFromSplitNode(node.split.first, excludedTabIds),
      second: removeTabsFromSplitNode(node.split.second, excludedTabIds),
    },
  };
}

export function readStoredDesktopLayout(key: string): PersistedDesktopLayout | undefined {
  return readDesktopLayoutStore().conversations[stableDesktopSplitsKey(key)];
}

export function writeStoredDesktopLayout(key: string, layout: PersistedDesktopLayout): void {
  const store = readDesktopLayoutStore();
  const stableKey = stableDesktopSplitsKey(key);
  delete store.conversations[stableKey];
  store.conversations[stableKey] = layout;
  pruneStoredConversationLayouts(store);
  writeDesktopLayoutStore(store);
}

export function renameStoredDesktopLayout(fromKey: string, toKey: string): void {
  const from = stableDesktopSplitsKey(fromKey);
  const to = stableDesktopSplitsKey(toKey);
  if (from === to) return;

  const store = readDesktopLayoutStore();
  const layout = store.conversations[from];
  if (!layout) return;

  delete store.conversations[from];
  delete store.conversations[to];
  store.conversations[to] = layout;
  pruneStoredConversationLayouts(store);
  writeDesktopLayoutStore(store);
}

export function readStoredDefaultDesktopLayout(): PersistedDesktopLayout | undefined {
  return readDesktopLayoutStore().defaultLayout;
}

export function readStoredApplyDefaultDesktopLayoutToChats(): boolean {
  return readDesktopLayoutStore().applyDefaultLayoutToChats;
}

export function writeStoredApplyDefaultDesktopLayoutToChats(applyToChats: boolean): void {
  const store = readDesktopLayoutStore();
  store.applyDefaultLayoutToChats = applyToChats;
  writeDesktopLayoutStore(store);
}

export function shouldApplyStoredDefaultDesktopLayout(isChat: boolean): boolean {
  return !isChat || readStoredApplyDefaultDesktopLayoutToChats();
}

export function writeStoredDefaultDesktopLayout(layout: PersistedDesktopLayout): void {
  const store = readDesktopLayoutStore();
  store.defaultLayout = layout;
  writeDesktopLayoutStore(store);
  dispatchDesktopDefaultLayoutChanged();
}

export function clearStoredDefaultDesktopLayout(): void {
  const store = readDesktopLayoutStore();
  if (store.defaultLayout === undefined) {
    return;
  }
  delete store.defaultLayout;
  writeDesktopLayoutStore(store);
  dispatchDesktopDefaultLayoutChanged();
}

export function isDesktopDefaultLayoutCandidate(
  key: string,
  pendingConversationId?: string | null,
): boolean {
  const stableKey = stableDesktopSplitsKey(key);
  if (stableKey.startsWith("new:")) return true;
  return (
    typeof pendingConversationId === "string" &&
    pendingConversationId.length > 0 &&
    stableKey === stableDesktopSplitsKey(pendingConversationId)
  );
}

/**
 * A persisted cwd is only meaningful inside the worktree the terminal is being
 * restored into; a stale path (e.g. a default layout captured in another
 * worktree) would silently open the shell somewhere unexpected.
 */
export function restorableTerminalCwd(
  cwd: string | undefined,
  worktreePath: string,
): string | undefined {
  if (!cwd || !worktreePath) return undefined;
  // Compare on a normalized form (Windows OSC7 emits forward-slash, drive-letter
  // casing can differ) but return the original cwd for the shell to spawn in.
  const normalizedCwd = normalizeComparablePath(cwd);
  const normalizedRoot = normalizeComparablePath(worktreePath);
  if (normalizedCwd === normalizedRoot) return undefined;
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedCwd.startsWith(prefix) ? cwd : undefined;
}

// Normalizes only what differs across host path conventions without touching
// case-sensitive POSIX segments: backslashes become forward slashes and a
// leading Windows drive letter is lowercased. A no-op for macOS/Linux paths.
function normalizeComparablePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^([a-zA-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
}

function persistedDescriptorForDesktopTab(
  descriptor: DesktopTabDescriptor | undefined,
  options: CaptureDesktopLayoutOptions,
): PersistedDesktopTabDescriptor | undefined {
  if (!descriptor) return undefined;

  switch (descriptor.kind) {
    case "chat":
      return { kind: "chat" };
    case "subagent-chat":
      return { ...descriptor };
    case "terminal":
      if (options.shapeOnlyTerminals) {
        return { kind: "terminal", worktreePath: "" };
      }
      return {
        kind: "terminal",
        worktreePath: descriptor.worktreePath,
        cwd: descriptor.terminalId ? options.terminalCwd?.(descriptor.terminalId) : undefined,
      };
    case "trajectory":
      return { kind: "trajectory" };
    case "files":
      return {
        kind: "files",
        rootPath: descriptor.rootPath,
        // The tree keeps its subview in per-worktree prefs; capture it so a
        // layout saved while reviewing changes restores in changes mode.
        viewMode: readDesktopFilesTreePrefs(descriptor.rootPath)?.viewMode,
      };
    case "github":
      return {
        kind: "github",
        worktreePath: descriptor.worktreePath,
      };
    case "file":
      return {
        kind: "file",
        path: descriptor.path,
        cwd: descriptor.cwd,
        line: descriptor.line,
        column: descriptor.column,
      };
    case "diff":
      // Worktree only: the diff content is a live helper session that the
      // panel re-opens on restore, and the last targeted file is a moment-
      // in-time detail that should not yank the restored view around. Like
      // terminals, the shared default layout captures shape only — its
      // worktree belongs to whichever conversation the template was saved
      // in, so restore anchors to the restoring conversation's own.
      return {
        kind: "diff",
        worktreePath: options.shapeOnlyTerminals ? "" : descriptor.worktreePath,
      };
  }
}

function tabIdsForSplitNode(node: SplitNode): TabID[] {
  if (node.type === "pane") {
    return node.pane.tabs.map((tab) => tab.id);
  }

  return [...tabIdsForSplitNode(node.split.first), ...tabIdsForSplitNode(node.split.second)];
}

function readDesktopLayoutStore(): PersistedDesktopLayoutStore {
  try {
    const value = globalThis.localStorage?.getItem(DESKTOP_LAYOUT_STORAGE_KEY);
    if (!value) return emptyDesktopLayoutStore();
    return normalizeDesktopLayoutStore(JSON.parse(value));
  } catch {
    return emptyDesktopLayoutStore();
  }
}

function writeDesktopLayoutStore(store: PersistedDesktopLayoutStore): void {
  globalThis.localStorage?.setItem(DESKTOP_LAYOUT_STORAGE_KEY, JSON.stringify(store));
}

function pruneStoredConversationLayouts(store: PersistedDesktopLayoutStore): void {
  const keys = Object.keys(store.conversations);
  const excessCount = keys.length - DESKTOP_LAYOUT_CONVERSATION_LIMIT;
  if (excessCount <= 0) return;

  for (const key of keys.slice(0, excessCount)) {
    delete store.conversations[key];
  }
}

function dispatchDesktopDefaultLayoutChanged(): void {
  if (typeof CustomEvent === "undefined") return;
  globalThis.dispatchEvent?.(new CustomEvent(DESKTOP_DEFAULT_LAYOUT_CHANGED_EVENT));
}

function normalizeDesktopLayoutStore(value: unknown): PersistedDesktopLayoutStore {
  if (!isRecord(value) || value.version !== DESKTOP_LAYOUT_STORE_VERSION) {
    return emptyDesktopLayoutStore();
  }

  const conversations: Record<string, PersistedDesktopLayout> = {};
  const rawConversations = isRecord(value.conversations) ? value.conversations : {};
  for (const [key, layout] of Object.entries(rawConversations)) {
    const normalized = normalizeDesktopLayout(layout);
    if (key && normalized) {
      conversations[key] = normalized;
    }
  }

  return {
    version: DESKTOP_LAYOUT_STORE_VERSION,
    conversations,
    defaultLayout: normalizeDesktopLayout(value.defaultLayout),
    applyDefaultLayoutToChats: value.applyDefaultLayoutToChats === true,
  };
}

function normalizeDesktopLayout(value: unknown): PersistedDesktopLayout | undefined {
  if (!isRecord(value) || value.version !== DESKTOP_LAYOUT_VERSION) {
    return undefined;
  }

  const surfaces = isRecord(value.surfaces) ? value.surfaces : undefined;
  const main = normalizeSerializedSplitsState(surfaces?.main);
  const rightSidebar = normalizeSerializedSplitsState(surfaces?.rightSidebar);
  const bottomPanel = normalizeSerializedSplitsState(surfaces?.bottomPanel);
  const descriptors = normalizePersistedDescriptors(value.descriptors);
  if (!main || !rightSidebar || !bottomPanel || !descriptors) {
    return undefined;
  }

  const unsupportedSubagentTabIds = new Set(
    Object.entries(descriptors)
      .filter(
        ([, descriptor]) =>
          descriptor.kind === "subagent-chat" &&
          !subagentKeyProvidesTranscript(descriptor.subagentKey),
      )
      .map(([tabId]) => tabId),
  );
  const supportedDescriptors = Object.fromEntries(
    Object.entries(descriptors).filter(([tabId]) => !unsupportedSubagentTabIds.has(tabId)),
  );
  const activeSurface = normalizeDesktopSplitSurface(value.activeSurface);
  return {
    version: DESKTOP_LAYOUT_VERSION,
    surfaces: {
      main: sanitizeSerializedSplitsState(main, unsupportedSubagentTabIds),
      rightSidebar: sanitizeSerializedSplitsState(rightSidebar, unsupportedSubagentTabIds),
      bottomPanel: sanitizeSerializedSplitsState(bottomPanel, unsupportedSubagentTabIds),
    },
    descriptors: supportedDescriptors,
    rightSidebarVisible: value.rightSidebarVisible === true,
    bottomPanelVisible: value.bottomPanelVisible === true,
    activeSurface,
  };
}

function normalizeSerializedSplitsState(value: unknown): SerializedSplitsState | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.rootNode)) {
    return undefined;
  }

  return value as unknown as SerializedSplitsState;
}

function normalizePersistedDescriptors(
  value: unknown,
): Record<TabID, PersistedDesktopTabDescriptor> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const descriptors: Record<TabID, PersistedDesktopTabDescriptor> = {};
  for (const [tabId, descriptor] of Object.entries(value)) {
    const normalized = normalizePersistedDescriptor(descriptor);
    if (!tabId || !normalized) {
      return undefined;
    }
    descriptors[tabId] = normalized;
  }
  return descriptors;
}

function normalizePersistedDescriptor(value: unknown): PersistedDesktopTabDescriptor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  switch (value.kind) {
    case "chat":
      return { kind: "chat" };
    case "subagent-chat":
      if (
        typeof value.conversationId !== "string" ||
        typeof value.subagentKey !== "string" ||
        typeof value.title !== "string"
      ) {
        return undefined;
      }
      return {
        kind: "subagent-chat",
        conversationId: value.conversationId,
        subagentKey: value.subagentKey,
        title: value.title,
      };
    case "terminal":
      if (typeof value.worktreePath !== "string") return undefined;
      if (value.cwd !== undefined && typeof value.cwd !== "string") return undefined;
      return { kind: "terminal", worktreePath: value.worktreePath, cwd: value.cwd };
    case "review":
      return value.selectedVersionId === undefined || typeof value.selectedVersionId === "string"
        ? { kind: "review", selectedVersionId: value.selectedVersionId }
        : undefined;
    case "trajectory":
      return { kind: "trajectory" };
    case "files":
      if (typeof value.rootPath !== "string") return undefined;
      return {
        kind: "files",
        rootPath: value.rootPath,
        viewMode:
          value.viewMode === "changes" || value.viewMode === "tree" ? value.viewMode : undefined,
      };
    case "github":
      return typeof value.worktreePath === "string"
        ? { kind: "github", worktreePath: value.worktreePath }
        : undefined;
    case "changes":
      return typeof value.worktreePath === "string"
        ? { kind: "changes", worktreePath: value.worktreePath }
        : undefined;
    case "file":
      if (typeof value.path !== "string") return undefined;
      if (value.cwd !== undefined && typeof value.cwd !== "string") return undefined;
      if (value.line !== undefined && typeof value.line !== "number") return undefined;
      if (value.column !== undefined && typeof value.column !== "number") return undefined;
      return {
        kind: "file",
        path: value.path,
        cwd: value.cwd,
        line: value.line,
        column: value.column,
      };
    case "diff":
      return typeof value.worktreePath === "string"
        ? { kind: "diff", worktreePath: value.worktreePath }
        : undefined;
    default:
      return undefined;
  }
}

function normalizeDesktopSplitSurface(value: unknown): DesktopSplitSurface | undefined {
  return value === "main" || value === "rightSidebar" || value === "bottomPanel"
    ? value
    : undefined;
}

function emptyDesktopLayoutStore(): PersistedDesktopLayoutStore {
  return {
    version: DESKTOP_LAYOUT_STORE_VERSION,
    conversations: {},
    applyDefaultLayoutToChats: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
