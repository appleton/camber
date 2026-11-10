<script lang="ts" module>
  /** The subset of the diff document's per-file state the header renders. */
  export interface DiffFileHeaderState {
    path: string;
    origPath?: string;
    status: string;
    binary: boolean;
    truncatedLines: number;
    additions: number;
    deletions: number;
    collapsed: boolean;
  }

  const STATUS_BADGES: Record<string, { letter: string; kind: string } | undefined> = {
    added: { letter: "A", kind: "added" },
    untracked: { letter: "A", kind: "added" },
    deleted: { letter: "D", kind: "deleted" },
    renamed: { letter: "R", kind: "renamed" },
    copied: { letter: "R", kind: "renamed" },
  };
</script>

<script lang="ts">
  // Per-file header for the Diff tab document, slotted into pierre
  // CodeView's header row (light DOM, so these scoped styles apply). It is
  // mounted imperatively — see DesktopDiffDocument's renderCustomHeader —
  // with the reactive file-state proxy as a prop, so collapse toggles and
  // streaming stat updates re-render here without pierre rebuilding the
  // slot. Matches the filename/path/badge/± treatment of the changes list.
  import { Badge } from "@camber/components/badge";
  import Icon from "@camber/components/icon";

  interface Props {
    file: DiffFileHeaderState;
    onOpenFile?: (path: string) => void;
    onToggleCollapsed: (path: string) => void;
  }

  let { file, onOpenFile, onToggleCollapsed }: Props = $props();

  const badge = $derived(STATUS_BADGES[file.status] ?? { letter: "M", kind: "modified" });
  const fileName = $derived(file.path.slice(file.path.lastIndexOf("/") + 1));
  const fileDir = $derived.by(() => {
    const slash = file.path.lastIndexOf("/");
    return slash < 0 ? "" : file.path.slice(0, slash);
  });
</script>

<!-- The whole title bar toggles the collapse; the chevron button is the
     accessible control for the same action, so the bar itself stays a plain
     element. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<header
  class="diff-file-header"
  title={file.path}
  data-diff-file-header={file.path}
  onclick={() => onToggleCollapsed(file.path)}
>
  <button
    type="button"
    class="diff-file-header-collapse"
    class:is-collapsed={file.collapsed}
    aria-expanded={!file.collapsed}
    aria-label={`${file.collapsed ? "Expand" : "Collapse"} ${fileName} diff`}
    onclick={(event) => {
      event.stopPropagation();
      onToggleCollapsed(file.path);
    }}
  >
    <Icon name="chevron" size={12} />
  </button>
  <Icon type="file" name={file.path} size={14} />
  {#if file.origPath && file.origPath !== file.path}
    <span class="diff-file-header-dir">{file.origPath} →</span>
  {/if}
  {#if onOpenFile}
    {@const openFile = onOpenFile}
    <button
      type="button"
      class="diff-file-header-name is-link"
      aria-label={`Open ${file.path}`}
      onclick={(event) => {
        event.stopPropagation();
        openFile(file.path);
      }}
    >
      {fileName}
    </button>
  {:else}
    <span class="diff-file-header-name">{fileName}</span>
  {/if}
  {#if fileDir}
    <span class="diff-file-header-dir">{fileDir}</span>
  {/if}
  <span class={`diff-file-header-badge is-${badge.kind}`}>{badge.letter}</span>
  {#if file.binary}
    <span class="diff-file-header-note">Binary file</span>
  {:else if file.truncatedLines > 0}
    <span class="diff-file-header-note">
      {file.truncatedLines} oversized {file.truncatedLines === 1 ? "line" : "lines"} omitted
    </span>
  {/if}
  <!-- Same +/- treatment as DiffLineCount (chat changes summary). -->
  <span class="diff-file-header-counts">
    {#if file.additions > 0}
      <Badge class="font-mono" intent="positive" size="xs">
        <Icon aria-hidden="true" name="plus" />
        {file.additions}
        <span class="sr-only"> {file.additions === 1 ? "addition" : "additions"}</span>
      </Badge>
    {/if}
    {#if file.deletions > 0}
      <Badge class="font-mono" intent="critical" size="xs">
        <Icon aria-hidden="true" name="minus" />
        {file.deletions}
        <span class="sr-only"> {file.deletions === 1 ? "deletion" : "deletions"}</span>
      </Badge>
    {/if}
  </span>
</header>

<style>
  .diff-file-header {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    width: 100%;
    color: var(--psx-foreground-primary);
    font-size: 12px;
    cursor: pointer;
    user-select: none;
  }

  .diff-file-header-collapse {
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
    /* Rotate the whole (square) button: WKWebView ignores CSS transforms on
       the inline svg root itself. */
    transition: transform 0.15s ease;
  }

  .diff-file-header-collapse:hover {
    background: var(--psx-menu-hover-background);
    color: var(--psx-foreground-primary);
  }

  .diff-file-header-collapse.is-collapsed {
    transform: rotate(-90deg);
  }

  .diff-file-header-name {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .diff-file-header-name.is-link {
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .diff-file-header-name.is-link:hover {
    text-decoration: underline;
  }

  .diff-file-header-dir {
    min-width: 0;
    overflow: hidden;
    color: var(--psx-foreground-tertiary);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diff-file-header-badge {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 5px;
    background: color-mix(in srgb, currentColor 12%, transparent);
    font-size: 10px;
    font-weight: 600;
  }

  .diff-file-header-badge.is-modified {
    color: var(--psx-info-foreground, #1a85ff);
  }

  .diff-file-header-badge.is-added {
    color: var(--psx-diff-insert-foreground, #4fb262);
  }

  .diff-file-header-badge.is-deleted {
    color: var(--psx-error-foreground, #e5534b);
  }

  .diff-file-header-badge.is-renamed {
    color: var(--psx-foreground-secondary);
  }

  .diff-file-header-note {
    flex-shrink: 0;
    color: var(--psx-foreground-tertiary);
    font-size: 11px;
    font-style: italic;
  }

  .diff-file-header-counts {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    font-size: 11px;
  }

  @media (prefers-reduced-motion: reduce) {
    .diff-file-header-collapse {
      transition: none;
    }
  }
</style>
