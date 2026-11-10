<script lang="ts" module>
  import type {
    FileTree as CachedFileTree,
    FileTreeIconConfig as CachedFileTreeIconConfig,
    GitStatusEntry as CachedGitStatusEntry,
  } from "@pierre/trees";

  interface DesktopFileTree {
    rootPath: string;
    entries: DesktopFileTreeEntry[];
    deferredDirectories: string[];
    gitStatus: CachedGitStatusEntry[];
  }

  interface DesktopFileTreeEntry {
    path: string;
    relativePath: string;
    kind: "directory" | "file";
    gitIgnored: boolean;
  }

  interface DesktopFileTreeChangedPayload {
    changes: DesktopFileTreeChange[];
  }

  interface DesktopFileTreeChange {
    path: string;
    type: number;
    kind?: DesktopFileTreeEntry["kind"];
  }

  /** Sidebar view: file tree or the git changes list + commit zone. */
  type DesktopFilesTreeViewMode = "tree" | "changes";

  interface CachedDesktopFileTreeState {
    rootPath: string;
    showGitIgnored: boolean;
    showChangedOnly: boolean;
    viewMode: DesktopFilesTreeViewMode;
    loadState: "idle" | "loading" | "ready" | "error";
    errorMessage: string | null;
    fileTree: DesktopFileTree | null;
    latestFileTree: DesktopFileTree | null;
    latestFileIconConfig: CachedFileTreeIconConfig | undefined;
    latestFileIconConfigSignature: string;
    entriesByRelativePath: Map<string, DesktopFileTreeEntry>;
    deferredDirectoryPaths: Set<string>;
    loadingDirectoryPaths: Set<string>;
    expandedDirectoryPaths: Set<string>;
    fileTreeModel: CachedFileTree | undefined;
    iconConfigVersion: number;
    disposeTimer: ReturnType<typeof setTimeout> | undefined;
  }

  const DESKTOP_FILE_TREE_CACHE_DISPOSE_MS = 30_000;
  const DESKTOP_FILE_TREE_CACHE_MAX_SIZE = 20;
  const desktopFileTreeStateCache = new Map<string, CachedDesktopFileTreeState>();

  function takeCachedDesktopFileTreeState(
    cacheKey: string | undefined,
    rootPath: string,
  ): CachedDesktopFileTreeState | undefined {
    if (!cacheKey) return undefined;

    const cached = desktopFileTreeStateCache.get(cacheKey);
    if (!cached) return undefined;

    if (cached.rootPath !== rootPath) {
      desktopFileTreeStateCache.delete(cacheKey);
      disposeCachedDesktopFileTreeState(cached);
      return undefined;
    }

    if (cached.disposeTimer) {
      clearTimeout(cached.disposeTimer);
      cached.disposeTimer = undefined;
    }
    desktopFileTreeStateCache.delete(cacheKey);
    return cached;
  }

  function storeCachedDesktopFileTreeState(
    cacheKey: string | undefined,
    state: CachedDesktopFileTreeState,
  ) {
    if (!cacheKey) {
      disposeCachedDesktopFileTreeState(state);
      return;
    }

    const existing = desktopFileTreeStateCache.get(cacheKey);
    if (existing && existing !== state) {
      disposeCachedDesktopFileTreeState(existing);
    }
    desktopFileTreeStateCache.set(cacheKey, state);

    while (desktopFileTreeStateCache.size > DESKTOP_FILE_TREE_CACHE_MAX_SIZE) {
      const oldestKey = desktopFileTreeStateCache.keys().next().value;
      if (!oldestKey) break;
      const oldest = desktopFileTreeStateCache.get(oldestKey);
      desktopFileTreeStateCache.delete(oldestKey);
      if (oldest) {
        disposeCachedDesktopFileTreeState(oldest);
      }
    }
  }

  function scheduleCachedDesktopFileTreeDisposal(cacheKey: string | undefined) {
    if (!cacheKey) return;

    const cached = desktopFileTreeStateCache.get(cacheKey);
    if (!cached) return;

    if (cached.disposeTimer) {
      clearTimeout(cached.disposeTimer);
    }
    cached.disposeTimer = setTimeout(() => {
      if (desktopFileTreeStateCache.get(cacheKey) !== cached) return;

      desktopFileTreeStateCache.delete(cacheKey);
      disposeCachedDesktopFileTreeState(cached);
    }, DESKTOP_FILE_TREE_CACHE_DISPOSE_MS);
  }

  function disposeCachedDesktopFileTreeState(state: CachedDesktopFileTreeState) {
    if (state.disposeTimer) {
      clearTimeout(state.disposeTimer);
      state.disposeTimer = undefined;
    }
    state.fileTreeModel?.cleanUp();
    state.fileTreeModel = undefined;
  }
</script>

