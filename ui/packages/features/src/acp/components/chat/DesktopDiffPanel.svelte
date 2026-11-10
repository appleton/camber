<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import {
    camberGitDiffClose,
    camberGitDiffOpen,
    camberGitDiffStats,
    camberGitStatus,
    type GitDiffOpenOutput,
    type GitDiffScope,
    type GitDiffStats as GitDiffStatsValue,
    type GitStatusOutput,
  } from "@camber/helperapi";
  import { onDestroy, untrack } from "svelte";
  import { extractErrorMessage } from "../../errors";
  import {
    DESKTOP_FILE_TREE_CHANGED_EVENT,
    DESKTOP_GIT_CHANGED_EVENT,
    type DesktopFileTreeChangedEventDetail,
  } from "../../features/DesktopGitChangesState.svelte";
  import { diffLayoutPreference } from "../shared/diffLayoutPreference.svelte";
  import SegmentedSwitch from "../ui/SegmentedSwitch.svelte";
  import { DESKTOP_OPEN_FILE_TAB_EVENT } from "./desktopCommandPicker";
  import { requestDesktopChangesView } from "./desktopChangesViewRequest";
  import GitDiffStats from "./GitDiffStats.svelte";
  import GitBranchTrackingLabel from "./GitBranchTrackingLabel.svelte";
  import DesktopDiffDocument from "./DesktopDiffDocument.svelte";
  import DesktopDiffEmptyState from "./DesktopDiffEmptyState.svelte";

  /**
   * All-files git diff shown in the main zone's singleton Diff tab. File
   * summaries and bounded patch chunks stream into one virtual document, so
   * opening the tab never materializes the complete worktree patch.
   */
  interface Props {
    worktreePath: string;
    /** File whose diff to scroll into view, when opened from a file row. */
    relativePath?: string;
    /** Bumped for every open request so re-clicking the same file re-scrolls. */
    openToken: number;
  }

  type DiffDocumentController = ReturnType<typeof DesktopDiffDocument>;

  let { worktreePath, relativePath, openToken }: Props = $props();

  /** Which changes the combined diff covers. */
  let scope = $state<GitDiffScope>("uncommitted");

  const SCOPE_OPTIONS: { value: GitDiffScope; label: string }[] = [
    { value: "uncommitted", label: "All Uncommitted" },
    { value: "staged", label: "Staged" },
    { value: "unstaged", label: "Unstaged" },
  ];

  let diffState = $state<
    | { status: "loading" }
    | { status: "unavailable"; gitMissing: boolean }
    | { status: "error"; message: string }
    | { status: "ready"; diff: GitDiffOpenOutput }
  >({ status: "loading" });
  let diffToken = 0;

  /**
   * A mounted diff document. At most two exist at once: the displayed one
   * and — during a scope switch — a hidden incoming one that settles
   * off-screen and then replaces the displayed one in a single swap, so
   * updates never show a loading state over existing content. Silent
   * reloads don't add an entry at all; the newest entry adopts the new
   * sessionId in place (same scroll position, same rows, only genuinely
   * changed content re-renders).
   */
  interface DiffEntry {
    /** Identity for the keyed render — a new epoch mounts a new document. */
    epoch: number;
    diff: GitDiffOpenOutput;
    ref?: DiffDocumentController;
    /** Last collapsed-card count this document reported. */
    collapsedCount: number;
  }
  let diffEntries = $state<DiffEntry[]>([]);
  let displayedEpoch = $state(0);
  let documentEpoch = 0;
  // Session of an empty-diff result: no entry owns it, but the stats poll
  // still reads it, so it is closed on the next result or on destroy.
  let looseSessionId: string | undefined;
  const displayedDocument = $derived(
    diffEntries.find((entry) => entry.epoch === displayedEpoch)?.ref,
  );
  let diffStats = $state<GitDiffStatsValue>();
  let statsPollTimer: ReturnType<typeof setTimeout> | undefined;
  let fileRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const FILE_REFRESH_DEBOUNCE_MS = 750;
  // Collapsed-card count reported by the virtual document; drives the footer's
  // Expand All / Collapse All toggle.
  let collapsedCount = $state(0);

  // Branch info for the header, refreshed alongside every diff load. Kept
  // undefined until known so the header shows nothing rather than stale data.
  let gitStatus = $state<GitStatusOutput | undefined>(undefined);
  let branchLabel = $derived.by(() => {
    const git = gitStatus;
    if (!git?.isRepo) return "";
    return git.detached ? "(detached)" : git.branch;
  });

  let scopeLabel = $derived(
    SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? "Changes",
  );
  // Expand All whenever any card is collapsed; Collapse All only when every
  // card is expanded (matching the reference design's toggle).
  let anyCollapsed = $derived(collapsedCount > 0);
  // Hides the body while the very first document (or a replacement after
  // an error/worktree change) settles behind the gate — the only time a
  // spinner shows. Updates over existing content (silent reloads, scope
  // switches) never fade: the old diff stays visible until the incoming
  // one is ready, then the swap is instant.
  let bodyFaded = $state(false);
  let visibleDiffStats = $derived(bodyFaded ? undefined : diffStats);
  let canToggleAll = $derived(
    diffState.status === "ready" && !bodyFaded && (visibleDiffStats?.files ?? 0) > 0,
  );

  /** Refreshes the header's branch info; failures just leave it hidden. */
  function loadBranch(): void {
    const path = worktreePath;
    if (!path) return;
    void camberGitStatus({ path })
      .then((git) => {
        if (path !== worktreePath) return;
        gitStatus = git;
      })
      .catch(() => {
        if (path !== worktreePath) return;
        gitStatus = undefined;
      });
  }

  // Session the current diffStats were computed for: per-file stats are
  // only applied to the document mounted for that session — feeding an
  // outgoing scope's stats into the incoming document would seed wrong
  // badges and height estimates during the settle window.
  let diffStatsSessionId: string | undefined;

  function acceptStats(stats: GitDiffStatsValue, sessionId: string): void {
    diffStats = stats;
    diffStatsSessionId = sessionId;
    const entry = diffEntries.find((candidate) => candidate.diff.sessionId === sessionId);
    entry?.ref?.applyFileStats(stats.fileStats ?? []);
  }

  /** Closes every mounted document's session and unmounts them. */
  function closeAllEntries(): void {
    for (const entry of diffEntries) closeSession(entry.diff.sessionId);
    diffEntries = [];
    displayedEpoch = 0;
  }

  /** Takes ownership of a session no document entry owns (empty diffs). */
  function adoptLooseSession(sessionId: string | undefined): void {
    if (looseSessionId && looseSessionId !== sessionId) closeSession(looseSessionId);
    looseSessionId = sessionId;
  }

  async function load(options: { silent?: boolean; seamless?: boolean } = {}): Promise<void> {
    // Empty only transiently, while a stale tab's content is being torn down
    // (see desktopTabContent in DesktopSplitsPane): skip the doomed fetch.
    if (!worktreePath) return;
    const token = ++diffToken;
    loadBranch();
    // Seamless reloads (scope switches) keep the displayed diff fully
    // visible and interactive while the replacement settles off-screen;
    // silent reloads (a git mutation elsewhere invalidated this diff)
    // reconcile into the displayed document. Neither shows a loading
    // state. Everything else — initial load, worktree change, retry —
    // replaces the pane with a spinner because there is no valid content
    // to keep.
    const seamless = options.seamless && diffEntries.length > 0;
    if (!options.silent && !seamless) {
      diffState = { status: "loading" };
      diffStats = undefined;
      collapsedCount = 0;
      bodyFaded = false;
      closeAllEntries();
    }
    try {
      const result = await camberGitDiffOpen({
        path: worktreePath,
        scope,
        targetPath: relativePath,
      });
      if (token !== diffToken) {
        if (result.sessionId) closeSession(result.sessionId);
        return;
      }
      if (result.unavailable) {
        diffState = { status: "unavailable", gitMissing: result.gitMissing ?? false };
        diffStats = undefined;
        collapsedCount = 0;
        bodyFaded = false;
        closeAllEntries();
        adoptLooseSession(undefined);
        return;
      }
      diffState = { status: "ready", diff: result };
      if (result.stats) acceptStats(result.stats, result.sessionId);
      else scheduleStatsPoll(result.sessionId, token);

      const emptyDiff = result.complete && result.files.length === 0 && !result.target;
      if (emptyDiff) {
        // The static empty state replaces any mounted documents directly.
        closeAllEntries();
        adoptLooseSession(result.sessionId);
        if (!result.stats) diffStats = undefined;
        collapsedCount = 0;
        bodyFaded = false;
        return;
      }
      adoptLooseSession(undefined);

      const latest = diffEntries.at(-1);
      if (options.silent && latest) {
        // Adopt in place: the newest document (displayed, or an incoming
        // one still settling) reconciles the new session into its rows.
        const previousSession = latest.diff.sessionId;
        latest.diff = result;
        if (previousSession !== result.sessionId) closeSession(previousSession);
        return;
      }
      if (seamless) {
        // Replace any not-yet-settled incoming document, then mount the
        // new one hidden; handleEntryReady swaps it in when it settles.
        for (const entry of diffEntries) {
          if (entry.epoch !== displayedEpoch) closeSession(entry.diff.sessionId);
        }
        diffEntries = [
          ...diffEntries.filter((entry) => entry.epoch === displayedEpoch),
          { epoch: ++documentEpoch, diff: result, collapsedCount: 0 },
        ];
        return;
      }
      // Fresh pane (initial load, worktree change, retry, or a silent
      // reload arriving with nothing mounted): gate the document until it
      // settles so its first viewport streams at opacity 0 instead of
      // jumping headers around in front of the reader.
      const epoch = ++documentEpoch;
      diffEntries = [{ epoch, diff: result, collapsedCount: 0 }];
      displayedEpoch = epoch;
      collapsedCount = 0;
      consumedRevealToken = undefined;
      bodyFaded = true;
    } catch (error) {
      if (token !== diffToken) return;
      if ((options.silent || seamless) && diffState.status === "ready") return;
      diffStats = undefined;
      collapsedCount = 0;
      bodyFaded = false;
      closeAllEntries();
      adoptLooseSession(undefined);
      diffState = { status: "error", message: extractErrorMessage(error, "Failed to load diff") };
    }
  }

  function scheduleStatsPoll(sessionId: string, token: number, delay = 50): void {
    if (statsPollTimer !== undefined) clearTimeout(statsPollTimer);
    statsPollTimer = setTimeout(async () => {
      statsPollTimer = undefined;
      try {
        const result = await camberGitDiffStats({ sessionId });
        if (token !== diffToken || diffState.status !== "ready") return;
        if (diffState.diff.sessionId !== sessionId) return;
        if (result.ready && result.stats) {
          acceptStats(result.stats, sessionId);
        } else {
          scheduleStatsPoll(sessionId, token, Math.min(1_000, delay * 2));
        }
      } catch {
        // Totals are supplementary; the diff remains usable if polling fails.
      }
    }, delay);
  }

  function closeSession(sessionId: string): void {
    void camberGitDiffClose({ sessionId }).catch(() => undefined);
  }

  /**
   * A mounted document's first viewport has settled. For the displayed
   * document this lifts the initial-load gate; for a hidden incoming one
   * it triggers the swap — the outgoing document unmounts and the settled
   * replacement becomes visible in the same frame, with no loading state
   * in between.
   */
  function handleEntryReady(epoch: number): void {
    const entry = diffEntries.find((candidate) => candidate.epoch === epoch);
    if (!entry) return;
    if (entry.epoch !== displayedEpoch) {
      for (const outgoing of diffEntries) {
        if (outgoing.epoch !== entry.epoch) closeSession(outgoing.diff.sessionId);
      }
      diffEntries = [entry];
      displayedEpoch = entry.epoch;
      collapsedCount = entry.collapsedCount;
      consumedRevealToken = undefined;
      bodyFaded = false;
      return;
    }
    // The displayed document settled — but if the user already switched
    // scopes while it was gated, keep the gate up rather than flashing the
    // abandoned scope; the newer entry's ready performs the reveal.
    if (diffEntries.at(-1)?.epoch === entry.epoch) bodyFaded = false;
  }

  onDestroy(() => {
    diffToken++;
    if (statsPollTimer !== undefined) clearTimeout(statsPollTimer);
    if (fileRefreshTimer !== undefined) clearTimeout(fileRefreshTimer);
    closeAllEntries();
    adoptLooseSession(undefined);
  });

  $effect(() => {
    // Retargeting an existing tab does not invalidate its full patch. Reload
    // only when the worktree changes; scope and git mutations reload below.
    void worktreePath;
    untrack(() => void load());
  });

  let previousScope: GitDiffScope = "uncommitted";
  $effect(() => {
    // Scope switches keep the current diff fully visible while the new
    // scope's document settles hidden, then swap it in — no loading state
    // over existing content, and no triple-mounted scopes.
    const nextScope = scope;
    if (nextScope === previousScope) return;
    previousScope = nextScope;
    untrack(() => void load({ seamless: true }));
  });

  // The reveal consumes one openToken per mounted document (reset by
  // non-silent loads): a silent reload swaps diffState but must not yank
  // the scroll position back to the requested file.
  let consumedRevealToken = $state<number | undefined>(undefined);
  $effect(() => {
    // Scroll to the requested file once the diff has rendered — also when a
    // new open request retargets an already-loaded panel.
    const token = openToken;
    const path = relativePath;
    if (diffState.status !== "ready" || !path) return;
    const mountedDocument = displayedDocument;
    if (!mountedDocument || consumedRevealToken === token) return;
    consumedRevealToken = token;
    void mountedDocument.revealFile(path);
  });

  $effect(() => {
    // Re-applies stats when the owning document (re)binds its ref — only
    // to the entry whose session produced them, never across scopes.
    const latest = diffEntries.at(-1);
    if (!latest || latest.diff.sessionId !== diffStatsSessionId) return;
    latest.ref?.applyFileStats(diffStats?.fileStats ?? []);
  });

  $effect(() => {
    // In-app git actions refresh immediately. File-watcher events cover edits
    // made by the agent or an external editor; debounce those because one edit
    // often arrives as a burst of filesystem notifications.
    const onGitChanged = () => void load({ silent: true });
    const onFileTreeChanged = (event: Event) => {
      const detail = (event as CustomEvent<DesktopFileTreeChangedEventDetail>).detail;
      if (!fileTreeChangeAffectsWorktree(detail)) return;
      scheduleFileRefresh();
    };
    const onWindowFocus = () => scheduleFileRefresh();
    window.addEventListener(DESKTOP_FILE_TREE_CHANGED_EVENT, onFileTreeChanged);
    window.addEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener(DESKTOP_FILE_TREE_CHANGED_EVENT, onFileTreeChanged);
      window.removeEventListener(DESKTOP_GIT_CHANGED_EVENT, onGitChanged);
      window.removeEventListener("focus", onWindowFocus);
    };
  });

  function scheduleFileRefresh(): void {
    if (fileRefreshTimer !== undefined) clearTimeout(fileRefreshTimer);
    fileRefreshTimer = setTimeout(() => {
      fileRefreshTimer = undefined;
      void load({ silent: true });
    }, FILE_REFRESH_DEBOUNCE_MS);
  }

  function fileTreeChangeAffectsWorktree(
    detail: DesktopFileTreeChangedEventDetail | undefined,
  ): boolean {
    const changes = detail?.changes;
    if (!changes || changes.length === 0) return true;
    const root = normalizePath(worktreePath);
    return changes.some((change) => {
      if (!change.path) return true;
      const changed = normalizePath(change.path);
      return changed === root || changed.startsWith(`${root}/`);
    });
  }

  function normalizePath(path: string): string {
    let normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
    if (normalized.length > 1) normalized = normalized.replace(/\/+$/g, "");
    if (/^[A-Z]:\//.test(normalized)) {
      normalized = normalized[0].toLowerCase() + normalized.slice(1);
    }
    return normalized;
  }

  /** Opens the current version of a file in a regular editor tab. */
  function openFullFile(path: string): void {
    const root = worktreePath.endsWith("/") ? worktreePath.slice(0, -1) : worktreePath;
    window.dispatchEvent(
      new CustomEvent(DESKTOP_OPEN_FILE_TAB_EVENT, {
        detail: { path: `${root}/${path}` },
      }),
    );
  }
