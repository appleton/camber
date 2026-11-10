<script lang="ts">
  import Icon from "@camber/components/icon";
  import DiffLineCount from "./DiffLineCount.svelte";

  /**
   * Compact "N files [+n][-n]" git diff stats cluster, shared by the chat
   * footer's changes summary and the Diff tab's footer. Inherits font size
   * from its container.
   */
  interface Props {
    files: number;
    additions: number;
    deletions: number;
    /** Size of the files icon; 14 matches the Diff tab footer. */
    iconSize?: number;
  }

  let { files, additions, deletions, iconSize = 14 }: Props = $props();
</script>

<span class="git-diff-stats">
  <span class="git-diff-stats-files">
    <Icon name="files" size={iconSize} aria-hidden="true" />
    {files}
    {files === 1 ? "file" : "files"}
  </span>
  <DiffLineCount count={additions} type="addition" size="xs" />
  <DiffLineCount count={deletions} type="deletion" size="xs" />
</span>

<style>
  .git-diff-stats {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
  }

  .git-diff-stats-files {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    color: var(--psx-foreground-primary);
  }
</style>
