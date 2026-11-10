<script lang="ts" module>
  import type { GitStatusOutput as CachedGitStatusOutput } from "@camber/helperapi";

  // Last known status per worktree so remounts (tab switches, opening the
  // Diff tab in the same pane) render instantly instead of flashing a
  // spinner; the mount then refreshes silently in the background. Bounded so
  // a long-lived window doesn't accumulate every worktree ever opened.
  const lastKnownStatusByWorktree = new Map<string, CachedGitStatusOutput>();
  const MAX_CACHED_WORKTREES = 20;

  function cacheStatus(path: string, git: CachedGitStatusOutput): void {
    lastKnownStatusByWorktree.delete(path);
    lastKnownStatusByWorktree.set(path, git);
    for (const key of lastKnownStatusByWorktree.keys()) {
      if (lastKnownStatusByWorktree.size <= MAX_CACHED_WORKTREES) break;
      lastKnownStatusByWorktree.delete(key);
    }
  }
</script>

<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import {
    camberGitCommit,
    camberGitDiscard,
    camberGitStage,
    camberGitStatus,
    camberGitUnstage,
    type GitFileChange,
    type GitStatusOutput,
  } from "@camber/helperapi";
  import { untrack } from "svelte";
  import { extractErrorMessage } from "../../errors";
  import {
    DESKTOP_CHANGES_SELECT_FILE_EVENT,
    takePendingDesktopChangesFileSelection,
    type DesktopChangesSelectFileEventDetail,
  } from "./desktopChangesFileSelection";
  import {
    DESKTOP_FILE_TREE_CHANGED_EVENT,
    DESKTOP_GIT_CHANGED_EVENT,
  } from "../../features/DesktopGitChangesState.svelte";
  import { getUnknownErrorMessage } from "@camber/lib/errors";
  import { InfoMessageType } from "@camber/rpc";
  import { rpc, type RPCClient } from "../../hostRpc";
  import {
    DESKTOP_OPEN_DIFF_TAB_EVENT,
    DESKTOP_OPEN_FILE_TAB_EVENT,
    type DesktopOpenDiffTabEventDetail,
  } from "./desktopCommandPicker";
  import { commitSubjectCharactersRemaining } from "./desktopCommitMessage";
  import { requestDesktopFilePromptChip } from "./desktopFilePromptChip";
  import type { DesktopFileTreeContextMenuActionPayload } from "./desktopFilesTreeActions";
  import type {
    DesktopFileTreeContextMenuOpener,
    DesktopFileTreeContextMenuRequest,
  } from "./desktopFilesTreeContextMenu";
  import GitBranchTrackingLabel from "./GitBranchTrackingLabel.svelte";
  import ConfirmationDialog from "../ui/ConfirmationDialog.svelte";

  /**
   * Changes view for the desktop file-tree sidebar: a flat list of the
   * changed files (filename + dimmed directory) plus the commit zone. Each
   * row carries a right-aligned checkbox that stages/unstages the file —
   * there are no separate staged/unstaged sections. Clicking a file opens
   * the singleton Diff tab in the main zone (DESKTOP_OPEN_DIFF_TAB_EVENT)
   * rather than showing an inline diff — the sidebar stays narrow.
   */
  interface Props {
    worktreePath: string;
    /** Called whenever the status is (re)loaded, with the changed-file count. */
    onChangedCountChange?: (count: number) => void;
    focusRequest?: number;
  }

  let { worktreePath, onChangedCountChange, focusRequest = 0 }: Props = $props();

  // Desktop-only RPC surface used by the context menu (same helpers the file
  // tree's native menu uses).
  type DesktopChangesRPC = RPCClient & {
    revealPathInFinder(path: string): Promise<void>;
    trashPath(path: string): Promise<void>;
    openPathWithOpener(
      path: string,
      openerId: string,
      line?: number,
      column?: number,
    ): Promise<void>;
    showDesktopFileTreeContextMenu(request: DesktopFileTreeContextMenuRequest): Promise<void>;
    getDesktopSettings(): Promise<DesktopChangesSettings>;
  };
  const desktopRpc = rpc as DesktopChangesRPC;

  interface DesktopChangesSettings {
    fileOpenerId: string;
    fileOpeners: DesktopFileTreeContextMenuOpener[];
    desktopOpeners: DesktopFileTreeContextMenuOpener[];
  }

  const DESKTOP_FILE_TREE_CONTEXT_MENU_ACTION_EVENT =
    "camber:desktop-file-tree-context-menu-action";

  type LoadState =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; git: GitStatusOutput };

  let loadState = $state<LoadState>({ status: "loading" });
  let loadToken = 0;
  let commitMessage = $state("");
  let commitSubjectRemaining = $derived(commitSubjectCharactersRemaining(commitMessage));
  let commitMessageElement = $state<HTMLTextAreaElement>();
  let handledFocusRequest = 0;
  let actionError = $state<string | undefined>(undefined);
  let actionBusy = $state(false);
  // File awaiting selection once the status list is (re)loaded — set by the
  // file tree's "Review Diff..." bridge (desktopChangesFileSelection).
  let pendingSelection: string | undefined;
  // File awaiting discard confirmation from the native context menu, which
  // cannot host a two-step confirm itself. Staged files are unstaged first so
  // the discard reverts the file all the way to its last committed state.
  let pendingMenuDiscard = $state<{ file: GitFileChange; staged: boolean } | undefined>(undefined);

  $effect(() => {
    const request = focusRequest;
    const element = commitMessageElement;
    if (!request || !element || request === handledFocusRequest) return;
    handledFocusRequest = request;
    element.focus({ preventScroll: true });
  });

  // ---- Flat changed-files list ---------------------------------------------
  // One row per changed path — no staged/unstaged sections. The right-aligned
  // checkbox stages/unstages the file; a partially staged file (in both the
  // index and the working tree) shows an indeterminate checkbox and clicking
  // it stages the remaining working-tree changes.

  interface ChangedRow {
    path: string;
    /** Working-tree record when present, else the staged record. */
    file: GitFileChange;
    /** Fully staged — checkbox checked. */
    staged: boolean;
    /** In both the index and the working tree — checkbox indeterminate. */
    partial: boolean;
  }

  // Row highlighted as selected (last clicked / Review Diff bridge target).
  let selectedPath = $state<string | undefined>(undefined);

  function changedRows(git: GitStatusOutput): ChangedRow[] {
    const staged = new Set(git.staged.map((file) => file.path));
    const rows = new Map<string, ChangedRow>();
    for (const file of [...git.unstaged, ...git.untracked]) {
      rows.set(file.path, {
        path: file.path,
        file,
        staged: false,
        partial: staged.has(file.path),
      });
    }
    for (const file of git.staged) {
      if (!rows.has(file.path)) {
        rows.set(file.path, { path: file.path, file, staged: true, partial: false });
      }
    }
    return Array.from(rows.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  function toggleRow(row: ChangedRow): void {
    if (actionBusy) return;
    // Unchecked and partially staged rows stage the (remaining) working-tree
    // changes; only a fully staged row unstages.
    if (row.staged) {
      unstageFile(row.file);
    } else {
      stageFile(row.file);
    }
  }

  const REFRESH_DEBOUNCE_MS = 750;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  function totalChanges(git: GitStatusOutput): number {
    return git.staged.length + git.unstaged.length + git.untracked.length;
  }

  function applyStatus(git: GitStatusOutput): void {
    loadState = { status: "ready", git };
    cacheStatus(worktreePath, git);
    onChangedCountChange?.(git.isRepo ? totalChanges(git) : 0);
    consumePendingSelection(git);
  }

  /**
   * Selects (and opens the diff for) the file the "Review Diff..." bridge asked
   * for, once it appears in the loaded status. Prefers the unstaged row when
   * a file is partially staged.
   */
  function consumePendingSelection(git: GitStatusOutput): void {
    if (!pendingSelection) return;
    const path = pendingSelection;
    const unstagedMatch = [...git.unstaged, ...git.untracked].find((file) => file.path === path);
    const match = unstagedMatch ?? git.staged.find((file) => file.path === path);
    pendingSelection = undefined;
    if (!match) return;
    selectedPath = match.path;
    openDiff(match);
  }

  async function load(path: string, options: { silent?: boolean } = {}): Promise<void> {
    const token = ++loadToken;
    if (!options.silent) {
      loadState = { status: "loading" };
    }
    try {
      const git = await camberGitStatus({ path });
      if (token !== loadToken) return;
      applyStatus(git);
    } catch (error) {
      if (token !== loadToken) return;
      // A failed background refresh keeps the last usable list on screen
      // (e.g. helper restarting mid-burst); only replace the UI with the
      // error state when there is nothing better to show.
      if (options.silent && loadState.status === "ready") return;
      loadState = {
        status: "error",
        message: extractErrorMessage(error, "Failed to load git status"),
      };
    }
  }

  function scheduleSilentRefresh(): void {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void load(worktreePath, { silent: true });
    }, REFRESH_DEBOUNCE_MS);
  }

  $effect(() => {
    const path = worktreePath;
    untrack(() => {
      actionError = undefined;
      pendingMenuDiscard = undefined;
      selectedPath = undefined;
      pendingSelection = takePendingDesktopChangesFileSelection();
      // Render the last known status immediately (no spinner flash on
      // remount) and refresh silently underneath.
      const cached = lastKnownStatusByWorktree.get(path);
      if (cached) {
        loadState = { status: "ready", git: cached };
        void load(path, { silent: true });
      } else {
        void load(path);
      }
    });
  });

  $effect(() => {
    const onGitChanged = () => void load(worktreePath, { silent: true });
    const onFileTreeChanged = () => scheduleSilentRefresh();
    const onSelectFile = (event: Event) => {
      const detail = (event as CustomEvent<DesktopChangesSelectFileEventDetail>).detail;
      if (!detail?.relativePath) return;
      pendingSelection = detail.relativePath;
      if (loadState.status === "ready") consumePendingSelection(loadState.git);
    };
    window.addEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
    window.addEventListener(DESKTOP_FILE_TREE_CHANGED_EVENT, onFileTreeChanged);
    window.addEventListener(DESKTOP_CHANGES_SELECT_FILE_EVENT, onSelectFile);
    return () => {
      window.removeEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
      window.removeEventListener(DESKTOP_FILE_TREE_CHANGED_EVENT, onFileTreeChanged);
      window.removeEventListener(DESKTOP_CHANGES_SELECT_FILE_EVENT, onSelectFile);
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  });

  // Grace delay before a single click opens the diff so a double-click
  // (stage/unstage) never opens a tab or steals focus mid-gesture.
  const CLICK_GRACE_MS = 250;
  let pendingClickTimer: ReturnType<typeof setTimeout> | undefined;

  function handleRowClick(row: ChangedRow): void {
    selectedPath = row.path;
    cancelPendingClick();
    pendingClickTimer = setTimeout(() => {
      pendingClickTimer = undefined;
      // Rows open the file's diff so clicking down the list jumps between
      // diffs; the full file stays reachable via the context menu's Open.
      openDiff(row.file);
    }, CLICK_GRACE_MS);
  }

  function handleRowDoubleClick(row: ChangedRow): void {
    cancelPendingClick();
    toggleRow(row);
  }

  function cancelPendingClick(): void {
    if (pendingClickTimer !== undefined) {
      clearTimeout(pendingClickTimer);
      pendingClickTimer = undefined;
    }
  }

  $effect(() => cancelPendingClick);

  /**
   * Opens the singleton Diff tab (all changed files); when a file is given
   * its diff is scrolled into view.
   */
  function openDiff(file?: GitFileChange): void {
    window.dispatchEvent(
      new CustomEvent<DesktopOpenDiffTabEventDetail>(DESKTOP_OPEN_DIFF_TAB_EVENT, {
        detail: {
          worktreePath,
          relativePath: file?.path,
        },
      }),
    );
  }

  async function runAction(action: () => Promise<GitStatusOutput>): Promise<void> {
    if (actionBusy) return;
    actionBusy = true;
    actionError = undefined;
    try {
      applyStatus(await action());
      // Other surfaces (footer summary, Changes panel, Diff tab) refresh too.
      window.dispatchEvent(new CustomEvent(DESKTOP_GIT_CHANGED_EVENT));
    } catch (error) {
      actionError = extractErrorMessage(error, "Git operation failed");
    } finally {
      actionBusy = false;
    }
  }

  function stageFile(file: GitFileChange): void {
    void runAction(() => camberGitStage({ path: worktreePath, files: [file.path] }));
  }

  function unstageFile(file: GitFileChange): void {
    void runAction(() => camberGitUnstage({ path: worktreePath, files: [file.path] }));
  }

  function performDiscard(file: GitFileChange, staged: boolean): void {
    const untracked = file.status === "untracked";
    void runAction(async () => {
      // A staged file is unstaged first so the discard restores the last
      // committed state, not the staged snapshot.
      if (staged) {
        await camberGitUnstage({ path: worktreePath, files: [file.path] });
      }
      return camberGitDiscard({
        path: worktreePath,
        files: untracked ? [] : [file.path],
        untrackedFiles: untracked ? [file.path] : [],
      });
    });
  }

  function stageAll(git: GitStatusOutput): void {
    const files = [...git.unstaged, ...git.untracked].map((file) => file.path);
    if (files.length === 0) return;
    void runAction(() => camberGitStage({ path: worktreePath, files }));
  }

  function unstageAll(git: GitStatusOutput): void {
    const files = git.staged.map((file) => file.path);
    if (files.length === 0) return;
    void runAction(() => camberGitUnstage({ path: worktreePath, files }));
  }

  function commit(git: GitStatusOutput): void {
    const message = commitMessage.trim();
    // Mirror the commit button's guards — this is also reachable via ⌘⏎ in
    // the message textarea.
    if (!message || git.staged.length === 0 || actionBusy) return;
    void runAction(async () => {
      const refreshed = await camberGitCommit({ path: worktreePath, message });
      commitMessage = "";
      return refreshed;
    });
  }

  function absolutePath(file: GitFileChange): string {
    const root = worktreePath.endsWith("/") ? worktreePath.slice(0, -1) : worktreePath;
    return `${root}/${file.path}`;
  }

  function openFile(file: GitFileChange): void {
    window.dispatchEvent(
      new CustomEvent(DESKTOP_OPEN_FILE_TAB_EVENT, {
        detail: { path: absolutePath(file) },
      }),
    );
  }

  // Live context-menu listeners, so unmount (worktree switch, tab close)
  // detaches them instead of leaving a menu action targeting a dead instance.
  const menuCleanups = new Set<() => void>();
  $effect(() => () => {
    for (const cleanup of [...menuCleanups]) cleanup();
  });

  /**
   * Opens the native desktop context menu for a changed file — same RPC path
   * as the regular file tree, so it renders reliably above the webview.
   */
  async function openContextMenu(
    event: MouseEvent,
    file: GitFileChange,
    staged: boolean,
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    const requestId = crypto.randomUUID();
    const deleted = file.status === "deleted";
    const added = file.status === "added" || file.status === "untracked";

    const onAction = (actionEvent: Event) => {
      const payload = (actionEvent as CustomEvent<DesktopFileTreeContextMenuActionPayload>).detail;
      if (payload.requestId !== requestId) return;
      cleanup();
      void performContextMenuAction(payload, file, staged);
    };

    const cleanup = () => {
      menuCleanups.delete(cleanup);
      window.clearTimeout(timeout);
      window.removeEventListener(DESKTOP_FILE_TREE_CONTEXT_MENU_ACTION_EVENT, onAction);
    };
    menuCleanups.add(cleanup);
    const timeout = window.setTimeout(cleanup, 30_000);
    window.addEventListener(DESKTOP_FILE_TREE_CONTEXT_MENU_ACTION_EVENT, onAction);

    try {
      const settings = await desktopRpc.getDesktopSettings();
      await desktopRpc.showDesktopFileTreeContextMenu({
        requestId,
        item: {
          kind: "file",
          hasGitChanges: true,
          changesContext: { staged, deleted, added },
        },
        position: { x: event.clientX, y: event.clientY },
        currentOpenerId: settings.fileOpenerId || "default",
        fileOpeners: settings.fileOpeners ?? [],
        desktopOpeners: settings.desktopOpeners ?? [],
      });
    } catch (error) {
      cleanup();
      rpc.showInfoMessage(
        `Unable to show file menu: ${getUnknownErrorMessage(error)}`,
        InfoMessageType.error,
      );
    }
  }

  async function performContextMenuAction(
    payload: DesktopFileTreeContextMenuActionPayload,
    file: GitFileChange,
    staged: boolean,
  ): Promise<void> {
    try {
      switch (payload.action) {
        case "open":
          openFile(file);
          return;
        case "openWith":
          if (!payload.openerId) return;
          await desktopRpc.openPathWithOpener(absolutePath(file), payload.openerId);
          return;
        case "gitStage":
          stageFile(file);
          return;
        case "gitUnstage":
          unstageFile(file);
          return;
        case "gitDiscard":
          // Destructive — reverts the file to its last committed state — and
          // the native menu cannot host a two-step confirm, so ask via an
          // in-app dialog instead.
          pendingMenuDiscard = { file, staged };
          return;
        case "delete":
          await desktopRpc.trashPath(absolutePath(file));
          // Other git surfaces (footer summary, Diff tab) and this list
          // refresh to drop / re-status the trashed file.
          window.dispatchEvent(new CustomEvent(DESKTOP_GIT_CHANGED_EVENT));
          return;
        case "addFileToChat":
          requestDesktopFilePromptChip(absolutePath(file));
          return;
        case "revealInFinder":
          await desktopRpc.revealPathInFinder(absolutePath(file));
          return;
        case "openInTerminal":
          rpc.openTerminal(undefined, fileDirAbsolute(file));
          return;
        case "copyPath":
          await rpc.writeToClipboard(absolutePath(file));
          return;
        case "copyRelativePath":
          await rpc.writeToClipboard(file.path);
          return;
        default:
          return;
      }
    } catch (error) {
      rpc.showInfoMessage(
        `File action failed: ${getUnknownErrorMessage(error)}`,
        InfoMessageType.error,
      );
    }
  }

  /** Absolute directory containing the file (for "Open in Terminal"). */
  function fileDirAbsolute(file: GitFileChange): string {
    const abs = absolutePath(file);
    const index = abs.lastIndexOf("/");
    return index > 0 ? abs.slice(0, index) : abs;
  }

  function statusLetter(status: string): string {
    switch (status) {
      case "modified":
        return "M";
      case "added":
        return "A";
      case "deleted":
        return "D";
      case "renamed":
        return "R";
      case "copied":
        return "C";
      case "typechange":
        return "T";
      case "untracked":
        // Untracked reads as "added" for users, matching the diff panel badge.
        return "A";
      case "unmerged":
        return "!";
      default:
        return "?";
    }
  }

  function statusClass(status: string): string {
    switch (status) {
      case "added":
      case "untracked":
        return "is-added";
      case "deleted":
        return "is-deleted";
      case "unmerged":
        return "is-conflict";
      case "renamed":
      case "copied":
        return "is-renamed";
      default:
        return "is-modified";
    }
  }

  /** Same wording as the file tree's built-in letter tooltips (@pierre/trees). */
  function statusTitle(status: string): string {
    switch (status) {
      case "modified":
        return "Git status: modified";
      case "added":
      // Untracked files read as added throughout (letter "A", like the tree).
      case "untracked":
        return "Git status: added";
      case "deleted":
        return "Git status: deleted";
      case "renamed":
        return "Git status: renamed";
      case "copied":
        return "Git status: copied";
      case "typechange":
        return "Git status: type changed";
      case "unmerged":
        return "Git status: conflict";
      default:
        return "Git status: changed";
    }
  }

  function fileName(path: string): string {
    const index = path.lastIndexOf("/");
    return index >= 0 ? path.slice(index + 1) : path;
  }

  function fileDir(path: string): string {
    const index = path.lastIndexOf("/");
    return index >= 0 ? path.slice(0, index) : "";
  }

  function rowTooltip(row: ChangedRow): string {
    const rename = row.file.origPath ? `\n${row.file.origPath} → ${row.path}` : "";
    const staging = row.staged ? "staged" : row.partial ? "partially staged" : "not staged";
    return `${row.path}${rename}\n${staging} · click to view diff`;
  }

  function checkboxLabel(row: ChangedRow): string {
    if (row.staged) return `Unstage ${row.path}`;
    if (row.partial) return `Stage remaining changes to ${row.path}`;
    return `Stage ${row.path}`;
  }
</script>

<div class="changes-list" tabindex="-1">
  {#if loadState.status === "loading"}
    <div class="changes-list-centered">
      <Spinner size={16} />
    </div>
  {:else if loadState.status === "error"}
    <div class="changes-list-centered changes-list-message">
      <Icon name="alert" size={16} class="text-psx-error-foreground" />
      <p>{loadState.message}</p>
      <button type="button" class="changes-list-button" onclick={() => load(worktreePath)}>
        Retry
      </button>
    </div>
  {:else if !loadState.git.isRepo}
    <div class="changes-list-centered changes-list-message">
      <Icon name="git-branch" size={18} class="text-psx-foreground-tertiary" />
      <p>{loadState.git.gitMissing ? "Git is not installed." : "Not a git repository."}</p>
    </div>
  {:else}
    {@const git = loadState.git}
    {@const workingCount = git.unstaged.length + git.untracked.length}
    {@const changedCount = totalChanges(git)}
    {#if actionError}
      <div class="changes-list-action-error" role="alert">
        <Icon name="alert" size={12} />
        <span>{actionError}</span>
        <button
          type="button"
          class="changes-list-icon-button"
          aria-label="Dismiss error"
          onclick={() => (actionError = undefined)}
        >
          <Icon name="cross" size={10} />
        </button>
      </div>
    {/if}

    {#if changedCount > 0}
      <div class="changes-list-toolbar">
        <button
          type="button"
          class="changes-list-toolbar-button changes-list-open-diff"
          title="Review Diff..."
          onclick={() => openDiff()}
        >
          <Icon name="diff" size={12} />
          Review Diff...
        </button>
        {#if workingCount > 0}
          <!-- One bulk button: staging wins until everything is staged. -->
          <button type="button" class="changes-list-toolbar-button" onclick={() => stageAll(git)}>
            Stage All
          </button>
        {:else if git.staged.length > 0}
          <button type="button" class="changes-list-toolbar-button" onclick={() => unstageAll(git)}>
            Unstage All
          </button>
        {/if}
      </div>
    {/if}

    {#if changedCount === 0}
      <div class="changes-list-centered changes-list-message">
        <p>Working tree clean.</p>
      </div>
    {:else}
      <div class="changes-list-scroll">
        <ul class="changes-list-files">
          {#each changedRows(git) as row (row.path)}
            <li class="changes-list-file" class:is-selected={selectedPath === row.path}>
              <button
                type="button"
                class="changes-list-file-main"
                onclick={() => handleRowClick(row)}
                ondblclick={() => handleRowDoubleClick(row)}
                onkeydown={(event) => {
                  // Space toggles staging from the keyboard; Enter keeps the
                  // default click → open diff.
                  if (event.key === " ") {
                    event.preventDefault();
                    toggleRow(row);
                  }
                }}
                oncontextmenu={(event) => openContextMenu(event, row.file, row.staged)}
                title={rowTooltip(row)}
              >
                <span class="changes-list-file-icon">
                  <Icon type="file" name={row.path} size={16} />
                </span>
                <span
                  class="changes-list-file-name"
                  class:is-deleted-name={row.file.status === "deleted"}
                >
                  {fileName(row.path)}
                </span>
                {#if fileDir(row.path)}
                  <span class="changes-list-file-dir">{fileDir(row.path)}</span>
                {/if}
                <span
                  class={["changes-list-file-status", statusClass(row.file.status)]}
                  title={statusTitle(row.file.status)}
                >
                  {statusLetter(row.file.status)}
                </span>
              </button>
              <input
                type="checkbox"
                class="changes-list-file-checkbox"
                checked={row.staged}
                indeterminate={row.partial}
                aria-label={checkboxLabel(row)}
                title={checkboxLabel(row)}
                onclick={(event) => {
                  // Controlled: the checkbox reflects the loaded git status,
                  // never an optimistic flip that a failed action would strand.
                  event.preventDefault();
                  toggleRow(row);
                }}
              />
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <footer class="changes-list-commit">
      <GitBranchTrackingLabel
        branch={git.detached ? "(detached)" : git.branch}
        upstream={git.upstream}
      />
      <div class="changes-list-commit-message-field">
        <textarea
          bind:this={commitMessageElement}
          class="changes-list-commit-message"
          data-desktop-commit-message
          placeholder="Commit message (⌘⏎ to commit)"
          rows="2"
          bind:value={commitMessage}
          onkeydown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              commit(git);
            }
          }}
        ></textarea>
        {#if commitMessage.length > 0}
          <span
            class="changes-list-commit-character-count"
            aria-label={`${commitSubjectRemaining} characters remaining in the commit subject`}
          >
            {commitSubjectRemaining}
          </span>
        {/if}
      </div>
      <button
        type="button"
        class="changes-list-button changes-list-commit-button"
        disabled={actionBusy || git.staged.length === 0 || !commitMessage.trim()}
        onclick={() => commit(git)}
      >
        <Icon name="git-commit" size={12} />
        Commit {git.staged.length > 0 ? `${git.staged.length} staged` : ""}
      </button>
    </footer>
  {/if}
</div>

{#if pendingMenuDiscard}
  {@const discardTarget = pendingMenuDiscard}
  <ConfirmationDialog
    destructive
    title="Discard local changes?"
    description={`Do you really want to revert “${fileName(discardTarget.file.path)}” to its last committed state? All uncommitted changes will be lost.`}
    confirmLabel="Discard Changes"
    onCancel={() => (pendingMenuDiscard = undefined)}
    onConfirm={() => {
      // Read before clearing: `discardTarget` derives from
      // `pendingMenuDiscard`, so it is gone once the state resets.
      const { file, staged } = discardTarget;
      pendingMenuDiscard = undefined;
      performDiscard(file, staged);
    }}
  />
{/if}

<style>
  .changes-list {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-size: 12px;
    color: var(--psx-foreground-primary);
    outline: none;
  }

  .changes-list-centered {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
  }

  .changes-list-message {
    color: var(--psx-foreground-secondary);
    text-align: center;
  }

  .changes-list-message p {
    margin: 0;
  }

  .changes-list-toolbar {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    /* Matches the file rows' 12px content inset (4px hover-pill margin + 8px
       main-button padding), so the toolbar's edges line up with the rows. */
    padding: 4px 12px 2px;
  }

  /* Secondary-style toolbar buttons: same bordered treatment as
     .changes-list-button (Retry/Commit) at a compact 22px height. */
  .changes-list-toolbar-button {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--psx-border);
    border-radius: 5px;
    background: transparent;
    color: var(--psx-foreground-secondary);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .changes-list-toolbar-button:hover:not(:disabled) {
    background: var(--psx-menu-hover-background);
    color: var(--psx-foreground-primary);
  }

  /* Review Diff sits in the top-left corner of the toolbar; the bulk
     stage/unstage action keeps its right-aligned spot. */
  .changes-list-open-diff {
    margin-right: auto;
  }

  .changes-list-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 2px 0;
  }

  .changes-list-files {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* Row metrics mirror the All files tree rows: 26px rows with 26px line
     height, inset 4px with a 6px-radius hover pill, 16px icon, 6px gap. */
  .changes-list-file {
    position: relative;
    display: flex;
    align-items: center;
    height: 26px;
    margin: 0 4px;
    border-radius: 6px;
    line-height: 26px;
    /* Rows are click/double-click targets — never text to highlight. The
       -webkit- prefix is what the desktop app's WebKit webview honours. */
    -webkit-user-select: none;
    user-select: none;
  }

  .changes-list-file:hover,
  .changes-list-file.is-selected {
    background: var(--psx-menu-hover-background);
  }

  .changes-list-file-main {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 100%;
    padding: 0 4px 0 8px;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .changes-list-file-icon {
    display: inline-flex;
    flex-shrink: 0;
    width: 16px;
    justify-content: center;
  }

  .changes-list-file-name {
    flex-shrink: 0;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .changes-list-file-name.is-deleted-name {
    text-decoration: line-through;
    color: var(--psx-foreground-tertiary);
  }

  .changes-list-file-dir {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    color: var(--psx-foreground-tertiary);
  }

  /* Same badge treatment as the main panel diff view (PatchDiff): letter on
     a rounded tint of its own colour. margin-left: auto keeps the badge at
     the right edge even for root-level files, which render no directory span
     (the flex-filling element that otherwise pushes it right). */
  .changes-list-file-status {
    flex-shrink: 0;
    margin-left: auto;
    padding: 3px 6px;
    border-radius: 5px;
    font-size: 10px;
    font-weight: 600;
    line-height: normal;
    background: color-mix(in srgb, currentColor 12%, transparent);
  }

  .changes-list-file-status.is-added {
    color: var(--psx-diff-insert-foreground, #4fb262);
  }

  .changes-list-file-status.is-deleted {
    color: var(--psx-error-foreground, #e5534b);
  }

  .changes-list-file-status.is-modified {
    /* Same blue as the main panel diff view's "modified" badge (PatchDiff). */
    color: var(--psx-info-foreground, #1a85ff);
  }

  .changes-list-file-status.is-renamed,
  .changes-list-file-status.is-conflict {
    color: var(--psx-foreground-secondary);
  }

  .changes-list-file-checkbox {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    margin: 0 8px 0 2px;
    accent-color: var(--psx-focus);
    cursor: pointer;
  }

  .changes-list-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--psx-foreground-secondary);
    cursor: pointer;
  }

  .changes-list-icon-button:hover:not(:disabled) {
    background: var(--psx-menu-hover-background);
    color: var(--psx-foreground-primary);
  }

  .changes-list-icon-button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .changes-list-action-error {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 8px 0;
    padding: 4px 6px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--psx-error-foreground, #e5534b) 12%, transparent);
    color: var(--psx-error-foreground, #e5534b);
    font-size: 11px;
  }

  .changes-list-action-error span {
    flex: 1;
    min-width: 0;
    /* Git errors (hook output, checkout conflicts) are multi-line and the
       user needs to read and copy them in full. */
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 96px;
    overflow-y: auto;
    user-select: text;
  }

  .changes-list-commit {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--psx-border);
  }

  .changes-list-commit-message-field {
    position: relative;
    width: 100%;
  }

  .changes-list-commit-message {
    display: block;
    width: 100%;
    resize: vertical;
    min-height: 34px;
    max-height: 120px;
    padding: 5px 42px 5px 7px;
    border: 1px solid var(--psx-border);
    border-radius: 6px;
    background: transparent;
    color: var(--psx-foreground-primary);
    font: inherit;
    font-size: 12px;
  }

  .changes-list-commit-message:focus {
    outline: 1px solid var(--psx-focus);
    outline-offset: -1px;
  }

  .changes-list-commit-character-count {
    position: absolute;
    top: 7px;
    right: 8px;
    color: var(--psx-foreground-tertiary);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    pointer-events: none;
  }

  .changes-list-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--psx-border);
    border-radius: 6px;
    background: transparent;
    color: var(--psx-foreground-primary);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .changes-list-button:hover:not(:disabled) {
    background: var(--psx-menu-hover-background);
  }

  .changes-list-button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .changes-list-commit-button:not(:disabled) {
    background: var(--psx-button-primary-background, var(--psx-focus));
    border-color: var(--psx-button-primary-border, transparent);
    color: var(--psx-button-primary-foreground, #fff);
  }

  .changes-list-commit-button:not(:disabled):hover {
    background: var(--psx-button-primary-hover-background, var(--psx-focus));
    border-color: var(--psx-button-primary-hover-border, transparent);
  }
</style>