</script>

<div class="diff-panel">
  <header class="diff-panel-header">
    <!-- Equal flexible sides keep the scope switch centred: branch info at
         the left edge, the layout toggle at the right. -->
    <span class="diff-panel-header-side diff-panel-header-side--start">
      {#if branchLabel}
        <GitBranchTrackingLabel branch={branchLabel} upstream={gitStatus?.upstream} />
      {/if}
    </span>
    <SegmentedSwitch options={SCOPE_OPTIONS} bind:value={scope} ariaLabel="Diff scope" />
    <span class="diff-panel-header-side diff-panel-header-side--end">
      <button
        type="button"
        class="diff-panel-icon-button"
        class:is-active={diffLayoutPreference.current === "split"}
        title={diffLayoutPreference.current === "split" ? "Unified view" : "Side-by-side view"}
        aria-pressed={diffLayoutPreference.current === "split"}
        aria-label={diffLayoutPreference.current === "split"
          ? "Switch to unified diff view"
          : "Switch to side-by-side diff view"}
        onclick={() => diffLayoutPreference.toggle()}
      >
        <Icon name="compare" size={14} />
      </button>
    </span>
  </header>

  <!-- Overlaid on the gated (hidden) body while the first document
       settles, so the pane shows a spinner rather than a blank. Updates
       over existing content never fade the body, so this never covers a
       visible diff. -->
  {#if bodyFaded}
    <div class="diff-panel-fade-spinner" aria-live="polite" aria-label="Loading diff">
      <Spinner size={16} />
    </div>
  {/if}

  <div class="diff-panel-body" class:is-faded={bodyFaded}>
    {#if diffState.status === "loading" && diffEntries.length === 0}
      <div class="diff-panel-centered">
        <Spinner size={16} />
      </div>
    {:else if diffState.status === "unavailable"}
      <div class="diff-panel-centered diff-panel-message">
        <Icon name="git-branch" size={18} class="text-psx-foreground-tertiary" />
        <p>{diffState.gitMissing ? "Git is not installed." : "Not a git repository."}</p>
      </div>
    {:else if diffState.status === "error"}
      <div class="diff-panel-centered diff-panel-message">
        <Icon name="alert" size={16} class="text-psx-error-foreground" />
        <p>{diffState.message}</p>
        <button type="button" class="diff-panel-button" onclick={() => load()}>Retry</button>
      </div>
    {:else if diffState.status === "ready" && diffEntries.length === 0 && diffState.diff.complete && diffState.diff.files.length === 0 && !diffState.diff.target}
      <div class="diff-panel-centered">
        <DesktopDiffEmptyState {scope} {gitStatus} />
      </div>
    {/if}
    <!-- The displayed document plus, during a scope switch, a hidden
         incoming one settling off-screen. Keyed by epoch so the swap only
         changes visibility — the settled document is never remounted. -->
    {#each diffEntries as entry (entry.epoch)}
      <div class="diff-panel-doc" class:is-hidden={entry.epoch !== displayedEpoch}>
        <DesktopDiffDocument
          bind:this={entry.ref}
          sessionId={entry.diff.sessionId}
          initialFiles={entry.diff.files}
          nextCursor={entry.diff.nextCursor}
          manifestComplete={entry.diff.complete}
          target={entry.diff.target}
          {scope}
          {gitStatus}
          layout={diffLayoutPreference.current}
          onOpenFile={(path) => openFullFile(path)}
          onCollapsedChange={(collapsed) => {
            entry.collapsedCount = collapsed;
            if (entry.epoch === displayedEpoch) collapsedCount = collapsed;
          }}
          onStats={(stats) => {
            if (entry.epoch === diffEntries.at(-1)?.epoch) acceptStats(stats, entry.diff.sessionId);
          }}
          onReady={() => handleEntryReady(entry.epoch)}
        />
      </div>
    {/each}
  </div>

  <footer class="diff-panel-footer">
    <div class="diff-panel-footer-stats">
      <span class="diff-panel-footer-title">{scopeLabel} changes</span>
      <div
        class="diff-panel-footer-values"
        class:is-faded={bodyFaded || !diffStats}
        aria-hidden={bodyFaded || !diffStats}
      >
        {#if diffStats}
          <GitDiffStats
            files={diffStats.files}
            additions={diffStats.additions}
            deletions={diffStats.deletions}
          />
        {/if}
      </div>
    </div>
    <div class="diff-panel-footer-actions">
      <button
        type="button"
        class="diff-panel-footer-button"
        disabled={!canToggleAll}
        onclick={() => displayedDocument?.setAllCollapsed(!anyCollapsed)}
      >
        <Icon name={anyCollapsed ? "expand-both" : "collapse-both"} size={14} aria-hidden="true" />
        {anyCollapsed ? "Expand All" : "Collapse All"}
      </button>
      <button
        type="button"
        class="diff-panel-footer-button diff-panel-footer-button--primary"
        title="Stage and Commit..."
        onclick={() => requestDesktopChangesView(worktreePath)}
      >
        Stage and Commit...
      </button>
    </div>
  </footer>
</div>

<style>
  .diff-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--psx-editor-background);
    font-size: 12px;
    color: var(--psx-foreground-primary);
  }

  /* Loading hint while a replacement diff fetches/settles, centred over the
     faded-out body (matching the in-body loading spinner's position so the
     handoff between the two doesn't hop). Its own fade-in keeps the
     appearance gentle rather than a hard pop. */
  .diff-panel-fade-spinner {
    position: absolute;
    /* The body area: below the 36px header, above the 52px footer. */
    inset: 36px 0 52px;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    animation: diff-panel-fade-spinner-in 90ms ease;
  }

  @keyframes diff-panel-fade-spinner-in {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }

  .diff-panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    height: 36px;
    padding: 0 12px;
    border-bottom: 1px solid var(--psx-border);
  }

  /* Equal flexible sides centre the scope switch; the left side hosts the
     branch info, the right side the layout toggle. */
  .diff-panel-header-side {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: flex-end;
    min-width: 0;
  }

  .diff-panel-header-side--start {
    justify-content: flex-start;
  }

  /* Positioning context for the stacked documents; fades in when the
     first document's settle gate lifts. */
  .diff-panel-body {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  .diff-panel-body,
  .diff-panel-footer-values {
    opacity: 1;
    transition: opacity 90ms ease;
  }

  .diff-panel-body.is-faded,
  .diff-panel-footer-values.is-faded {
    opacity: 0;
  }

  /* One mounted document. During a scope switch two are stacked: the
     displayed one stays interactive while the incoming one lays out and
     settles underneath at full size, invisible and untouchable, until
     handleEntryReady swaps the visibility in a single frame.

     visibility (not opacity): an opacity-0 element still paints into its
     own compositing layer, and a full-pane layer appearing/streaming/
     disappearing forces the splits pane's filtered edge SVGs to
     re-rasterize — a visible flash around the pane rim. A visibility-
     hidden subtree lays out identically but paints nothing. */
  .diff-panel-doc {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .diff-panel-doc.is-hidden {
    visibility: hidden;
    pointer-events: none;
  }

  /* Sticky stats footer: scope title over file count + total +/− badges on
     the left, the Expand All / Collapse All toggle on the right. */
  .diff-panel-footer {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex: 0 0 52px;
    height: 52px;
    min-height: 52px;
    max-height: 52px;
    padding: 8px 12px;
    border-top: 1px solid var(--psx-border);
    background: var(--psx-editor-background);
  }

  .diff-panel-footer-stats {
    display: flex;
    flex-direction: column;
    gap: 4px;
    height: 44px;
    min-height: 44px;
    max-height: 44px;
    min-width: 0;
  }

  .diff-panel-footer-title {
    overflow: hidden;
    font-size: 11px;
    color: var(--psx-foreground-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diff-panel-footer-values {
    min-height: 20px;
  }

  .diff-panel-footer-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
  }

  .diff-panel-footer-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    height: 26px;
    padding: 0 10px;
    border: none;
    border-radius: 6px;
    background: var(--psx-panel);
    color: var(--psx-foreground-primary);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .diff-panel-footer-button:hover:not(:disabled) {
    background: var(--psx-menu-hover-background);
  }

  .diff-panel-footer-button--primary {
    border: 1px solid var(--psx-button-primary-border, transparent);
    background: var(--psx-button-primary-background, var(--psx-focus));
    color: var(--psx-button-primary-foreground, #fff);
  }

  .diff-panel-footer-button--primary:hover:not(:disabled) {
    border-color: var(--psx-button-primary-hover-border, transparent);
    background: var(--psx-button-primary-hover-background, var(--psx-focus));
  }

  .diff-panel-footer-button:disabled {
    color: var(--psx-foreground-secondary);
    cursor: default;
    opacity: 0.6;
  }

  @media (prefers-reduced-motion: reduce) {
    .diff-panel-body {
      transition: none;
    }

    .diff-panel-fade-spinner {
      animation: none;
    }
  }

  .diff-panel-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    margin-right: -4px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--psx-foreground-secondary);
    cursor: pointer;
  }

  .diff-panel-icon-button:hover {
    background: var(--psx-menu-hover-background);
    color: var(--psx-foreground-primary);
  }

  .diff-panel-icon-button.is-active {
    color: var(--psx-focus);
  }

  .diff-panel-centered {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
  }

  .diff-panel-message {
    color: var(--psx-foreground-secondary);
    text-align: center;
  }

  .diff-panel-message p {
    margin: 0;
  }

  .diff-panel-button {
    display: inline-flex;
    align-items: center;
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

  .diff-panel-button:hover {
    background: var(--psx-menu-hover-background);
  }
</style>
