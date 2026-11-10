<script lang="ts">
  import type { GitDiffScope, GitStatusOutput } from "@camber/helperapi";

  interface Props {
    scope: GitDiffScope;
    gitStatus?: GitStatusOutput;
  }

  let { scope, gitStatus }: Props = $props();

  function commitCount(count: number): string {
    return `${count} commit${count === 1 ? "" : "s"}`;
  }

  let paragraphs = $derived.by((): string[] => {
    if (scope === "staged") return ["No staged changes."];
    if (scope === "unstaged") return ["No unstaged changes."];

    const status = gitStatus;
    if (!status?.isRepo) return ["No changes to show."];
    if (status.staged.length + status.unstaged.length + status.untracked.length > 0) {
      return ["No changes to show."];
    }

    const result: string[] = [];
    if (status.detached) {
      result.push("HEAD detached");
    } else if (status.branch) {
      result.push(`On branch ${status.branch}`);
    }

    if (status.upstream) {
      if (status.ahead === 0 && status.behind === 0) {
        result.push(`Your branch is up to date with '${status.upstream}'.`);
      } else if (status.ahead > 0 && status.behind === 0) {
        result.push(
          `Your branch is ahead of '${status.upstream}' by ${commitCount(status.ahead)}.`,
        );
      } else if (status.ahead === 0 && status.behind > 0) {
        result.push(`Your branch is behind '${status.upstream}' by ${commitCount(status.behind)}.`);
      } else {
        result.push(
          `Your branch and '${status.upstream}' have diverged, and have ${status.ahead} and ${status.behind} different commits each, respectively.`,
        );
      }
    }

    result.push("nothing to commit, working tree clean");
    return result;
  });
</script>

<div class="diff-empty-state" data-testid="desktop-diff-empty-state">
  {#each paragraphs as paragraph}
    <p>{paragraph}</p>
  {/each}
</div>

<style>
  .diff-empty-state {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: min(640px, 100%);
    color: var(--psx-foreground-secondary);
    font-family: var(--vscode-editor-font-family, monospace);
    line-height: 1.5;
    text-align: left;
  }

  .diff-empty-state p {
    margin: 0;
  }
</style>
