<script lang="ts">
  import {
    DiffCodeView,
    type DiffCodeViewItem,
    type FileDiffMetadata,
  } from "@camber/components/file-diff";
  import {
    camberGitDiffContents,
    camberGitDiffList,
    camberGitDiffRead,
    type GitDiffFileStats,
    type GitDiffFileSummary,
    type GitDiffScope,
    type GitDiffStats,
    type GitStatusOutput,
  } from "@camber/helperapi";
  import { getAllContexts, mount, tick, unmount, untrack } from "svelte";
  import DesktopDiffEmptyState from "./DesktopDiffEmptyState.svelte";
  import DiffFileHeader from "./DiffFileHeader.svelte";
  import { patchMatchesContents } from "./diffPatchContents";

  // All-files git diff document. The data layer streams the manifest and
  // whole-file patches from the helper; everything below that — windowing,
  // height measurement, sticky headers, scroll anchoring — is pierre
  // CodeView's job (via DiffCodeView). Files append in manifest order as
  // their patches complete; a prioritized file (reveal target) lands early
  // through the same reconcile.
  interface Props {
    sessionId: string;
    initialFiles: GitDiffFileSummary[];
    nextCursor?: string;
    manifestComplete: boolean;
    target?: GitDiffFileSummary;
    scope: GitDiffScope;
    gitStatus?: GitStatusOutput;
    layout: "unified" | "split";
    onOpenFile?: (path: string) => void;
    onCollapsedChange?: (collapsed: number, total: number) => void;
    onStats?: (stats: GitDiffStats) => void;
    onError?: (message: string) => void;
    /**
     * Called once, when the first file has rendered (or a deadline passed).
     * The owner keeps the document invisible until then so the initial
     * viewport doesn't assemble in front of the reader.
     */
    onReady?: () => void;
  }

  let {
    sessionId,
    initialFiles,
    nextCursor,
    manifestComplete,
    target,
    scope,
    gitStatus,
    layout,
    onOpenFile,
    onCollapsedChange,
    onStats,
    onError,
    onReady,
  }: Props = $props();

  interface DiffFileState {
    path: string;
    origPath?: string;
    status: string;
    binary: boolean;
    truncatedLines: number;
    additions: number;
    deletions: number;
    /** Whole-file unified patch, joined from the helper's bounded chunks. */
    patch: string;
    loaded: boolean;
    loading: boolean;
    error?: string;
    collapsed: boolean;
    /** CodeView re-render trigger; bumped on any visible change. */
    version: number;
    /** Parse/highlight cache key; bumped only when patch/contents change. */
    contentVersion: number;
    /** Full before/after contents backing pierre's context expanders. */
    contentsState: "none" | "loading" | "loaded" | "unavailable";
    oldContent?: string;
    newContent?: string;
  }

  const MAX_CONCURRENT_FILE_READS = 3;
  const READY_DEADLINE_MS = 600;

  function createFile(summary: GitDiffFileSummary, collapsed: boolean): DiffFileState {
    return {
      path: summary.path,
      origPath: summary.origPath,
      status: summary.status,
      binary: summary.binary ?? false,
      truncatedLines: 0,
      additions: summary.additions ?? 0,
      deletions: summary.deletions ?? 0,
      patch: "",
      loaded: false,
      loading: false,
      collapsed,
      version: 1,
      contentVersion: 1,
      contentsState: "none",
    };
  }

  function initialFileStates(): DiffFileState[] {
    // Manifest order always, regardless of how the tab was opened: the
    // reveal target is prioritized for *loading* (nextPendingFile) and
    // scrolled to, never re-positioned — hoisting it to the top made the
    // document order depend on which file row opened the tab. The scroll
    // stays accurate while earlier files stream in above the target because
    // pierre re-resolves a pending scroll target's position every frame.
    const summaries = [...initialFiles];
    if (target && !summaries.some((summary) => summary.path === target.path)) {
      // Not in the first manifest page: append provisionally; the manifest
      // reconciliation slots it into its true position.
      summaries.push(target);
    }
    const seen = new Set<string>();
    return summaries
      .filter((summary) => {
        if (seen.has(summary.path)) return false;
        seen.add(summary.path);
        return true;
      })
      .map((summary) => createFile(summary, false));
  }

  let files = $state<DiffFileState[]>(initialFileStates());
  let manifestDone = $state(manifestComplete);
  let manifestError = $state<string>();
  let collapseNewFiles = false;
  let diffView = $state<ReturnType<typeof DiffCodeView>>();
  /** Voids in-flight responses from a superseded session. */
  let generation = 0;
  let adoptedSession = sessionId;
  let activeReads = 0;
  /** File to scroll to once its item exists; set by revealFile. */
  let pendingReveal = $state<string>();

  // ---- Rendered items -----------------------------------------------------
  // Loaded files in manifest order. DiffCodeView reconciles this into the
  // cheapest pierre call: appends for streaming, updateItem for version
  // bumps, setItems for out-of-order arrivals (e.g. a prioritized target).

  /**
   * A loaded file whose diff has no textual patch (binary files, empty
   * created/deleted files) still gets an item: pierre parses a header-only
   * patch into a zero-hunk fileDiff, so the file renders as just its card
   * header — where DiffFileHeader's "Binary file" note and ± counts live.
   * Without this the file would silently vanish from the document while
   * remaining in the changes list.
   */
  function headerOnlyPatch(file: DiffFileState): string {
    return `diff --git a/${file.origPath || file.path} b/${file.path}\n`;
  }

  let items = $derived.by((): DiffCodeViewItem[] =>
    files
      .filter((file) => file.loaded)
      .map((file) => ({
        id: file.path,
        patch: file.patch !== "" ? file.patch : headerOnlyPatch(file),
        collapsed: file.collapsed,
        version: file.version,
        contentVersion: file.contentVersion,
        oldFile:
          file.contentsState === "loaded"
            ? { name: file.origPath || file.path, contents: file.oldContent ?? "" }
            : undefined,
        newFile:
          file.contentsState === "loaded"
            ? { name: file.path, contents: file.newContent ?? "" }
            : undefined,
      })),
  );

  let failedFiles = $derived(files.filter((file) => file.error != null));
  let loadingCount = $derived(files.filter((file) => !file.loaded && file.error == null).length);

  $effect(() => {
    onCollapsedChange?.(files.filter((file) => file.collapsed).length, files.length);
  });

  // ---- Initial-settle signal ----------------------------------------------

  let ready = false;

  function markReady(): void {
    if (ready) return;
    ready = true;
    onReady?.();
  }

  $effect(() => {
    const timer = setTimeout(markReady, READY_DEADLINE_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    // Ready as soon as pierre has something to render (or the diff is empty).
    if (ready) return;
    if (items.length > 0 || (manifestDone && files.length === 0)) markReady();
  });

  // ---- Manifest -----------------------------------------------------------

  function addFiles(summaries: GitDiffFileSummary[]): void {
    for (const summary of summaries) {
      const existing = files.find((file) => file.path === summary.path);
      if (existing) {
        if (summary.status) existing.status = summary.status;
        existing.origPath = summary.origPath;
        if (summary.statsReady && !existing.loaded) {
          existing.additions = summary.additions ?? 0;
          existing.deletions = summary.deletions ?? 0;
          existing.binary = summary.binary ?? false;
        }
        continue;
      }
      files.push(createFile(summary, collapseNewFiles));
    }
  }

  /**
   * Streams the whole manifest eagerly. There are no placeholder rows to
   * estimate: files simply append to the document as their patches load, so
   * reading the manifest up front costs one paged listing per session.
   *
   * Once complete, files are sorted into manifest order. Streaming pages
   * only ever append (stable), so this matters exactly when a provisional
   * entry (an out-of-manifest reveal target) was holding a temporary slot —
   * keeping the document's order identical no matter which file the tab was
   * opened to.
   */
  async function loadManifest(gen: number, cursor: string): Promise<void> {
    manifestError = undefined;
    const order = new Map<string, number>(initialFiles.map((file, index) => [file.path, index]));
    try {
      for (;;) {
        const page = await camberGitDiffList({ sessionId, cursor });
        if (gen !== generation) return;
        addFiles(page.files);
        for (const file of page.files) {
          if (!order.has(file.path)) order.set(file.path, order.size);
        }
        if (page.stats) onStats?.(page.stats);
        pumpFileReads();
        if (page.complete || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      sortFilesByManifestOrder(order);
      manifestDone = true;
    } catch (error) {
      if (gen !== generation) return;
      manifestError = error instanceof Error ? error.message : "Failed to load changed files";
      onError?.(manifestError);
    }
  }

  /** Manifest order, with unknown (provisional) paths kept after it. */
  function sortFilesByManifestOrder(order: Map<string, number>): void {
    const position = (file: DiffFileState): number => order.get(file.path) ?? Number.MAX_VALUE;
    const sorted = [...files].sort((a, b) => position(a) - position(b));
    // Avoid churning pierre's item list when streaming already appended in
    // manifest order (the common case).
    if (sorted.some((file, index) => file !== files[index])) files = sorted;
  }

  // ---- File patches -------------------------------------------------------

  /** Next file to read: the reveal target first, then manifest order. */
  function nextPendingFile(): DiffFileState | undefined {
    const pending = files.filter((file) => !file.loaded && !file.loading && file.error == null);
    if (pending.length === 0) return undefined;
    const prioritized = pendingReveal ?? target?.path;
    return (
      (prioritized && pending.find((file) => pathMatches(file.path, prioritized))) || pending[0]
    );
  }

  function pumpFileReads(): void {
    while (activeReads < MAX_CONCURRENT_FILE_READS) {
      const file = nextPendingFile();
      if (!file) return;
      file.loading = true;
      activeReads++;
      void loadWholeFile(file, generation).finally(() => {
        activeReads--;
        pumpFileReads();
      });
    }
  }

  /**
   * Reads every bounded chunk of one file and joins them into a single
   * whole-file patch. Pierre virtualizes per line, so patch size only
   * affects memory, not rendering cost; holding whole patches is what lets
   * pierre own layout without placeholder-height estimation.
   */
  async function loadWholeFile(file: DiffFileState, gen: number): Promise<void> {
    const parts: string[] = [];
    let additions = 0;
    let deletions = 0;
    let binary = false;
    let truncated = 0;
    let cursor = "";
    try {
      for (;;) {
        const page = await camberGitDiffRead({ sessionId, file: file.path, cursor });
        if (gen !== generation) return;
        if (page.chunk) {
          parts.push(page.chunk.patch);
          additions += page.chunk.additions;
          deletions += page.chunk.deletions;
          binary ||= page.chunk.binary === true;
          truncated += page.chunk.truncatedLines ?? 0;
        }
        if (page.complete || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      file.patch = joinChunkPatches(parts);
      file.additions = additions;
      file.deletions = deletions;
      file.binary = binary;
      file.truncatedLines = truncated;
      file.loaded = true;
      file.loading = false;
      file.version++;
      file.contentVersion++;
      maybeLoadContents(file, gen);
    } catch (error) {
      if (gen !== generation) return;
      file.loading = false;
      file.error = error instanceof Error ? error.message : "Failed to load file diff";
      // A failed reveal target never produces an item for the scroll effect
      // to land on; drop the pending scroll instead of holding it forever.
      if (pendingReveal != null && pathMatches(file.path, pendingReveal)) {
        pendingReveal = undefined;
      }
    }
  }

  /**
   * The helper prefixes every chunk with the file's `diff --git` header so
   * each chunk parses standalone. Joined into one patch, later chunks must
   * shed that header — everything before their first hunk — or the parser
   * would see one file per chunk. A later chunk with no `@@ ` hunk line at
   * all (a header-only repeat) carries no content and is dropped entirely.
   */
  function joinChunkPatches(parts: string[]): string {
    if (parts.length <= 1) return parts[0] ?? "";
    const [first, ...rest] = parts;
    const hunksOnly = rest.map((part) => {
      if (part.startsWith("@@ ")) return part;
      const firstHunk = part.indexOf("\n@@ ");
      return firstHunk < 0 ? "" : part.slice(firstHunk + 1);
    });
    return [first, ...hunksOnly.filter((part) => part !== "")].join("");
  }

  // ---- Full-contents enrichment -------------------------------------------
  // A loaded text file is enriched with its full before/after contents so
  // pierre renders in-place context expanders (between hunks and above/below
  // the outermost ones). Optional: failures leave the plain patch rendered.

  function contentsEligible(file: DiffFileState): boolean {
    return (
      file.loaded &&
      !file.binary &&
      file.truncatedLines === 0 &&
      file.patch !== "" &&
      // Added and deleted files have no unmodified lines to expand.
      file.status !== "added" &&
      file.status !== "untracked" &&
      file.status !== "deleted"
    );
  }

  function maybeLoadContents(file: DiffFileState, gen: number): void {
    if (file.contentsState !== "none" || !contentsEligible(file)) return;
    file.contentsState = "loading";
    void (async () => {
      try {
        const result = await camberGitDiffContents({ sessionId, file: file.path });
        if (gen !== generation) return;
        if (
          !result.hasContents ||
          // The worktree may have drifted between the patch and contents
          // reads; enriching with mismatched contents would expand wrong
          // lines, so verify before use.
          !patchMatchesContents(file.patch, result.oldContent ?? "", result.newContent ?? "")
        ) {
          file.contentsState = "unavailable";
          return;
        }
        file.oldContent = result.oldContent ?? "";
        file.newContent = result.newContent ?? "";
        file.contentsState = "loaded";
        file.version++;
        file.contentVersion++;
      } catch {
        if (gen !== generation) return;
        file.contentsState = "unavailable";
      }
    })();
  }

  // ---- Session adoption ---------------------------------------------------
  // Silent reloads open a replacement helper session for the same worktree
  // and scope. The document re-reads every loaded file from the new session;
  // an unchanged file produces a byte-identical patch, keeps its versions,
  // and pierre re-renders nothing. Changed files bump versions and update in
  // place, preserving scroll position.

  $effect(() => {
    const next = sessionId;
    if (next === adoptedSession) return;
    adoptedSession = next;
    untrack(adoptSession);
  });

  function adoptSession(): void {
    generation += 1;
    const gen = generation;
    manifestDone = false;
    for (const file of files) {
      file.loading = false;
      file.error = undefined;
    }
    void (async () => {
      await reconcileManifest(gen);
      if (gen !== generation) return;
      for (const file of files) {
        if (file.loaded) void refreshFile(file, gen);
      }
      pumpFileReads();
    })();
  }

  /** Full re-list that also drops removed files and matches the new order. */
  async function reconcileManifest(gen: number): Promise<void> {
    const order = new Map<string, number>();
    let cursor = "";
    try {
      for (;;) {
        const page = await camberGitDiffList({ sessionId, cursor });
        if (gen !== generation) return;
        addFiles(page.files);
        for (const file of page.files) {
          if (!order.has(file.path)) order.set(file.path, order.size);
        }
        if (page.stats) onStats?.(page.stats);
        if (page.complete || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      files = files
        .filter((file) => order.has(file.path))
        .sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
      manifestDone = true;
    } catch (error) {
      if (gen !== generation) return;
      manifestError = error instanceof Error ? error.message : "Failed to load changed files";
      onError?.(manifestError);
    }
  }

  /** Re-reads one loaded file; only actual changes bump versions. */
  async function refreshFile(file: DiffFileState, gen: number): Promise<void> {
    const parts: string[] = [];
    let additions = 0;
    let deletions = 0;
    let binary = false;
    let truncated = 0;
    let cursor = "";
    try {
      for (;;) {
        const page = await camberGitDiffRead({ sessionId, file: file.path, cursor });
        if (gen !== generation) return;
        if (page.chunk) {
          parts.push(page.chunk.patch);
          additions += page.chunk.additions;
          deletions += page.chunk.deletions;
          binary ||= page.chunk.binary === true;
          truncated += page.chunk.truncatedLines ?? 0;
        }
        if (page.complete || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const patch = joinChunkPatches(parts);
      if (patch === file.patch) return;
      file.patch = patch;
      file.additions = additions;
      file.deletions = deletions;
      file.binary = binary;
      file.truncatedLines = truncated;
      file.oldContent = undefined;
      file.newContent = undefined;
      file.contentsState = "none";
      file.version++;
      file.contentVersion++;
      maybeLoadContents(file, gen);
    } catch (error) {
      if (gen !== generation) return;
      file.loaded = false;
      file.patch = "";
      file.error = error instanceof Error ? error.message : "Failed to load file diff";
    }
  }

  // ---- Initial load -------------------------------------------------------

  $effect(() => {
    // Mounted once per session epoch; `files` was seeded from the first
    // manifest page the panel already fetched via diffOpen.
    untrack(() => {
      pumpFileReads();
      if (!manifestComplete) void loadManifest(generation, nextCursor ?? "");
    });
  });

  function retryFailures(): void {
    for (const file of files) file.error = undefined;
    if (manifestError) {
      manifestDone = false;
      void loadManifest(generation, "");
    }
    pumpFileReads();
  }

  // ---- Public API (used by DesktopDiffPanel) -------------------------------

  export function setAllCollapsed(collapsed: boolean): void {
    collapseNewFiles = collapsed;
    for (const file of files) {
      if (file.collapsed === collapsed) continue;
      file.collapsed = collapsed;
      file.version++;
    }
  }

  export function applyFileStats(stats: readonly GitDiffFileStats[]): void {
    for (const item of stats) {
      const file = files.find((candidate) => candidate.path === item.path);
      if (!file || file.loaded) continue;
      file.additions = item.additions ?? 0;
      file.deletions = item.deletions ?? 0;
      file.binary = item.binary ?? false;
    }
  }

  export function expandFile(path: string): boolean {
    const file = files.find((candidate) => pathMatches(candidate.path, path));
    if (!file) return false;
    if (file.collapsed) {
      file.collapsed = false;
      file.version++;
    }
    return true;
  }

  export async function revealFile(path: string): Promise<void> {
    let file = files.find((candidate) => pathMatches(candidate.path, path));
    if (!file) {
      file = createFile({ path, status: "modified" }, false);
      files.push(file);
    }
    expandFile(file.path);
    pendingReveal = file.path;
    pumpFileReads();
    await tick();
  }

  $effect(() => {
    // Scroll to the reveal target once its item is rendered by pierre.
    // smooth-auto: pierre's spring re-resolves the destination every frame
    // (so mid-glide height corrections retarget instead of jumping) and
    // falls back to an instant jump beyond ~10 viewports or under
    // prefers-reduced-motion.
    const path = pendingReveal;
    if (!path) return;
    if (!items.some((item) => item.id === path)) return;
    const view = diffView;
    pendingReveal = undefined;
    void tick().then(() => view?.scrollToItem(path, "smooth-auto"));
  });

  function pathMatches(candidate: string, requested: string): boolean {
    return candidate === requested || candidate.endsWith(`/${requested}`);
  }

  // ---- Custom file headers --------------------------------------------------
  // DiffFileHeader components mounted imperatively into pierre's custom
  // header slot (light DOM, so their scoped styles apply). Each mount
  // receives the live file-state proxy, so collapse toggles and stat updates
  // re-render the header through normal Svelte reactivity — pierre only
  // re-calls renderFileHeader when an item's version changes, and then gets
  // the same element back. Contexts are forwarded so Icon resolves file
  // icons through the host's provider.

  const componentContexts = getAllContexts();

  interface MountedHeader {
    element: HTMLElement;
    instance: Record<string, unknown>;
    file: DiffFileState;
  }

  const mountedHeaders = new Map<string, MountedHeader>();

  function toggleCollapsed(path: string): void {
    const file = files.find((candidate) => candidate.path === path);
    if (!file) return;
    file.collapsed = !file.collapsed;
    file.version++;
  }

  function renderFileHeader(fileDiff: FileDiffMetadata): Element | undefined {
    const path = fileDiff.name ?? "";
    const file = files.find((candidate) => candidate.path === path);
    if (!file) return undefined;
    const existing = mountedHeaders.get(path);
    // Reuse while the header still renders the same state proxy; a stale
    // proxy (the file left the diff and came back as a new object) would
    // stop reacting, so remount over it.
    if (existing?.file === file) return existing.element;
    if (existing) void unmount(existing.instance);

    const element = document.createElement("div");
    element.className = "diff-document-header-slot";
    const instance = mount(DiffFileHeader, {
      target: element,
      props: { file, onOpenFile, onToggleCollapsed: toggleCollapsed },
      context: componentContexts,
    });
    mountedHeaders.set(path, { element, instance, file });
    return element;
  }

  $effect(() => {
    // Drop mounts for files that left the diff (session swaps).
    const present = new Set(files.map((file) => file.path));
    for (const [path, header] of mountedHeaders) {
      if (present.has(path)) continue;
      void unmount(header.instance);
      mountedHeaders.delete(path);
    }
  });

  $effect(() => {
    return () => {
      for (const header of mountedHeaders.values()) void unmount(header.instance);
      mountedHeaders.clear();
    };
  });
</script>

<div class="diff-document">
  {#if manifestError || failedFiles.length > 0}
    <div class="diff-document-errors">
      <span>
        {manifestError ??
          `Failed to load ${failedFiles.length} ${failedFiles.length === 1 ? "file" : "files"}`}
      </span>
      <button type="button" onclick={retryFailures}>Retry</button>
    </div>
  {/if}
  {#if manifestDone && files.length === 0}
    <div class="diff-document-empty">
      <DesktopDiffEmptyState {scope} {gitStatus} />
    </div>
  {:else}
    <DiffCodeView
      bind:this={diffView}
      {items}
      {layout}
      renderCustomHeader={renderFileHeader}
      class="diff-document-view"
    />
    {#if loadingCount > 0 && items.length > 0}
      <div class="diff-document-loading" role="status">
        Loading {loadingCount} more {loadingCount === 1 ? "file" : "files"}…
      </div>
    {/if}
  {/if}
</div>

<style>
  .diff-document {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  .diff-document :global(.diff-document-view) {
    flex: 1;
    min-height: 0;
  }

  .diff-document-empty {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    color: var(--psx-foreground-secondary);
  }

  .diff-document-errors {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--psx-border);
    color: var(--psx-error-foreground);
    font-size: 12px;
  }

  .diff-document-errors button {
    padding: 0;
    border: none;
    background: transparent;
    color: var(--psx-link-foreground, var(--psx-focus));
    font: inherit;
    cursor: pointer;
  }

  .diff-document-loading {
    position: absolute;
    right: 12px;
    bottom: 8px;
    z-index: 1;
    padding: 3px 8px;
    border: 1px solid var(--psx-border);
    border-radius: 6px;
    background: var(--psx-editor-background);
    color: var(--psx-foreground-tertiary);
    font-size: 11px;
    pointer-events: none;
  }

  /* Wrapper element hosting a mounted DiffFileHeader inside pierre's custom
     header slot; the header's own styles are scoped in DiffFileHeader. */
  .diff-document :global(.diff-document-header-slot) {
    display: flex;
    min-width: 0;
    width: 100%;
  }
</style>
