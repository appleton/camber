/**
 * Durable per-worktree preferences for the desktop files sidebar: which
 * subview is showing (tree or changes) and which directories are expanded.
 *
 * The in-memory tree cache (DesktopFilesTree's module cache) is keyed per
 * tab and disposed after ~30 s, so it does not survive conversation
 * switches. These prefs are keyed by rootPath in localStorage so returning
 * to a worktree restores the same view.
 */

export type DesktopFilesTreePrefsViewMode = "tree" | "changes";

export interface DesktopFilesTreePrefs {
  viewMode: DesktopFilesTreePrefsViewMode;
  expandedDirectoryPaths: string[];
}

const STORAGE_KEY = "camber.desktop.filesTreePrefs.v1";
const MAX_WORKTREES = 30;
const MAX_EXPANDED_PATHS = 500;

interface PrefsStore {
  version: 1;
  worktrees: Record<string, DesktopFilesTreePrefs>;
}

export function readDesktopFilesTreePrefs(rootPath: string): DesktopFilesTreePrefs | undefined {
  if (!rootPath) return undefined;
  return readStore().worktrees[rootPath];
}

export function writeDesktopFilesTreePrefs(rootPath: string, prefs: DesktopFilesTreePrefs): void {
  if (!rootPath) return;
  const store = readStore();
  // Re-insert to keep insertion order as LRU order.
  delete store.worktrees[rootPath];
  store.worktrees[rootPath] = {
    viewMode: prefs.viewMode,
    expandedDirectoryPaths: prefs.expandedDirectoryPaths.slice(0, MAX_EXPANDED_PATHS),
  };
  const keys = Object.keys(store.worktrees);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_WORKTREES))) {
    delete store.worktrees[key];
  }
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota/serialization failures only lose a preference; ignore.
  }
}

function readStore(): PrefsStore {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    return normalizeStore(JSON.parse(raw));
  } catch {
    return emptyStore();
  }
}

function normalizeStore(value: unknown): PrefsStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyStore();
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return emptyStore();

  const worktrees: Record<string, DesktopFilesTreePrefs> = {};
  const rawWorktrees = record.worktrees;
  if (typeof rawWorktrees === "object" && rawWorktrees !== null && !Array.isArray(rawWorktrees)) {
    for (const [key, prefs] of Object.entries(rawWorktrees)) {
      const normalized = normalizePrefs(prefs);
      if (key && normalized) worktrees[key] = normalized;
    }
  }
  return { version: 1, worktrees };
}

function normalizePrefs(value: unknown): DesktopFilesTreePrefs | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const viewMode = record.viewMode === "changes" ? "changes" : "tree";
  const expandedDirectoryPaths = Array.isArray(record.expandedDirectoryPaths)
    ? record.expandedDirectoryPaths.filter((path): path is string => typeof path === "string")
    : [];
  return { viewMode, expandedDirectoryPaths };
}

function emptyStore(): PrefsStore {
  return { version: 1, worktrees: {} };
}
