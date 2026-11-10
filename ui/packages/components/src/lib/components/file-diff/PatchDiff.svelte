<script lang="ts" module>
  /** File-header badge per pierre change type, like the changes list. */
  const CHANGE_BADGES: Record<string, { letter: string; kind: string } | undefined> = {
    change: { letter: "M", kind: "modified" },
    new: { letter: "A", kind: "added" },
    deleted: { letter: "D", kind: "deleted" },
    "rename-pure": { letter: "R", kind: "renamed" },
    "rename-changed": { letter: "R", kind: "renamed" },
  };
</script>

<script lang="ts">
  // Reusable diff renderer built on @pierre/diffs (https://diffs.com). Takes
  // either a unified patch string (e.g. raw `git diff` output) or a pair of
  // before/after file contents, and renders every file with syntax
  // highlighting. This is the app's single diff renderer: the desktop Diff
  // tab and chat tool-call diffs both go through it.
  import {
    FileDiff,
    parseDiffFromFile,
    parsePatchFiles,
    processFile,
    type FileContents,
    type FileDiffMetadata,
  } from "@pierre/diffs";
  import { createTwoFilesPatch } from "@camber/diff";
  import { preferredShikiHighlighter } from "../../utils/shikiEngine.js";
  import Badge from "../badge/Badge.svelte";
  import Icon from "../icon/Icon.svelte";
  import { createCacheNamespace } from "./cacheNamespace.js";
  import { getDiffWorkerPool } from "./diffWorkerPool.js";
  import {
    detectPierreTheme,
    DIFF_SURFACE_BACKGROUND,
    PIERRE_APP_THEMES,
    type PierreTheme,
  } from "./pierreTheme.js";
  import { SEPARATOR_CSS } from "./separatorCss.js";

  interface Props {
    /**
     * Unified diff / patch text, e.g. the output of `git diff`. Optional when
     * oldFile/newFile are given — the diff is then computed from contents.
     */
    patch?: string;
    /** Color mode for syntax highlighting. Defaults to the app theme. */
    theme?: "light" | "dark";
    /** Diff layout: unified (stacked) or side-by-side. */
    layout?: "unified" | "split";
    /**
     * Hide the per-file header (and with it the card border) rendered around
     * each diff, e.g. for chat tool diffs that carry their own chrome.
     */
    disableFileHeader?: boolean;
    /** Wrap long lines instead of the default horizontal scrolling. */
    wrap?: boolean;
    /**
     * Render a context-limited, noninteractive Pierre view. Intended for
     * inline tool diffs where fast disclosure matters more than expanding
     * unchanged file contents in place.
     */
    compact?: boolean;
    /**
     * Full before/after contents. Without a patch they define the diff;
     * alongside a single-file patch they make the collapsed "n unmodified
     * lines" separators expandable in place.
     */
    oldFile?: FileContents;
    newFile?: FileContents;
    /**
     * Renders the header file name as a link that calls back with the file's
     * (repo-relative) path, e.g. to open it in the in-app viewer.
     */
    onOpenFile?: (path: string) => void;
    /**
     * Reports collapse-state changes (per-file toggles, expand/collapse all,
     * and new patches resetting the state), e.g. for an Expand all /
     * Collapse all control.
     */
    onCollapsedChange?: (collapsed: number, total: number) => void;
    class?: string;
  }

  let {
    patch,
    theme,
    layout = "unified",
    disableFileHeader = false,
    wrap = false,
    compact = false,
    oldFile,
    newFile,
    onOpenFile,
    onCollapsedChange,
    class: className = "",
  }: Props = $props();

  let bodyElements = $state<(HTMLDivElement | undefined)[]>([]);
  let collapsedFiles = $state<Record<number, boolean>>({});
  let workerPoolFallback = $state(0);
  let instances: FileDiff[] = [];

  /** Collapses or expands every file card at once. */
  export function setAllCollapsed(collapsed: boolean): void {
    const next: Record<number, boolean> = {};
    if (collapsed) {
      parsed.files.forEach((_, index) => (next[index] = true));
    }
    collapsedFiles = next;
  }

  /** Expands one file card, accepting either its full or worktree-relative path. */
  export function expandFile(path: string): boolean {
    const index = parsed.files.findIndex((file) => {
      const name = file.name ?? "";
      return name === path || name.endsWith(`/${path}`);
    });
    if (index < 0) return false;
    collapsedFiles[index] = false;
    return true;
  }

  $effect(() => {
    const total = parsed.files.length;
    const collapsed = parsed.files.filter((_, index) => collapsedFiles[index]).length;
    onCollapsedChange?.(collapsed, total);
  });

  // Follow the host theme live (class toggles and OS scheme changes) unless
  // the consumer pins a theme via the prop.
  let detectedTheme = $state<PierreTheme>(detectPierreTheme());
  let appliedTheme = $derived(theme ?? detectedTheme);
  $effect(() => {
    const observer = new MutationObserver(() => {
      detectedTheme = detectPierreTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMediaChange = () => {
      detectedTheme = detectPierreTheme();
    };
    media?.addEventListener("change", onMediaChange);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", onMediaChange);
    };
  });

  // cacheKey ties parsed diffs into pierre's worker highlight caches, so
  // re-created FileDiff instances (theme flips, layout toggles) reuse the
  // highlighted AST. Pierre trusts equal keys as equal content without
  // validating, so the revision must advance on every parse and the mount
  // namespace keeps keys unique across the process-wide cache.
  const cacheNamespace = createCacheNamespace();
  let nextParseRevision = 0;

  function parseFiles(
    text: string | undefined,
    contents: { oldFile?: FileContents; newFile?: FileContents },
    compactView: boolean,
  ): FileDiffMetadata[] {
    const cacheKey = `${cacheNamespace}#${++nextParseRevision}`;
    if (!text?.trim()) {
      // Contents-only mode: compute the diff from the two sides.
      if (contents.oldFile && contents.newFile) {
        if (compactView) {
          // Parsing the generated patch (instead of enriching it with both
          // complete files) marks the metadata as partial. Pierre therefore
          // retains only changed hunks plus a little context and cannot offer
          // review-only expansion of the omitted lines.
          const compactPatch = createTwoFilesPatch(
            contents.oldFile.name,
            contents.newFile.name,
            contents.oldFile.contents,
            contents.newFile.contents,
            contents.oldFile.header,
            contents.newFile.header,
            { context: 3 },
          );
          return parsePatchFiles(compactPatch, cacheKey).flatMap((result) => result.files);
        }
        return [
          parseDiffFromFile(
            { ...contents.oldFile, cacheKey: `${cacheKey}:old` },
            { ...contents.newFile, cacheKey: `${cacheKey}:new` },
          ),
        ];
      }
      return [];
    }
    const parsed = parsePatchFiles(text, cacheKey).flatMap((result) => result.files);
    // Full contents only apply unambiguously to a single-file patch: re-parse
    // that one file with them so its collapsed context becomes expandable.
    if (!compactView && parsed.length === 1 && contents.oldFile && contents.newFile) {
      const enriched = processFile(text, {
        oldFile: { ...contents.oldFile, cacheKey: `${cacheKey}:old` },
        newFile: { ...contents.newFile, cacheKey: `${cacheKey}:new` },
      });
      if (enriched) {
        enriched.cacheKey = cacheKey;
        return [enriched];
      }
    }
    return parsed;
  }

  let parsed = $derived.by((): { files: FileDiffMetadata[]; error?: string } => {
    try {
      return { files: parseFiles(patch, { oldFile, newFile }, compact) };
    } catch (error) {
      return {
        files: [],
        error: error instanceof Error ? error.message : "Failed to parse diff",
      };
    }
  });

  $effect(() => {
    // A new diff means the per-file collapse choices no longer apply.
    void parsed.files;
    collapsedFiles = {};
  });

  /** Header pieces per file: basename + dimmed directory, like the Diff tab
   * title line and the changes list, plus badge and +/- line counts. */
  function headerInfo(file: FileDiffMetadata) {
    const name = file.name ?? "";
    const slash = name.lastIndexOf("/");
    let additions = 0;
    let deletions = 0;
    for (const hunk of file.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
    return {
      fileName: slash >= 0 ? name.slice(slash + 1) : name,
      fileDir: slash >= 0 ? name.slice(0, slash) : "",
      prevName: file.prevName !== name ? file.prevName : undefined,
      badge: CHANGE_BADGES[file.type],
      additions,
      deletions,
      // No hunks means no content to render (e.g. an empty new file or a
      // rename/mode-only change) — the expanded body shows a note instead.
      empty: file.hunks.length === 0,
    };
  }

  $effect(() => {
    // Re-render whenever inputs change; read everything reactive up front.
    void workerPoolFallback;
    const files = parsed.files;
    const inputs = {
      theme: appliedTheme,
      layout,
      wrap,
      compact,
      targets: files.map((_, index) => bodyElements[index]),
    };

    for (const instance of instances) instance.cleanUp();
    instances = [];

    const workerPool = getDiffWorkerPool();
    // Pierre re-renders when pool init succeeds but not when it fails (its
    // initialize().then(rerender) chain has no catch), which would leave
    // these diffs blank until the next input change. Force one re-render: a
    // failed pool reports isWorkingPool() false, so it paints synchronously
    // on the main thread. Guarded to a single attempt because this effect
    // re-runs on the bump — retrying a permanently broken pool would loop.
    if (workerPoolFallback === 0 && workerPool && !workerPool.isInitialized()) {
      workerPool.initialize().catch(() => {
        workerPoolFallback += 1;
      });
    }

    files.forEach((file, index) => {
      const target = inputs.targets[index];
      if (!target) return;
      const options = {
        theme: PIERRE_APP_THEMES[inputs.theme],
        themeType: inputs.theme,
        // Only reached when the worker pool is unavailable and highlighting
        // falls back to the main thread; keep that path on the wasm engine too.
        preferredHighlighter: preferredShikiHighlighter(),
        diffStyle: inputs.layout === "split" ? "split" : "unified",
        diffIndicators: "none",
        overflow: inputs.wrap ? "wrap" : "scroll",
        unsafeCSS: SEPARATOR_CSS,
        // Inline tool diffs do not need Pierre's contextual expansion controls
        // or the extra word-diff pass. The full review surface keeps both.
        hunkSeparators: inputs.compact ? "simple" : "line-info",
        lineDiffType: inputs.compact ? "none" : "word-alt",
        expandUnchanged: false,
        // The header is rendered by this component (below) so it can share
        // the app's filename/path treatment; pierre's own header stays off.
        disableFileHeader: true,
      } as const;
      target.replaceChildren();
      // With a worker pool, pierre renders the diff as plain text immediately
      // and swaps in shiki tokens highlighted off the main thread; without
      // one (jsdom, worker asset unavailable) it highlights synchronously on
      // the main thread as before.
      const instance = new FileDiff(options, workerPool);
      instance.render({ fileDiff: file, containerWrapper: target });
      instances.push(instance);
    });

    return () => {
      for (const instance of instances) instance.cleanUp();
      instances = [];
    };
  });
</script>

<div class={`psx-patch-diff ${className}`} style:--diffs-background={DIFF_SURFACE_BACKGROUND}>
  {#each parsed.files as file, index (index)}
    {@const info = headerInfo(file)}
    {@const collapsed = !!collapsedFiles[index]}
    <div
      class="psx-patch-diff-file"
      class:has-chrome={!disableFileHeader}
      data-patch-diff-file={file.name ?? ""}
    >
      {#if !disableFileHeader}
        <!-- The whole title bar toggles the collapse; the chevron button is
             the accessible control for the same action, so the bar itself
             stays a plain element. -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <header
          class="psx-patch-diff-header"
          class:is-collapsed={collapsed}
          title={file.name}
          onclick={() => (collapsedFiles[index] = !collapsed)}
        >
          <button
            type="button"
            class="psx-patch-diff-collapse"
            class:is-collapsed={collapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed
              ? `Expand ${info.fileName} diff`
              : `Collapse ${info.fileName} diff`}
            onclick={(event) => {
              event.stopPropagation();
              collapsedFiles[index] = !collapsed;
            }}
          >
            <Icon name="chevron" size={12} />
          </button>
          <Icon type="file" name={file.name} size={14} />
          {#if info.prevName}
            <span class="psx-patch-diff-header-dir">{info.prevName} →</span>
          {/if}
          {#if onOpenFile}
            {@const openFile = onOpenFile}
            <button
              type="button"
              class="psx-patch-diff-header-name is-link"
              aria-label={`Open ${file.name}`}
              onclick={(event) => {
                event.stopPropagation();
                openFile(file.name);
              }}
            >
              {info.fileName}
            </button>
          {:else}
            <span class="psx-patch-diff-header-name">{info.fileName}</span>
          {/if}
          {#if info.fileDir}
            <span class="psx-patch-diff-header-dir">{info.fileDir}</span>
          {/if}
          {#if info.badge}
            <span class={`psx-patch-diff-badge is-${info.badge.kind}`}>{info.badge.letter}</span>
          {/if}
          <!-- Same +/- treatment as DiffLineCount (chat changes summary). -->
          <span class="psx-patch-diff-header-counts">
            {#if info.additions > 0 || info.deletions === 0}
              <Badge class="font-mono" intent="positive" size="xs">
                <Icon aria-hidden="true" name="plus" />
                {info.additions}
                <span class="sr-only"> {info.additions === 1 ? "addition" : "additions"}</span>
              </Badge>
            {/if}
            {#if info.deletions > 0}
              <Badge class="font-mono" intent="critical" size="xs">
                <Icon aria-hidden="true" name="minus" />
                {info.deletions}
                <span class="sr-only"> {info.deletions === 1 ? "deletion" : "deletions"}</span>
              </Badge>
            {/if}
          </span>
        </header>
      {/if}
      <!-- Grid-row reveal: 1fr <-> 0fr animates to/from the content's own
           height (height: auto is not transitionable), giving expand and
           collapse a fast slide. -->
      <div class="psx-patch-diff-reveal" class:is-collapsed={collapsed}>
        <!-- Padding-free clipping wrapper: a padded child (e.g. the empty
             placeholder) can never shrink below its own padding, so the
             overflow clip must live on this unpadded element instead. -->
        <div class="psx-patch-diff-reveal-inner">
          {#if info.empty}
            <div class="psx-patch-diff-empty">Empty file</div>
          {:else}
            <div class="psx-patch-diff-body" bind:this={bodyElements[index]}></div>
          {/if}
        </div>
      </div>
    </div>
  {/each}
</div>
{#if parsed.error}
  <div class="psx-patch-diff-error">{parsed.error}</div>
{/if}

<style>
  .psx-patch-diff {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
    /* Added/removed colors come from the app diff tokens. Only the accent
       colors (gutter numbers, change indicators) are pinned; pierre derives
       the full-line green/red backgrounds by mixing the accent into the
       diff background. Don't pin --diffs-bg-*-override to --psx-diff-insert/
       delete: those tokens are mostly-transparent overlays and pierre would
       mix them into the background again, washing the line tint out. */
    --diffs-addition-color-override: var(
      --psx-diff-insert-foreground,
      light-dark(#1a7f37, #3fb950)
    );
    --diffs-deletion-color-override: var(
      --psx-diff-delete-foreground,
      light-dark(#cf222e, #f85149)
    );
    /* Respect the user's editor font settings. */
    --diffs-font-family: var(--psx-font-mono);
    --diffs-font-size: var(--psx-editor-font-size, 13px);
    --diffs-line-height: 1.6;
    /* Code sits flush against the card edges — no block padding above the
       first or below the last line, and the horizontal scrollbar track only
       takes space when lines actually overflow. The inline gap matches the
       header's 12px inset so their edges align. */
    --diffs-gap-block: 0px;
    --diffs-gap-inline: 12px;
    --diffs-overflow-override: auto;
  }

  .psx-patch-diff-file {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .psx-patch-diff-file.has-chrome {
    border: 1px solid var(--psx-border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--diffs-background);
  }

  .psx-patch-diff-header {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    border-bottom: 1px solid var(--psx-border);
    /* Inline padding matches the code area's inset below so the header's
       edges line up with the diff contents. */
    padding: 8px 12px;
    font-size: 12px;
    color: var(--psx-foreground-primary);
    cursor: pointer;
    user-select: none;
  }

  /* Once the body is collapsed, the card's outer bottom border is the sole
     divider. Keep the transparent border's space so the header does not jump. */
  .psx-patch-diff-header.is-collapsed {
    border-bottom-color: transparent;
  }

  .psx-patch-diff-collapse {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--psx-foreground-secondary);
    cursor: pointer;
  }

  .psx-patch-diff-collapse:hover {
    background: var(--psx-menu-hover-background);
    color: var(--psx-foreground-primary);
  }

  /* Rotate the whole (square) button: WKWebView ignores CSS transforms on
     the inline svg root itself. */
  .psx-patch-diff-collapse {
    transition: transform 0.15s ease;
  }

  .psx-patch-diff-collapse.is-collapsed {
    transform: rotate(-90deg);
  }

  .psx-patch-diff-header-name {
    white-space: nowrap;
  }

  .psx-patch-diff-header-name.is-link {
    padding: 0;
    border: none;
    background: transparent;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  .psx-patch-diff-header-name.is-link:hover {
    text-decoration: underline;
  }

  .psx-patch-diff-header-dir {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    color: var(--psx-foreground-tertiary);
  }

  .psx-patch-diff-badge {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 5px;
    font-size: 10px;
    font-weight: 600;
    background: color-mix(in srgb, currentColor 12%, transparent);
  }

  .psx-patch-diff-badge.is-modified {
    color: var(--psx-info-foreground, #1a85ff);
  }

  .psx-patch-diff-badge.is-added {
    color: var(--psx-diff-insert-foreground, #4fb262);
  }

  .psx-patch-diff-badge.is-deleted {
    color: var(--psx-error-foreground, #e5534b);
  }

  .psx-patch-diff-badge.is-renamed {
    color: var(--psx-foreground-secondary);
  }

  .psx-patch-diff-header-counts {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    font-size: 11px;
  }

  /* Fast slide for expand/collapse: a grid row animating 1fr <-> 0fr tracks
     the content's natural height (height: auto cannot be transitioned). The
     inner min-height: 0 lets the row actually shrink; overflow clips the
     content while it slides. The inner element must stay padding-free —
     padding sets a floor on how far it can shrink, leaving a sliver of the
     content visible when collapsed. */
  .psx-patch-diff-reveal {
    display: grid;
    grid-template-rows: 1fr;
    transition: grid-template-rows 0.15s ease;
  }

  .psx-patch-diff-reveal.is-collapsed {
    grid-template-rows: 0fr;
  }

  .psx-patch-diff-reveal-inner {
    min-height: 0;
    overflow: hidden;
  }

  @media (prefers-reduced-motion: reduce) {
    .psx-patch-diff-reveal {
      transition: none;
    }
  }

  /* Placeholder body for diffs with no content (e.g. empty new files). The
     inline inset matches the header/code alignment. */
  .psx-patch-diff-empty {
    padding: 8px 12px;
    font-size: 12px;
    font-style: italic;
    color: var(--psx-foreground-tertiary);
  }

  .psx-patch-diff-error {
    color: var(--psx-error-foreground, #f66);
    font-size: 0.8125rem;
    padding: 0.5rem;
  }
</style>