<script lang="ts">
  import {
    FileTree,
    type FileTreeBatchOperation,
    type FileTreeIconConfig,
    type RemappedIcon,
  } from "@pierre/trees";
  import { getLanguages, getThemeContext, type FileIconTheme } from "@camber/components/providers";
  import { isAppleUser } from "@camber/components";
  import { onMount, tick, untrack } from "svelte";
  import { getUnknownErrorMessage } from "@camber/lib/errors";
  import { basename, dirname, normalize, relative } from "@camber/lib/path";
  import { InfoMessageType } from "@camber/rpc";
  import { appState } from "../../hostAdapter";
  import { rpc, type RPCClient } from "../../hostRpc";
  import {
    performDesktopFilesTreeAction,
    type DesktopFileTreeContextMenuActionPayload,
    type DesktopFilesTreeActionRPC,
  } from "./desktopFilesTreeActions";
  import type {
    DesktopFileTreeContextMenuOpener,
    DesktopFileTreeContextMenuRequest,
  } from "./desktopFilesTreeContextMenu";
  import { requestDesktopFilePromptChip } from "./desktopFilePromptChip";
  import {
    DESKTOP_OPEN_CHANGES_EVENT,
    DESKTOP_OPEN_CHANGES_VIEW_EVENT,
  } from "./desktopCommandPicker";
  import { requestDesktopChangesFileSelection } from "./desktopChangesFileSelection";
  import {
    changesViewRequestMatches,
    requestDesktopChangesView,
    takePendingDesktopChangesViewRequest,
    type DesktopOpenChangesViewEventDetail,
  } from "./desktopChangesViewRequest";
  import { readDesktopFilesTreePrefs, writeDesktopFilesTreePrefs } from "./desktopFilesTreePrefs";
  import { visibleChangedTreePaths } from "./desktopFilesTreeChangedFilter";
  import DesktopChangesList from "./DesktopChangesList.svelte";
  import type { GitStatusOutput } from "@camber/helperapi";
  import {
    DESKTOP_FILE_TREE_CHANGED_EVENT,
    DESKTOP_GIT_CHANGED_EVENT,
    DesktopGitChangesState,
  } from "../../features/DesktopGitChangesState.svelte";
  import SegmentedSwitch from "../ui/SegmentedSwitch.svelte";

  interface DesktopSettings {
    fileOpenerId: string;
    fileOpeners: DesktopFileOpener[];
    desktopOpeners: DesktopFileOpener[];
  }

  interface DesktopFileOpener {
    id: string;
    label: string;
    kind: "inApp" | "default" | "editorEnv" | "application" | "terminal";
    appPath?: string;
    bundleId?: string;
    iconDataUri?: string;
  }

  type DesktopFilesRPC = RPCClient & {
    getDesktopSettings(): Promise<DesktopSettings>;
    listDirectoryTree(path: string, includeGitIgnored?: boolean): Promise<DesktopFileTree>;
    listDirectorySubtree(
      rootPath: string,
      relativePath: string,
      includeGitIgnored?: boolean,
    ): Promise<DesktopFileTree>;
    openPathWithOpener(
      path: string,
      openerId: string,
      line?: number,
      column?: number,
    ): Promise<void>;
    showDesktopFileTreeContextMenu(request: DesktopFileTreeContextMenuRequest): Promise<void>;
    revealPathInFinder(path: string): Promise<void>;
    writeFileUrlToPasteboard(path: string, operation: "copy" | "cut"): Promise<void>;
    pasteFilesIntoDirectory(destination: string): Promise<unknown>;
    trashPath(path: string): Promise<void>;
  } & DesktopFilesTreeActionRPC;

  interface Props {
    rootPath: string;
    cacheKey?: string;
    openTerminal: (cwd: string) => void | Promise<void>;
    active: boolean;
  }

  let { rootPath, cacheKey, openTerminal, active }: Props = $props();

  const desktopRpc = rpc as DesktopFilesRPC;
  const languages = getLanguages();
  const theme = getThemeContext();
  const DESKTOP_SETTINGS_CHANGED_EVENT = "camber:desktop-settings-changed";
  const DESKTOP_OPEN_FILE_TAB_EVENT = "camber:desktop-open-file-tab";
  const DESKTOP_FILE_TREE_CONTEXT_MENU_ACTION_EVENT =
    "camber:desktop-file-tree-context-menu-action";
  const FILE_CHANGE_CREATED = 1;
  const FILE_CHANGE_CHANGED = 2;
  const FILE_CHANGE_DELETED = 3;
  // Coalesces filtered-model rebuilds across watcher payload bursts (the host
  // flushes every ~150 ms, so 200 ms folds consecutive flushes together).
  const FILTERED_MODEL_REFRESH_DELAY_MS = 200;
  type DesktopFileTreeGitStatusEntry = DesktopFileTree["gitStatus"][number];
  type DesktopFileTreeGitStatus = DesktopFileTreeGitStatusEntry["status"];
  // Git statuses that count as "changed" for row colouring, the changed-file
  // count badge, and the changed-only filter ("ignored" is excluded on
  // purpose — gitignored entries are dimmed, not highlighted).
  const CHANGED_GIT_STATUSES: ReadonlySet<DesktopFileTreeGitStatus> =
    new Set<DesktopFileTreeGitStatus>(["added", "deleted", "modified", "renamed", "untracked"]);
  const treeUnsafeCss = `
    :host {
      --trees-bg-override: transparent;
      /* Row hover: same token as the sidebar and changes-list hover states. */
      --trees-bg-muted-override: var(--psx-menu-hover-background);
      --trees-git-added-color-override: var(--psx-diff-insert-foreground, #4fb262);
      --trees-git-untracked-color-override: var(--psx-diff-insert-foreground, #4fb262);
      --trees-git-modified-color-override: var(--psx-info-foreground, #1a85ff);
      --trees-git-renamed-color-override: var(--psx-foreground-secondary);
      --trees-git-deleted-color-override: var(--psx-error-foreground, #e5534b);
      --trees-git-ignored-color-override: var(--psx-foreground-tertiary);
      --trees-fg-override: var(--psx-foreground-primary);
      --trees-fg-muted-override: var(--psx-foreground-secondary);
      --trees-border-color-override: var(--psx-border);
      --trees-selected-bg-override: var(--psx-menu-hover-background);
      --trees-selected-fg-override: var(--psx-foreground-primary);
      --trees-focus-ring-color-override: var(--psx-focus);
      --trees-font-family-override: inherit;
      --trees-font-size-override: 12px;
      --trees-row-height: 26px;
      --trees-icon-width-override: 16px;
      --trees-item-margin-x-override: 4px;
      --trees-padding-inline-override: 4px;
    }

    [data-item-section='icon'] {
      position: relative;
      display: inline-flex;
      width: 16px;
      height: 16px;
      align-items: center;
      justify-content: center;
      color: var(--trees-fg-muted);
    }

    [data-item-section='icon'] > svg {
      display: block;
      width: 16px;
      height: 16px;
    }

    /* Status letters get the same rounded tint badge as the diff panel and
       the changes list. The :has(svg) guards leave the directory
       contains-changes dot untouched (it renders an icon, not a letter). */
    [data-item-section='git']:has(> span:not(:has(svg))) {
      width: auto;
      opacity: 1;
    }

    [data-item-section='git'] > span:not(:has(svg)) {
      width: auto;
      padding: 3px 6px;
      border-radius: 5px;
      font-size: 10px;
      font-weight: 600;
      line-height: normal;
      background: color-mix(in srgb, currentColor 12%, transparent);
    }

    [data-camber-loading='true'] > [data-item-section='icon']::after {
      position: absolute;
      inset: 4px;
      border: 1px solid currentColor;
      border-right-color: transparent;
      border-radius: 999px;
      content: "";
      opacity: 0.7;
      animation: camber-file-tree-spin 0.7s linear infinite;
    }

    [data-camber-loading='true'] > [data-item-section='icon'] > svg {
      opacity: 0.25;
    }

    @keyframes camber-file-tree-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;

  let mountElement = $state<HTMLDivElement>();
  let loadState = $state<"idle" | "loading" | "ready" | "error">("idle");
  let errorMessage = $state<string | null>(null);
  let fileTree = $state<DesktopFileTree | null>(null);
  let showGitIgnored = $state(false);
  let showChangedOnly = $state(false);
  let viewMode = $state<DesktopFilesTreeViewMode>("tree");
  let desktopFileOpenerId = $state(
    typeof $appState.environment.desktopFileOpenerId === "string"
      ? $appState.environment.desktopFileOpenerId
      : "default",
  );
  let desktopFileContextMenuOpeners = $state<DesktopFileTreeContextMenuOpener[]>([]);
  let desktopContextMenuOpeners = $state<DesktopFileTreeContextMenuOpener[]>([]);
  let loadVersion = 0;
  let iconConfigVersion = 0;
  let expandedDirectoryPaths = $state(new Set<string>());
  let deferredDirectoryPaths = new Set<string>();
  let loadingDirectoryPaths = new Set<string>();
  let fileTreeModel: FileTree | undefined;
  let fileTreeModelMount: HTMLElement | undefined;
  let removeFileTreeEventListeners: (() => void) | undefined;
  let latestFileTree: DesktopFileTree | null = null;
  let latestFileIconConfig: FileTreeIconConfig | undefined = undefined;
  let latestFileIconConfigSignature = "";
  let latestFileIconTheme: FileIconTheme | undefined;
  let entriesByRelativePath = new Map<string, DesktopFileTreeEntry>();
  const pendingContextMenuEntries = new Map<string, DesktopFileTreeEntry>();
  const cachedState = takeCachedDesktopFileTreeState(cacheKey, rootPath);
  // Durable per-worktree prefs (subview + expanded folders): survive
  // conversation switches, unlike the short-lived in-memory tab cache.
  const storedPrefs = readDesktopFilesTreePrefs(rootPath);
  if (storedPrefs) {
    viewMode = storedPrefs.viewMode;
    expandedDirectoryPaths = new Set(storedPrefs.expandedDirectoryPaths);
  }

  if (cachedState) {
    loadState = cachedState.loadState;
    errorMessage = cachedState.errorMessage;
    fileTree = cachedState.fileTree;
    // The floating controls overlay was removed (no UI room): the gitignore
    // toggle and changed-only filter have no buttons anymore, so never
    // restore either as stuck-on from a cached tab state. The underlying
    // plumbing is kept for when the features return.
    showGitIgnored = false;
    showChangedOnly = false;
    viewMode = cachedState.viewMode;
    latestFileTree = cachedState.latestFileTree;
    latestFileIconConfig = cachedState.latestFileIconConfig;
    latestFileIconConfigSignature = cachedState.latestFileIconConfigSignature;
    entriesByRelativePath = new Map(cachedState.entriesByRelativePath);
    deferredDirectoryPaths = new Set(cachedState.deferredDirectoryPaths);
    loadingDirectoryPaths = new Set(cachedState.loadingDirectoryPaths);
    expandedDirectoryPaths = new Set(cachedState.expandedDirectoryPaths);
    fileTreeModel = cachedState.fileTreeModel;
    iconConfigVersion = cachedState.iconConfigVersion;
  }

  // A pending "Stage and Commit..." request (the tab may have been created just
  // for it) opens straight into the changes view, overriding cached state.
  const changesViewRequestedOnMount = takePendingDesktopChangesViewRequest(rootPath);
  if (changesViewRequestedOnMount) {
    viewMode = "changes";
  }

  let loadedRootPath = cachedState?.latestFileTree ? cachedState.rootPath : undefined;
  let loadedShowGitIgnored = cachedState?.latestFileTree ? cachedState.showGitIgnored : undefined;

  let canLoad = $derived(rootPath.length > 0);
  // Drives the sliding view strip: All files sits on the left, Changes on the
  // right, and the active pane translates into place in time with the mode
  // switch thumb.
  let changesViewActive = $derived(viewMode === "changes" && canLoad);
  let changesViewElement = $state<HTMLElement>();
  let commitMessageFocusToken = 0;
  let commitMessageFocusRequest = $state(0);
  // Capture the initial state so persisted Changes views do not steal focus
  // merely because a layout or conversation was restored.
  // svelte-ignore state_referenced_locally
  let commitMessageFocusContextActive = changesViewActive && active;

  async function focusCommitMessageAfterViewOpens(): Promise<void> {
    const token = ++commitMessageFocusToken;
    await tick();
    const view = changesViewElement;
    if (!view) return;

    // The files/changes panes use a sequential cross-fade. Wait for the
    // incoming pane to become fully visible before focusing its textarea.
    await Promise.allSettled((view.getAnimations?.() ?? []).map((animation) => animation.finished));
    if (token !== commitMessageFocusToken || !changesViewActive || !active) return;

    commitMessageFocusRequest += 1;
  }

  $effect(() => {
    const nextFocusContextActive = changesViewActive && active;
    if (nextFocusContextActive && !commitMessageFocusContextActive) {
      void focusCommitMessageAfterViewOpens();
    }
    commitMessageFocusContextActive = nextFocusContextActive;
  });

  onMount(() => {
    if (changesViewRequestedOnMount && active) {
      void focusCommitMessageAfterViewOpens();
    }
  });
  // Includes directory records (git reports a wholly-untracked directory as
  // one "dir/" entry), so the filter's empty state only shows when the
  // filtered tree is truly empty.
  let hasChangedStatuses = $derived(
    fileTree ? fileTree.gitStatus.some((entry) => CHANGED_GIT_STATUSES.has(entry.status)) : false,
  );
  // Authoritative git status for this worktree. The watcher-driven upserts in
  // applyFileTreeChanges are optimistic guesses (created → untracked,
  // changed → modified) that ignore .gitignore and content-identical writes,
  // so they drift upward during build/agent bursts. This tracker reconciles
  // the tree's gitStatus (and the counts) with real `git status` output,
  // debounced and token-guarded (no polling).
  const gitChanges = new DesktopGitChangesState();
  onMount(() => () => gitChanges.dispose());
  $effect(() => {
    gitChanges.setWorktreePath(canLoad ? rootPath : undefined);
  });
  $effect(() => {
    const git = gitChanges.status;
    if (!git) return;
    untrack(() => reconcileGitStatus(git));
  });
  $effect(() => {
    // In-app git mutations (stage/commit/discard in the changes list or
    // Changes panel) invalidate both the optimistic statuses and the count.
    const onGitChanged = () => gitChanges.refreshNow();
    window.addEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
    return () => window.removeEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
  });

  const MODE_OPTIONS: { value: DesktopFilesTreeViewMode; label: string }[] = [
    { value: "tree", label: "All files" },
    { value: "changes", label: "Changes" },
  ];

  $effect(() => {
    // Persist the subview and expanded folders per worktree so switching
    // conversations and coming back restores the same view.
    const currentViewMode = viewMode;
    const currentExpanded = expandedDirectoryPaths;
    if (!canLoad) return;
    writeDesktopFilesTreePrefs(rootPath, {
      viewMode: currentViewMode,
      expandedDirectoryPaths: Array.from(currentExpanded),
    });
  });

  onMount(() => {
    void desktopRpc
      .getDesktopSettings()
      .then(applyDesktopSettings)
      .catch((error) => console.debug("Unable to load desktop settings", error));

    const onSettingsChanged = (event: Event) => {
      applyDesktopSettings((event as CustomEvent<DesktopSettings>).detail);
    };
    const onContextMenuAction = (event: Event) => {
      const payload = (event as CustomEvent<DesktopFileTreeContextMenuActionPayload>).detail;
      const entry = pendingContextMenuEntries.get(payload.requestId);
      pendingContextMenuEntries.delete(payload.requestId);
      if (!entry) return;

      void performDesktopFilesTreeAction({
        payload,
        entry,
        currentFileOpenerId: desktopFileOpenerId,
        rpc: desktopRpc,
        openTerminal,
        insertFileChip: requestDesktopFilePromptChip,
        viewDiff: openDiffForFile,
      });
    };
    const onFileTreeChanged = (event: Event) => {
      const payload = (event as CustomEvent<DesktopFileTreeChangedPayload>).detail;
      if (!fileTreeChangeAffectsRoot(payload, rootPath)) return;

      if (!applyFileTreeChanges(payload)) {
        void reloadTree();
      }
      // Reconcile the optimistic watcher-derived statuses with real git
      // status once the burst settles (debounced inside the tracker).
      gitChanges.scheduleRefresh();
    };
    const onOpenChangesView = (event: Event) => {
      const detail = (event as CustomEvent<DesktopOpenChangesViewEventDetail>).detail;
      // Requests scoped to another worktree are not for this tree.
      if (!changesViewRequestMatches(detail?.worktreePath, rootPath)) return;
      takePendingDesktopChangesViewRequest(rootPath);
      const changesViewWasAlreadyActive = viewMode === "changes";
      viewMode = "changes";
      if (changesViewWasAlreadyActive && active) {
        void focusCommitMessageAfterViewOpens();
      }
    };
    window.addEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    window.addEventListener(DESKTOP_FILE_TREE_CONTEXT_MENU_ACTION_EVENT, onContextMenuAction);
    window.addEventListener(DESKTOP_FILE_TREE_CHANGED_EVENT, onFileTreeChanged);
    window.addEventListener(DESKTOP_OPEN_CHANGES_VIEW_EVENT, onOpenChangesView);
    return () => {
      window.removeEventListener(DESKTOP_SETTINGS_CHANGED_EVENT, onSettingsChanged);
      window.removeEventListener(DESKTOP_FILE_TREE_CONTEXT_MENU_ACTION_EVENT, onContextMenuAction);
      window.removeEventListener(DESKTOP_FILE_TREE_CHANGED_EVENT, onFileTreeChanged);
      window.removeEventListener(DESKTOP_OPEN_CHANGES_VIEW_EVENT, onOpenChangesView);
      cancelFilteredModelRefresh();
    };
  });

  $effect(() => {
    const nextRootPath = rootPath;
    const nextShowGitIgnored = showGitIgnored;

    untrack(() => {
      if (
        latestFileTree &&
        latestFileTree.rootPath === nextRootPath &&
        loadedRootPath === nextRootPath &&
        loadedShowGitIgnored === nextShowGitIgnored
      ) {
        return;
      }

      // The very first load keeps the expansion restored from the durable
      // per-worktree prefs (hydrated + pruned against the fetched tree);
      // resetting is only right when re-rooting or toggling gitignored
      // content, where the old expansion no longer applies.
      const isFirstLoad = loadedRootPath === undefined && !latestFileTree;
      loadedRootPath = nextRootPath;
      loadedShowGitIgnored = nextShowGitIgnored;
      void reloadTree({
        includeGitIgnored: nextShowGitIgnored,
        path: nextRootPath,
        resetExpansion: !isFirstLoad,
      });
    });
  });

  $effect(() => {
    const mount = mountElement;
    if (!mount) return;

    untrack(() => renderFileTreeModel(mount));
    return () => {
      cacheFileTreeState();
    };
  });

  $effect(() => {
    const tree = fileTree;
    theme.fileIconTheme;
    refreshFileTreeIcons(tree?.entries ?? []);
  });

  // Intentionally capture the initial value; the effect below tracks changes.
  // svelte-ignore state_referenced_locally
  let appliedShowChangedOnly = showChangedOnly;
  $effect(() => {
    const nextShowChangedOnly = showChangedOnly;

    untrack(() => {
      if (nextShowChangedOnly === appliedShowChangedOnly) return;
      appliedShowChangedOnly = nextShowChangedOnly;
      const tree = latestFileTree;
      if (tree) {
        applyFileTreeModelSnapshot(tree);
      }
    });
  });

  async function openFile(path: string, options: { external?: boolean } = {}) {
    try {
      if (options.external) {
        await desktopRpc.openPathWithOpener(path, desktopFileOpenerId);
        return;
      }

      window.dispatchEvent(
        new CustomEvent(DESKTOP_OPEN_FILE_TAB_EVENT, {
          detail: { path },
        }),
      );
    } catch (error) {
      console.debug("Unable to open file", error);
    }
  }

  function isExternalEditorClick(event: MouseEvent | undefined) {
    if (!event) return false;
    return isAppleUser() ? event.metaKey : event.ctrlKey;
  }

  async function reloadTree(
    options: { includeGitIgnored?: boolean; path?: string; resetExpansion?: boolean } = {},
  ) {
    const path = options.path ?? rootPath;
    const includeGitIgnored = options.includeGitIgnored ?? showGitIgnored;
    const version = ++loadVersion;
    errorMessage = null;

    if (!path) {
      clearFileTreeState({ resetExpansion: true });
      loadState = "idle";
      return;
    }

    const expandedPaths = options.resetExpansion
      ? new Set<string>()
      : captureExpandedDirectoryPaths();
    if (options.resetExpansion) {
      clearFileTreeState({ resetExpansion: true });
    }
    if (options.resetExpansion || !latestFileTree) {
      loadState = "loading";
    }

    try {
      let tree = await desktopRpc.listDirectoryTree(path, includeGitIgnored);
      if (version !== loadVersion) return;
      if (!options.resetExpansion && expandedPaths.size > 0) {
        const hydratedTree = await hydrateExpandedDirectories(
          tree,
          expandedPaths,
          path,
          includeGitIgnored,
          version,
        );
        if (!hydratedTree) return;
        tree = hydratedTree;
      }
      applyFileTreeSnapshot(tree, {
        clearLoading: true,
        resetExpansion: options.resetExpansion,
      });
    } catch (error) {
      if (version !== loadVersion) return;
      const message = getUnknownErrorMessage(error);
      if (!options.resetExpansion && latestFileTree) {
        desktopRpc.showInfoMessage(`Unable to refresh files: ${message}`, InfoMessageType.error);
        return;
      }
      errorMessage = message;
      loadState = "error";
    }
  }

  function renderFileTreeModel(mount: HTMLElement) {
    const tree = latestFileTree;
    if (!tree || tree.entries.length === 0) return;

    if (fileTreeModel && fileTreeModelMount === mount) {
      applyFileTreeModelSnapshot(tree);
      return;
    }

    if (fileTreeModel) {
      const model = fileTreeModel;
      detachFileTreeModel();
      model.render({ containerWrapper: mount });
      fileTreeModel = model;
      fileTreeModelMount = mount;
      attachFileTreeEventListeners(model);
      return;
    }

    destroyFileTreeModel();
    const model = new FileTree({
      flattenEmptyDirectories: true,
      gitStatus: fileTreeModelGitStatus(tree.gitStatus),
      icons: latestFileIconConfig ?? "minimal",
      initialExpansion: "closed",
      initialExpandedPaths: Array.from(expandedDirectoryPaths),
      itemHeight: 26,
      overscan: 24,
      paths: visibleTreePaths(tree),
      stickyFolders: true,
      unsafeCSS: treeUnsafeCss,
    });

    model.render({ containerWrapper: mount });
    fileTreeModel = model;
    fileTreeModelMount = mount;
    attachFileTreeEventListeners(model);
  }

  function detachFileTreeModel(mount: HTMLElement | undefined = fileTreeModelMount) {
    removeFileTreeEventListeners?.();
    removeFileTreeEventListeners = undefined;
    const model = fileTreeModel;
    fileTreeModel = undefined;
    fileTreeModelMount = undefined;
    model?.unmount();
    mount?.replaceChildren();
  }

  function destroyFileTreeModel(mount: HTMLElement | undefined = fileTreeModelMount) {
    removeFileTreeEventListeners?.();
    removeFileTreeEventListeners = undefined;
    const model = fileTreeModel;
    fileTreeModel = undefined;
    fileTreeModelMount = undefined;
    model?.cleanUp();
    mount?.replaceChildren();
  }

  function cacheFileTreeState() {
    const model = fileTreeModel;
    const currentExpandedDirectoryPaths = captureExpandedDirectoryPaths();
    detachFileTreeModel();

    const state: CachedDesktopFileTreeState = {
      rootPath,
      showGitIgnored,
      showChangedOnly,
      viewMode,
      loadState,
      errorMessage,
      fileTree,
      latestFileTree,
      latestFileIconConfig,
      latestFileIconConfigSignature,
      entriesByRelativePath: new Map(entriesByRelativePath),
      deferredDirectoryPaths: new Set(deferredDirectoryPaths),
      loadingDirectoryPaths: new Set(loadingDirectoryPaths),
      expandedDirectoryPaths: currentExpandedDirectoryPaths,
      fileTreeModel: model,
      iconConfigVersion,
      disposeTimer: undefined,
    };
    storeCachedDesktopFileTreeState(cacheKey, state);
    scheduleCachedDesktopFileTreeDisposal(cacheKey);
  }

  function attachFileTreeEventListeners(model: FileTree) {
    const shadowRoot = model.getFileTreeContainer()?.shadowRoot;
    if (!shadowRoot) return;

    const onClick = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest("[data-type='item']");
      if (!(row instanceof HTMLElement)) return;

      const path = row.dataset.itemPath ?? "";
      const entry = entriesByRelativePath.get(path);
      if (!entry) return;

      if (row.dataset.itemType === "file") {
        const mouseEvent = event instanceof MouseEvent ? event : undefined;
        void openFile(entry.path, {
          external: isExternalEditorClick(mouseEvent),
        });
        return;
      }

      if (row.dataset.itemType === "folder") {
        queueMicrotask(() => syncExpandedDirectory(model, path));
        if (deferredDirectoryPaths.has(path)) {
          void loadDeferredDirectory(path, row);
        }
      }
    };
    const onContextMenu = (event: Event) => {
      if (!(event instanceof MouseEvent)) return;
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest("[data-type='item']");
      if (!(row instanceof HTMLElement)) return;

      const path = row.dataset.itemPath ?? "";
      const entry = entriesByRelativePath.get(path);
      if (!entry) return;

      event.preventDefault();
      event.stopPropagation();
      void showContextMenu(entry, event);
    };

    shadowRoot.addEventListener("click", onClick);
    shadowRoot.addEventListener("contextmenu", onContextMenu);
    removeFileTreeEventListeners = () => {
      shadowRoot.removeEventListener("click", onClick);
      shadowRoot.removeEventListener("contextmenu", onContextMenu);
    };
  }

  function applyFileTreeSnapshot(
    tree: DesktopFileTree,
    options: { clearLoading?: boolean; resetExpansion?: boolean; updateModel?: boolean } = {},
  ) {
    if (options.resetExpansion) {
      expandedDirectoryPaths = new Set();
    } else {
      captureExpandedDirectoryPaths();
    }

    latestFileTree = tree;
    entriesByRelativePath = new Map(tree.entries.map((entry) => [entry.relativePath, entry]));
    deferredDirectoryPaths = new Set(tree.deferredDirectories);
    if (options.clearLoading) {
      loadingDirectoryPaths = new Set();
    }
    if (!options.resetExpansion) {
      pruneExpandedDirectoryPaths(tree.entries);
    }

    fileTree = tree;
    loadState = "ready";
    if (options.updateModel !== false) {
      applyFileTreeModelSnapshot(tree);
    }
  }

  function applyFileTreeModelSnapshot(tree: DesktopFileTree) {
    // A full snapshot supersedes any coalesced filtered refresh.
    cancelFilteredModelRefresh();
    const model = fileTreeModel;
    if (!model) {
      const mount = mountElement;
      if (mount && tree.entries.length > 0) {
        renderFileTreeModel(mount);
      }
      return;
    }

    model.resetPaths(visibleTreePaths(tree), {
      initialExpandedPaths: Array.from(expandedDirectoryPaths),
    });
    model.setGitStatus(fileTreeModelGitStatus(tree.gitStatus));
  }

  /**
   * Pierre's built-in git lane letters untracked files "U", but users read
   * new files as "A"dded — matching the diff panel and changes list — so
   * untracked maps to added before statuses reach the tree model. The row
   * colour is unchanged (both slots are overridden to the same green).
   */
  function fileTreeModelGitStatus(
    gitStatus: DesktopFileTree["gitStatus"],
  ): DesktopFileTree["gitStatus"] {
    return gitStatus.map((entry) =>
      entry.status === "untracked" ? { ...entry, status: "added" } : entry,
    );
  }

  /**
   * Paths shown in the tree model. With the changed-only filter active this
   * keeps changed files/directories plus their ancestor directories, computed
   * from the git status paths themselves (loaded tree entries may stop at a
   * deferred directory well above the actual changed file, so visibility must
   * be derived from the status paths, not from matching entries).
   */
  function visibleTreePaths(tree: DesktopFileTree): string[] {
    if (!showChangedOnly) {
      return tree.entries.map((entry) => entry.relativePath);
    }

    return visibleChangedTreePaths(tree.entries, tree.gitStatus, CHANGED_GIT_STATUSES);
  }

  function clearFileTreeState(options: { resetExpansion?: boolean } = {}) {
    latestFileTree = null;
    entriesByRelativePath = new Map();
    fileTree = null;
    deferredDirectoryPaths = new Set();
    loadingDirectoryPaths = new Set();
    iconConfigVersion += 1;
    latestFileIconConfigSignature = "";
    latestFileIconTheme = undefined;
    applyFileIconConfig(undefined);
    if (options.resetExpansion) {
      expandedDirectoryPaths = new Set();
    }
    destroyFileTreeModel();
  }

  function applyFileIconConfig(config: FileTreeIconConfig | undefined) {
    latestFileIconConfig = config;
    fileTreeModel?.setIcons(config ?? "minimal");
  }

  function captureExpandedDirectoryPaths() {
    const model = fileTreeModel;
    if (!model) return expandedDirectoryPaths;

    const nextExpandedDirectoryPaths = new Set(expandedDirectoryPaths);
    for (const entry of entriesByRelativePath.values()) {
      if (entry.kind !== "directory") continue;
      const item = model.getItem(entry.relativePath);
      if (!item || !("isExpanded" in item)) continue;
      if (item.isExpanded()) {
        nextExpandedDirectoryPaths.add(entry.relativePath);
      } else {
        nextExpandedDirectoryPaths.delete(entry.relativePath);
      }
    }
    expandedDirectoryPaths = nextExpandedDirectoryPaths;
    return nextExpandedDirectoryPaths;
  }

  function pruneExpandedDirectoryPaths(entries: DesktopFileTreeEntry[]) {
    if (expandedDirectoryPaths.size === 0) return;

    const directoryPaths = new Set(
      entries.filter((entry) => entry.kind === "directory").map((entry) => entry.relativePath),
    );
    expandedDirectoryPaths = new Set(
      Array.from(expandedDirectoryPaths).filter((path) => directoryPaths.has(path)),
    );
  }

  function fileTreeChangeAffectsRoot(
    payload: DesktopFileTreeChangedPayload | undefined,
    root: string,
  ) {
    if (!root || !payload?.changes) return false;
    return payload.changes.some((change) => pathIsInsideRoot(change.path, root));
  }

  function pathIsInsideRoot(path: string, root: string) {
    const normalizedPath = normalizeDesktopPath(path);
    const normalizedRoot = normalizeDesktopPath(root);
    if (normalizedRoot === "/") {
      return normalizedPath.startsWith("/");
    }

    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
  }

  function normalizeDesktopPath(path: string) {
    const normalized = path.replaceAll("\\", "/");
    return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
  }

  /**
   * Per-payload mutation scratchpad. Watcher payloads can contain thousands
   * of changes (builds, installs, checkouts), so every per-change lookup must
   * be O(1)/O(depth) — array scans over the full entry list per change made
   * large bursts take seconds and blocked the webview main thread.
   */
  interface FileTreeMutationState {
    /** Retained + added entries, keyed by relativePath. Source of truth. */
    entriesByPath: Map<string, DesktopFileTreeEntry>;
    /** Entries added this payload, in arrival order (appended to the tree). */
    addedEntries: DesktopFileTreeEntry[];
    /** Directories that have (or had, within this payload) descendant entries. */
    ancestorDirectoryPaths: Set<string>;
    gitStatusByPath: Map<string, DesktopFileTreeGitStatus>;
    entriesChanged: boolean;
  }

  function createFileTreeMutationState(tree: DesktopFileTree): FileTreeMutationState {
    const entriesByPath = new Map(tree.entries.map((entry) => [entry.relativePath, entry]));
    const ancestorDirectoryPaths = new Set<string>();
    for (const entry of tree.entries) {
      addAncestorDirectoryPaths(ancestorDirectoryPaths, entry.relativePath);
    }
    return {
      entriesByPath,
      addedEntries: [],
      ancestorDirectoryPaths,
      gitStatusByPath: new Map(tree.gitStatus.map((entry) => [entry.path, entry.status])),
      entriesChanged: false,
    };
  }

  function addAncestorDirectoryPaths(ancestorDirectoryPaths: Set<string>, relativePath: string) {
    let parentPath = fileTreeParentDirectory(relativePath);
    while (parentPath && !ancestorDirectoryPaths.has(parentPath)) {
      ancestorDirectoryPaths.add(parentPath);
      parentPath = fileTreeParentDirectory(parentPath);
    }
  }

  function applyFileTreeChanges(payload: DesktopFileTreeChangedPayload | undefined) {
    const currentTree = latestFileTree;
    if (!currentTree || !payload?.changes) return false;

    const model = fileTreeModel;
    const mutation = createFileTreeMutationState(currentTree);
    const nextDeferredDirectoryPaths = new Set(deferredDirectoryPaths);
    const nextLoadingDirectoryPaths = new Set(loadingDirectoryPaths);
    const nextExpandedDirectoryPaths = captureExpandedDirectoryPaths();
    const mutationOperations: FileTreeBatchOperation[] = [];
    let changed = false;

    for (const change of payload.changes) {
      if (!pathIsInsideRoot(change.path, currentTree.rootPath)) continue;

      if (change.type === FILE_CHANGE_CREATED) {
        const result = applyCreatedFileTreeChange(
          change,
          currentTree.rootPath,
          mutation,
          nextDeferredDirectoryPaths,
          mutationOperations,
        );
        if (result === "changed") changed = true;
        continue;
      }

      if (change.type === FILE_CHANGE_CHANGED) {
        const result = applyChangedFileTreeChange(change, currentTree.rootPath, mutation);
        if (result === "changed") changed = true;
        continue;
      }

      if (change.type === FILE_CHANGE_DELETED) {
        const result = applyDeletedFileTreeChange(
          change,
          currentTree.rootPath,
          mutation,
          nextDeferredDirectoryPaths,
          nextLoadingDirectoryPaths,
          nextExpandedDirectoryPaths,
          mutationOperations,
        );
        if (result === "changed") changed = true;
      }
    }

    if (!changed) return true;

    const nextEntries = mutation.entriesChanged
      ? [
          ...currentTree.entries.filter(
            (entry) => mutation.entriesByPath.get(entry.relativePath) === entry,
          ),
          // Identity check: a path added, deleted, and re-added within one
          // payload leaves stale records in addedEntries.
          ...mutation.addedEntries.filter(
            (entry) => mutation.entriesByPath.get(entry.relativePath) === entry,
          ),
        ]
      : currentTree.entries;
    const nextTree = {
      ...currentTree,
      entries: nextEntries,
      deferredDirectories: Array.from(nextDeferredDirectoryPaths),
      gitStatus: Array.from(mutation.gitStatusByPath, ([path, status]) => ({ path, status })),
    };
    deferredDirectoryPaths = nextDeferredDirectoryPaths;
    loadingDirectoryPaths = nextLoadingDirectoryPaths;
    expandedDirectoryPaths = nextExpandedDirectoryPaths;
    latestFileTree = nextTree;
    entriesByRelativePath = mutation.entriesByPath;
    fileTree = nextTree;
    loadState = "ready";
    if (model) {
      if (showChangedOnly) {
        // Incremental add/remove ops assume the unfiltered path set; with the
        // changed-only filter active, recompute the visible paths instead —
        // coalesced so a burst of payloads rebuilds the model once, not once
        // per 150 ms watcher flush.
        scheduleFilteredModelRefresh();
      } else {
        if (mutationOperations.length > 0) {
          model.batch(mutationOperations);
        }
        model.setGitStatus(fileTreeModelGitStatus(nextTree.gitStatus));
      }
    } else if (mountElement && nextEntries.length > 0) {
      renderFileTreeModel(mountElement);
    }
    return true;
  }

  /**
   * Replaces the watcher-inferred git statuses with authoritative
   * `git status` output. The optimistic upserts only ever add/overwrite
   * (created → untracked, changed → modified) and can't see .gitignore,
   * content-identical writes, or files reverting to their committed state, so
   * without reconciliation the changed count grows during any build/agent
   * burst. Gitignored entries (host-provided when "show gitignored" is on)
   * are preserved — `git status` doesn't report them.
   */
  function reconcileGitStatus(git: GitStatusOutput): void {
    const currentTree = latestFileTree;
    if (!currentTree) return;

    const nextStatusByPath = new Map<string, DesktopFileTreeGitStatus>();
    for (const entry of currentTree.gitStatus) {
      if (entry.status === "ignored") {
        nextStatusByPath.set(entry.path, "ignored");
      }
    }
    if (git.isRepo) {
      for (const file of git.staged) {
        nextStatusByPath.set(file.path, treeGitStatusForHelperStatus(file.status));
      }
      // Worktree state wins over index state for row colouring.
      for (const file of git.unstaged) {
        nextStatusByPath.set(file.path, treeGitStatusForHelperStatus(file.status));
      }
      for (const file of git.untracked) {
        nextStatusByPath.set(file.path, "untracked");
      }
    }

    if (gitStatusMapEquals(nextStatusByPath, currentTree.gitStatus)) return;

    const nextTree = {
      ...currentTree,
      gitStatus: Array.from(nextStatusByPath, ([path, status]) => ({ path, status })),
    };
    latestFileTree = nextTree;
    fileTree = nextTree;
    fileTreeModel?.setGitStatus(fileTreeModelGitStatus(nextTree.gitStatus));
    if (showChangedOnly) {
      // The set of changed paths may have shrunk/grown; refresh the filter.
      scheduleFilteredModelRefresh();
    }
  }

  function treeGitStatusForHelperStatus(status: string): DesktopFileTreeGitStatus {
    switch (status) {
      case "added":
        return "added";
      case "deleted":
        return "deleted";
      case "renamed":
      case "copied":
        return "renamed";
      case "untracked":
        return "untracked";
      default:
        // modified / typechange / unmerged / unknown all colour as modified.
        return "modified";
    }
  }

  function gitStatusMapEquals(
    statusByPath: Map<string, DesktopFileTreeGitStatus>,
    gitStatus: DesktopFileTreeGitStatusEntry[],
  ): boolean {
    if (statusByPath.size !== gitStatus.length) return false;
    for (const entry of gitStatus) {
      if (statusByPath.get(entry.path) !== entry.status) return false;
    }
    return true;
  }

  let filteredModelRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleFilteredModelRefresh() {
    if (filteredModelRefreshTimer !== undefined) return;
    filteredModelRefreshTimer = setTimeout(() => {
      filteredModelRefreshTimer = undefined;
      const tree = latestFileTree;
      if (tree && showChangedOnly && fileTreeModel) {
        applyFileTreeModelSnapshot(tree);
      }
    }, FILTERED_MODEL_REFRESH_DELAY_MS);
  }

  function cancelFilteredModelRefresh() {
    if (filteredModelRefreshTimer !== undefined) {
      clearTimeout(filteredModelRefreshTimer);
      filteredModelRefreshTimer = undefined;
    }
  }

  function applyCreatedFileTreeChange(
    change: DesktopFileTreeChange,
    root: string,
    mutation: FileTreeMutationState,
    nextDeferredDirectoryPaths: Set<string>,
    mutationOperations: FileTreeBatchOperation[],
  ): "changed" | "unchanged" {
    const relativePath = fileTreeRelativePathForCreatedChange(change, root);
    if (!relativePath) return "unchanged";
    // The host tree hides git internals (`**/.git`); don't let a watcher
    // create event (git init/clone writing the repo dir) re-add them. Deeper
    // .git-internal paths are already dropped by the visible-ancestor checks.
    if (relativePath.split("/").includes(".git")) return "unchanged";

    const existingEntry = mutation.entriesByPath.has(relativePath);
    const parentPath = fileTreeParentDirectory(relativePath);
    const parentLoaded = mutationParentLoaded(parentPath, mutation);
    if (
      !existingEntry &&
      !parentLoaded &&
      !mutationHasVisibleAncestorDirectory(relativePath, mutation)
    ) {
      return "unchanged";
    }

    const statusChanged = mutationUpsertGitStatus(mutation, relativePath, "untracked");
    if (existingEntry) {
      return statusChanged ? "changed" : "unchanged";
    }
    if (!parentLoaded) {
      return statusChanged ? "changed" : "unchanged";
    }

    const kind = change.kind ?? "file";
    const entry = {
      path: change.path,
      relativePath,
      kind,
      gitIgnored: false,
    };
    mutation.entriesByPath.set(relativePath, entry);
    mutation.addedEntries.push(entry);
    mutation.entriesChanged = true;
    addAncestorDirectoryPaths(mutation.ancestorDirectoryPaths, relativePath);
    if (kind === "directory") {
      nextDeferredDirectoryPaths.add(relativePath);
    }
    mutationOperations.push({ path: relativePath, type: "add" });
    return "changed";
  }

  function applyChangedFileTreeChange(
    change: DesktopFileTreeChange,
    root: string,
    mutation: FileTreeMutationState,
  ): "changed" | "unchanged" {
    const relativePath = fileTreeRelativePath(change.path, root);
    if (!relativePath) return "unchanged";

    const entry =
      mutation.entriesByPath.get(relativePath) ??
      mutation.entriesByPath.get(ensureDirectoryPath(relativePath));
    if (entry?.gitIgnored) return "unchanged";

    const statusPath =
      entry?.kind === "directory" ? ensureDirectoryPath(relativePath) : relativePath;
    const existingStatus = mutation.gitStatusByPath.get(statusPath);
    if (!entry && !existingStatus && !mutationHasVisibleAncestorDirectory(relativePath, mutation)) {
      return "unchanged";
    }
    if (existingStatus && existingStatus !== "modified") {
      return "unchanged";
    }

    return mutationUpsertGitStatus(mutation, statusPath, "modified") ? "changed" : "unchanged";
  }

  function applyDeletedFileTreeChange(
    change: DesktopFileTreeChange,
    root: string,
    mutation: FileTreeMutationState,
    nextDeferredDirectoryPaths: Set<string>,
    nextLoadingDirectoryPaths: Set<string>,
    nextExpandedDirectoryPaths: Set<string>,
    mutationOperations: FileTreeBatchOperation[],
  ): "changed" | "unchanged" {
    const directRelativePath = fileTreeRelativePath(change.path, root);
    const relativePath = mutationRelativePathForDeletedChange(change, root, mutation);
    if (!directRelativePath && !relativePath) return "unchanged";

    const deletedPath = relativePath ?? directRelativePath;
    if (!deletedPath) return "unchanged";

    const removedEntry = relativePath ? mutation.entriesByPath.get(relativePath) : undefined;
    const removeDirectory =
      removedEntry?.kind === "directory" ||
      deletedPath.endsWith("/") ||
      mutationGitStatusHasDescendants(mutation, deletedPath);
    const statusChanged = applyDeletedFileTreeGitStatusChange(
      mutation,
      deletedPath,
      removeDirectory,
      removedEntry,
      mutationHasVisibleAncestorDirectory(deletedPath, mutation),
    );

    let entriesRemoved = false;
    if (removeDirectory) {
      const directoryPath = ensureDirectoryPath(deletedPath);
      for (const path of mutation.entriesByPath.keys()) {
        if (path === deletedPath || path.startsWith(directoryPath)) {
          mutation.entriesByPath.delete(path);
          entriesRemoved = true;
        }
      }
    } else if (mutation.entriesByPath.delete(deletedPath)) {
      entriesRemoved = true;
    }
    if (!entriesRemoved) {
      return statusChanged ? "changed" : "unchanged";
    }

    mutation.entriesChanged = true;
    if (removeDirectory) {
      const directoryPath = ensureDirectoryPath(deletedPath);
      nextDeferredDirectoryPaths.delete(directoryPath);
      nextLoadingDirectoryPaths.delete(directoryPath);
      nextExpandedDirectoryPaths.delete(directoryPath);
    }
    mutationOperations.push({ path: deletedPath, recursive: removeDirectory, type: "remove" });
    return "changed";
  }

  function applyDeletedFileTreeGitStatusChange(
    mutation: FileTreeMutationState,
    relativePath: string,
    removeDirectory: boolean,
    removedEntry: DesktopFileTreeEntry | undefined,
    hasVisibleAncestor: boolean,
  ) {
    const statusPath = removeDirectory ? ensureDirectoryPath(relativePath) : relativePath;
    const existingStatus = mutation.gitStatusByPath.get(statusPath);

    let changed = false;
    let removedOnlyUntrackedOrIgnored: boolean;
    if (removeDirectory) {
      const directoryPath = ensureDirectoryPath(statusPath);
      let removedCount = 0;
      let removedUntrackedOrIgnoredCount = 0;
      for (const [path, status] of mutation.gitStatusByPath) {
        if (path !== statusPath && !path.startsWith(directoryPath)) continue;
        removedCount += 1;
        if (status === "untracked" || status === "ignored") {
          removedUntrackedOrIgnoredCount += 1;
        }
        mutation.gitStatusByPath.delete(path);
        changed = true;
      }
      removedOnlyUntrackedOrIgnored =
        removedCount > 0 && removedCount === removedUntrackedOrIgnoredCount;
    } else {
      const status = mutation.gitStatusByPath.get(statusPath);
      changed = mutation.gitStatusByPath.delete(statusPath);
      removedOnlyUntrackedOrIgnored =
        status !== undefined && (status === "untracked" || status === "ignored");
    }

    if (
      existingStatus === "untracked" ||
      existingStatus === "ignored" ||
      removedEntry?.gitIgnored ||
      removedOnlyUntrackedOrIgnored
    ) {
      return changed;
    }

    if (!existingStatus && !removedEntry && !hasVisibleAncestor) {
      return changed;
    }

    changed = mutationUpsertGitStatus(mutation, statusPath, "deleted") || changed;
    return changed;
  }

  function mutationUpsertGitStatus(
    mutation: FileTreeMutationState,
    path: string,
    status: DesktopFileTreeGitStatus,
  ) {
    if (mutation.gitStatusByPath.get(path) === status) return false;
    mutation.gitStatusByPath.set(path, status);
    return true;
  }

  function mutationGitStatusHasDescendants(mutation: FileTreeMutationState, path: string) {
    const directoryPath = ensureDirectoryPath(path);
    for (const statusPath of mutation.gitStatusByPath.keys()) {
      if (statusPath.startsWith(directoryPath)) return true;
    }
    return false;
  }

  function mutationParentLoaded(parentPath: string, mutation: FileTreeMutationState) {
    if (!parentPath) return true;
    const parentEntry = mutation.entriesByPath.get(parentPath);
    return parentEntry?.kind === "directory" && !deferredDirectoryPaths.has(parentPath);
  }

  function mutationHasVisibleAncestorDirectory(
    relativePath: string,
    mutation: FileTreeMutationState,
  ) {
    let parentPath = fileTreeParentDirectory(relativePath);
    while (parentPath) {
      if (mutation.entriesByPath.get(parentPath)?.kind === "directory") return true;
      parentPath = fileTreeParentDirectory(parentPath);
    }
    return false;
  }

  function mutationRelativePathForDeletedChange(
    change: DesktopFileTreeChange,
    root: string,
    mutation: FileTreeMutationState,
  ): string | null {
    const relativePath = fileTreeRelativePath(change.path, root);
    if (!relativePath) return null;

    if (mutation.entriesByPath.has(relativePath)) return relativePath;

    const directoryPath = ensureDirectoryPath(relativePath);
    if (mutation.entriesByPath.has(directoryPath)) return directoryPath;
    // A directory with loaded descendants but no explicit entry (e.g. the
    // watcher reports the parent of visible children).
    if (mutation.ancestorDirectoryPaths.has(directoryPath)) return directoryPath;

    return null;
  }

  function fileTreeRelativePathForCreatedChange(
    change: DesktopFileTreeChange,
    root: string,
  ): string | null {
    const relativePath = fileTreeRelativePath(change.path, root);
    if (!relativePath) return null;
    return change.kind === "directory" ? ensureDirectoryPath(relativePath) : relativePath;
  }

  function fileTreeRelativePath(path: string, root: string): string | null {
    const relativePath = normalize(relative(root, path));
    if (
      !relativePath ||
      relativePath === "." ||
      relativePath === ".." ||
      relativePath.startsWith("../")
    ) {
      return null;
    }
    return relativePath;
  }

  function fileTreeParentDirectory(relativePath: string) {
    const trimmedPath = relativePath.endsWith("/") ? relativePath.slice(0, -1) : relativePath;
    const parent = dirname(trimmedPath);
    return parent === "." ? "" : ensureDirectoryPath(parent);
  }

  function ensureDirectoryPath(path: string) {
    return path.endsWith("/") ? path : `${path}/`;
  }

  function refreshFileTreeIcons(entries: DesktopFileTreeEntry[]) {
    const fileIconTheme = theme.fileIconTheme;
    const signature = fileIconTheme ? fileTreeIconConfigSignature(entries, fileIconTheme) : "";
    if (fileIconTheme === latestFileIconTheme && signature === latestFileIconConfigSignature) {
      return;
    }
    latestFileIconTheme = fileIconTheme;
    latestFileIconConfigSignature = signature;
    const version = ++iconConfigVersion;

    if (entries.length === 0 || !fileIconTheme) {
      applyFileIconConfig(undefined);
      return;
    }

    void createFileTreeIconConfig(entries, fileIconTheme)
      .then((config) => {
        if (version !== iconConfigVersion) return;
        applyFileIconConfig(config);
      })
      .catch((error) => {
        console.debug("Unable to load file tree icons", error);
      });
  }

  async function hydrateExpandedDirectories(
    tree: DesktopFileTree,
    expandedPaths: Set<string>,
    root: string,
    includeGitIgnored: boolean,
    version: number,
  ): Promise<DesktopFileTree | null> {
    let nextTree = tree;
    const paths = Array.from(expandedPaths).sort(compareDirectoryPathsByDepth);

    for (const relativePath of paths) {
      if (version !== loadVersion) return null;
      const entry = nextTree.entries.find(
        (candidate) => candidate.kind === "directory" && candidate.relativePath === relativePath,
      );
      if (!entry) continue;

      try {
        const subtree = await desktopRpc.listDirectorySubtree(
          root,
          relativePath,
          includeGitIgnored,
        );
        if (version !== loadVersion) return null;
        nextTree = mergeFileTreeSubtree(nextTree, subtree, relativePath);
      } catch (error) {
        console.debug("Unable to refresh expanded file tree directory", error);
      }
    }

    return nextTree;
  }

  function compareDirectoryPathsByDepth(left: string, right: string) {
    return directoryPathDepth(left) - directoryPathDepth(right) || left.localeCompare(right);
  }

  function directoryPathDepth(path: string) {
    return path.split("/").filter(Boolean).length;
  }

  function mergeFileTreeSubtree(
    currentTree: DesktopFileTree,
    subtree: DesktopFileTree,
    loadedDirectoryPath: string,
  ): DesktopFileTree {
    if (currentTree.rootPath !== subtree.rootPath) return currentTree;

    const nextEntries = [...currentTree.entries];
    const nextLoadedTreePaths = new Set(currentTree.entries.map((entry) => entry.relativePath));
    for (const entry of subtree.entries) {
      if (nextLoadedTreePaths.has(entry.relativePath)) continue;
      nextLoadedTreePaths.add(entry.relativePath);
      nextEntries.push(entry);
    }

    const nextDeferredDirectoryPaths = new Set(currentTree.deferredDirectories);
    nextDeferredDirectoryPaths.delete(loadedDirectoryPath);
    for (const path of subtree.deferredDirectories) {
      nextDeferredDirectoryPaths.add(path);
    }

    const nextGitStatusByPath = new Map(currentTree.gitStatus.map((entry) => [entry.path, entry]));
    for (const entry of subtree.gitStatus) {
      nextGitStatusByPath.set(entry.path, entry);
    }

    return {
      rootPath: currentTree.rootPath,
      entries: nextEntries,
      deferredDirectories: Array.from(nextDeferredDirectoryPaths),
      gitStatus: Array.from(nextGitStatusByPath.values()),
    };
  }

  async function showContextMenu(entry: DesktopFileTreeEntry, event: MouseEvent) {
    const requestId = crypto.randomUUID();
    pendingContextMenuEntries.set(requestId, entry);
    window.setTimeout(() => pendingContextMenuEntries.delete(requestId), 30_000);

    try {
      await desktopRpc.showDesktopFileTreeContextMenu({
        requestId,
        item: {
          kind: entry.kind,
          hasGitChanges: entryHasGitChanges(entry),
        },
        position: {
          x: event.clientX,
          y: event.clientY,
        },
        currentOpenerId: desktopFileOpenerId,
        fileOpeners: desktopFileContextMenuOpeners,
        desktopOpeners: desktopContextMenuOpeners,
      });
    } catch (error) {
      pendingContextMenuEntries.delete(requestId);
      desktopRpc.showInfoMessage(
        `Unable to show file menu: ${getUnknownErrorMessage(error)}`,
        InfoMessageType.error,
      );
    }
  }

  function entryHasGitChanges(entry: DesktopFileTreeEntry): boolean {
    if (entry.kind !== "file" || entry.gitIgnored) return false;
    const status = latestFileTree?.gitStatus.find(
      (candidate) => candidate.path === entry.relativePath,
    )?.status;
    return status !== undefined && CHANGED_GIT_STATUSES.has(status);
  }

  /**
   * Switches this worktree's files tab into the changes view and asks it to
   * preselect the given repo-relative file so its diff opens immediately.
   */
  function openDiffForFile(relativePath: string) {
    requestDesktopChangesFileSelection(relativePath);
    requestDesktopChangesView(rootPath);
    // Ask the splits pane to focus/reveal the files tab hosting the tree.
    window.dispatchEvent(new CustomEvent(DESKTOP_OPEN_CHANGES_EVENT));
  }

  function syncExpandedDirectory(model: FileTree, path: string) {
    const item = model.getItem(path);
    if (!item || !("isExpanded" in item)) return;

    const nextExpandedDirectoryPaths = new Set(expandedDirectoryPaths);
    if (item.isExpanded()) {
      nextExpandedDirectoryPaths.add(path);
    } else {
      nextExpandedDirectoryPaths.delete(path);
    }
    expandedDirectoryPaths = nextExpandedDirectoryPaths;
  }

  async function loadDeferredDirectory(relativePath: string, row: HTMLElement) {
    if (loadingDirectoryPaths.has(relativePath)) return;

    const version = loadVersion;
    const includeGitIgnored = showGitIgnored;
    row.dataset.camberLoading = "true";
    loadingDirectoryPaths = new Set([...loadingDirectoryPaths, relativePath]);
    expandedDirectoryPaths = new Set([...expandedDirectoryPaths, relativePath]);

    try {
      const subtree = await desktopRpc.listDirectorySubtree(
        rootPath,
        relativePath,
        includeGitIgnored,
      );
      const currentTree = fileTree;
      if (!currentTree || currentTree.rootPath !== subtree.rootPath || version !== loadVersion) {
        return;
      }

      applyFileTreeSnapshot(mergeFileTreeSubtree(currentTree, subtree, relativePath));
    } catch (error) {
      console.debug("Unable to load file tree directory", error);
    } finally {
      row.dataset.camberLoading = "false";
      loadingDirectoryPaths = new Set(
        Array.from(loadingDirectoryPaths).filter((path) => path !== relativePath),
      );
    }
  }

  function applyDesktopSettings(settings: DesktopSettings | undefined) {
    if (typeof settings?.fileOpenerId === "string" && settings.fileOpenerId.length > 0) {
      desktopFileOpenerId = settings.fileOpenerId;
    }
    if (settings?.fileOpeners) {
      desktopFileContextMenuOpeners = contextMenuOpeners(settings.fileOpeners);
    }
    if (settings?.desktopOpeners) {
      desktopContextMenuOpeners = contextMenuOpeners(settings.desktopOpeners);
    }
  }

  function contextMenuOpeners(openers: DesktopFileOpener[]): DesktopFileTreeContextMenuOpener[] {
    return openers.map(({ id, label }) => ({ id, label }));
  }

  async function createFileTreeIconConfig(
    entries: DesktopFileTreeEntry[],
    fileIconTheme: FileIconTheme,
  ): Promise<FileTreeIconConfig> {
    const iconNamesByBasename = new Map<string, string>();
    const iconNames = new Set<string>();
    const defaultIconName = fileIconTheme.file;

    for (const entry of entries) {
      if (entry.kind !== "file") continue;

      const base = basename(entry.relativePath);
      const iconName = getFileIconName(fileIconTheme, base);
      if (!iconName) continue;

      if (iconName !== defaultIconName) {
        iconNamesByBasename.set(base, iconName);
      }
      iconNames.add(iconName);
    }

    if (fileIconTheme.file) {
      iconNames.add(fileIconTheme.file);
    }

    const iconsByName = new Map<string, { icon: RemappedIcon; symbol: string }>();
    await Promise.all(
      Array.from(iconNames).map(async (iconName) => {
        const iconDefinition = await theme.getFileIconDefinition(iconName);
        if (!iconDefinition) return;

        const symbol = svgIconDefinitionToSymbol(iconDefinition, fileTreeIconSymbolId(iconName));
        if (!symbol) return;

        iconsByName.set(iconName, symbol);
      }),
    );

    const byFileName: Record<string, RemappedIcon> = {};
    for (const [base, iconName] of iconNamesByBasename) {
      const icon = iconsByName.get(iconName)?.icon;
      if (icon) byFileName[base] = icon;
    }

    const defaultFileIcon = fileIconTheme.file
      ? iconsByName.get(fileIconTheme.file)?.icon
      : undefined;
    const symbols = Array.from(iconsByName.values()).map(({ symbol }) => symbol);

    return {
      set: "none",
      ...(symbols.length > 0 && {
        spriteSheet: `<svg data-icon-sprite aria-hidden="true" width="0" height="0">${symbols.join("")}</svg>`,
      }),
      ...(Object.keys(byFileName).length > 0 && { byFileName }),
      ...(defaultFileIcon && {
        remap: {
          "file-tree-icon-file": defaultFileIcon,
        },
      }),
    };
  }

  function fileTreeIconConfigSignature(
    entries: DesktopFileTreeEntry[],
    fileIconTheme: FileIconTheme,
  ) {
    const defaultIconName = fileIconTheme.file ?? "";
    const iconNamesByBasename = new Map<string, string>();

    for (const entry of entries) {
      if (entry.kind !== "file") continue;

      const base = basename(entry.relativePath);
      const iconName = getFileIconName(fileIconTheme, base);
      if (iconName && iconName !== defaultIconName) {
        iconNamesByBasename.set(base, iconName);
      }
    }

    return [
      defaultIconName,
      ...Array.from(iconNamesByBasename)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([base, iconName]) => `${base}:${iconName}`),
    ].join("\0");
  }

  function getFileIconName(fileIconTheme: FileIconTheme, base: string) {
    const fileNameIcon =
      fileIconTheme.fileNames?.[base] ?? fileIconTheme.fileNames?.[base.toLowerCase()];
    return fileNameIcon ?? getFileIconNameByExtension(fileIconTheme, base);
  }

  function getFileIconNameByExtension(
    { fileExtensions, languageIds, file }: FileIconTheme,
    base: string,
  ) {
    const firstDotIndex = base.indexOf(".");
    if (firstDotIndex !== -1 && fileExtensions) {
      const fullExtension = base.slice(firstDotIndex + 1);
      const parts = fullExtension.split(".");

      for (let i = 0; i < parts.length; i++) {
        const ext = parts.slice(i).join(".");
        const iconName = fileExtensions[ext];
        if (iconName) return iconName;
      }
    }

    if (languageIds) {
      for (const lang of languages.getByPath(base)) {
        const iconName = languageIds[lang.id];
        if (iconName) return iconName;
      }
    }

    return file;
  }

  function svgIconDefinitionToSymbol(iconDefinition: string, id: string) {
    const template = document.createElement("template");
    template.innerHTML = iconDefinition.trim();

    const svg = template.content.firstElementChild;
    if (svg?.localName.toLowerCase() !== "svg") return;

    const viewBox = svg.getAttribute("viewBox") ?? "0 0 16 16";
    const symbolAttributes = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]
      .map((attribute) => {
        const value = svg.getAttribute(attribute);
        return value ? ` ${attribute}="${escapeHtmlAttribute(value)}"` : "";
      })
      .join("");

    return {
      icon: {
        name: id,
        width: 16,
        height: 16,
        viewBox,
      },
      symbol: `<symbol id="${id}" viewBox="${escapeHtmlAttribute(viewBox)}"${symbolAttributes}>${svg.innerHTML}</symbol>`,
    };
  }

  function fileTreeIconSymbolId(iconName: string) {
    const slug = iconName.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "icon";
    return `camber-file-icon-${slug}-${hashString(iconName)}`;
  }

  function hashString(value: string) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) | 0;
    }

    return Math.abs(hash).toString(36);
  }

  function escapeHtmlAttribute(value: string) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }
</script>

<div class="desktop-files-tree">
  {#if canLoad}
    <SegmentedSwitch
      class="desktop-files-tree-mode"
      options={MODE_OPTIONS}
      bind:value={viewMode}
      ariaLabel="Files pane view"
      optionWidth={78}
      data-tauri-drag-region="false"
    />
  {/if}

  <!-- The two views cross-fade sequentially (out first, in second). Both
       panes stay mounted: the tree keeps its model, expansion state, and
       watcher wiring across toggles (rebuilding it on every toggle would
       cost far more than keeping it), and the changes list keeps its loaded
       status, so neither side flashes a spinner mid-fade. The hidden pane is
       visibility: hidden — skipped for paint and hit-testing — and inert
       (unreachable by focus and assistive tech). -->
  <div class="desktop-files-tree-views" class:desktop-files-tree-views--changes={changesViewActive}>
    <div class="desktop-files-tree-pane desktop-files-tree-tree-view" inert={changesViewActive}>
      <div class="desktop-files-tree-body">
        {#if canLoad}
          <div
            bind:this={mountElement}
            class="desktop-files-tree-mount"
            class:desktop-files-tree-mount--hidden={!fileTree && loadState !== "ready"}
          ></div>
        {/if}

        {#if !canLoad}
          <div class="desktop-files-tree-message">No working directory.</div>
        {:else if loadState === "loading" && !fileTree}
          <div class="desktop-files-tree-message">Loading files...</div>
        {:else if loadState === "error" && !fileTree}
          <div class="desktop-files-tree-message">
            <div>Files could not load.</div>
            {#if errorMessage}
              <div class="desktop-files-tree-error">{errorMessage}</div>
            {/if}
          </div>
        {:else if fileTree?.entries.length === 0}
          <div class="desktop-files-tree-message">No files in this folder.</div>
        {:else if loadState === "ready" && showChangedOnly && !hasChangedStatuses}
          <div class="desktop-files-tree-message">No changed files.</div>
        {/if}
      </div>
    </div>

    {#if canLoad}
      <div
        bind:this={changesViewElement}
        class="desktop-files-tree-pane desktop-files-tree-changes-view"
        inert={!changesViewActive}
      >
        <DesktopChangesList worktreePath={rootPath} focusRequest={commitMessageFocusRequest} />
      </div>
    {/if}
  </div>
</div>

<style>
  .desktop-files-tree {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    background: var(--psx-terminal-background);
    color: var(--psx-foreground-primary);
  }

  /* Per-instance overrides on the shared SegmentedSwitch: centred with a
     small top margin, slightly taller options than the default. */
  .desktop-files-tree :global(.desktop-files-tree-mode) {
    align-self: center;
    margin: 4px 6px 0;
    --segmented-switch-option-min-height: 24px;
  }

  /* Stacked panes for the two views. Toggling cross-fades sequentially: the
     outgoing pane fades out over 90ms, then the incoming pane fades in for
     90ms (its opacity transition is delayed by the outgoing duration, so the
     fades never overlap). visibility flips instantly on hide — the hidden
     pane stops painting and hit-testing at once — but is held during the
     incoming delay so the pane only appears when its fade starts. */
  .desktop-files-tree-views {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .desktop-files-tree-pane {
    position: absolute;
    inset: 0;
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
  }

  /* Hidden state: fade out immediately (no delay), then flip visibility. */
  .desktop-files-tree-pane {
    visibility: hidden;
    opacity: 0;
    transition:
      opacity 90ms ease,
      visibility 0s 90ms;
  }

  /* Shown state: wait out the other pane's fade, then fade in. */
  .desktop-files-tree-views:not(.desktop-files-tree-views--changes) .desktop-files-tree-tree-view,
  .desktop-files-tree-views--changes .desktop-files-tree-changes-view {
    visibility: visible;
    opacity: 1;
    transition:
      opacity 90ms ease 90ms,
      visibility 0s 90ms;
  }

  @media (prefers-reduced-motion: reduce) {
    .desktop-files-tree-pane,
    .desktop-files-tree-views:not(.desktop-files-tree-views--changes) .desktop-files-tree-tree-view,
    .desktop-files-tree-views--changes .desktop-files-tree-changes-view {
      transition: none;
    }
  }

  .desktop-files-tree-body {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    overflow: hidden;
  }

  .desktop-files-tree-mount {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .desktop-files-tree-mount--hidden {
    visibility: hidden;
  }

  .desktop-files-tree-message {
    position: absolute;
    inset: 0;
    z-index: 1;
    color: var(--psx-foreground-secondary);
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 16px;
    text-align: center;
    font-size: 12px;
  }

  .desktop-files-tree-error {
    color: var(--psx-foreground-tertiary);
    max-width: 520px;
  }

  .desktop-files-tree-mount :global(file-tree-container) {
    width: 100%;
    height: 100%;
  }
</style>
