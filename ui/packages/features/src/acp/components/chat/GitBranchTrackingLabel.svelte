<script lang="ts">
  import Icon from "@camber/components/icon";

  interface Props {
    branch: string;
    upstream?: string;
  }

  let { branch, upstream }: Props = $props();

  const fullLabel = $derived(upstream ? `${branch} › ${upstream}` : branch);
</script>

<span class="git-branch-tracking" aria-label={fullLabel}>
  <Icon name="git-branch" size={12} class="git-branch-tracking-icon" aria-hidden="true" />
  <span class="git-branch-tracking-local" aria-hidden="true">{branch}</span>
</span>

<style>
  .git-branch-tracking {
    display: inline-flex;
    flex-shrink: 1;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    font-family: var(--psx-font-mono);
    font-size: 11px;
    cursor: var(--git-branch-cursor, default);
  }

  .git-branch-tracking :global(.git-branch-tracking-icon) {
    flex-shrink: 0;
    color: var(--psx-foreground-secondary);
  }

  .git-branch-tracking-local {
    min-width: 0;
    overflow: hidden;
    color: var(--psx-foreground-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
