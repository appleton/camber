<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import { untrack } from "svelte";
  import { getACPGithubRepo } from "../../features/GithubRepository.svelte";
  import {
    githubDotColorClass,
    githubStatusCategory,
    type GitHubCheckRun,
    type GitHubPRDetail,
  } from "../../github/githubStatus";
  import { rpc } from "../../hostRpc";
  import GithubMarkdown from "./GithubMarkdown.svelte";

  interface Props {
    worktreePath: string;
    focusToken?: number;
    onTitleChange?: (title: string) => void;
  }

  // focusToken is accepted (the splits pane passes it to every tab) but
  // intentionally unused: see the load effect below.
  let { worktreePath, onTitleChange }: Props = $props();

  const github = getACPGithubRepo();

  type LoadState =
    | { status: "loading" }
    | { status: "error"; message: string }
    | {
        status: "ready";
        detail: GitHubPRDetail | null;
        configured: boolean;
        repoSupported: boolean;
        branch: string;
      };

  let state = $state<LoadState>({ status: "loading" });
  let loadToken = 0;

  async function load(path: string): Promise<void> {
    const token = ++loadToken;
    onTitleChange?.(githubTabTitle());
    state = { status: "loading" };
    try {
      const result = await github.prDetail(path);
      if (token !== loadToken) return;
      state = {
        status: "ready",
        detail: result.detail ?? null,
        configured: result.configured,
        repoSupported: result.repoSupported,
        branch: result.branch,
      };
      onTitleChange?.(githubTabTitle(result.detail ?? null));
    } catch (error) {
      if (token !== loadToken) return;
      state = {
        status: "error",
        message: error instanceof Error ? error.message : "Failed to load pull request",
      };
      onTitleChange?.(githubTabTitle());
    }
  }

  function githubTabTitle(detail?: GitHubPRDetail | null): string {
    if (!detail) return "GitHub";
    return `#${detail.number} ${detail.title}`;
  }

  // Load on mount and whenever the worktree changes. Deliberately NOT keyed on
  // focusToken: that bumps on every pane click (didFocusPane), which would
  // reload the panel mid-interaction (e.g. clicking "Open PR"). Use the manual
  // refresh button to re-fetch.
  $effect(() => {
    const path = worktreePath;
    // Empty only transiently, while a stale tab's content is being torn down
    // (see desktopTabContent in DesktopSplitsPane): skip the doomed fetch.
    if (!path) return;
    untrack(() => {
      void load(path);
    });
  });

  function openPR(url: string): void {
    if (url) rpc.openExternalURL(url);
  }

  async function openCurrentOrNewPR(): Promise<void> {
    const result = await github.prUrl(worktreePath);
    openPR(result.url);
  }

  function checkBucket(run: GitHubCheckRun): "success" | "failure" | "pending" {
    const conclusion = run.conclusion.toLowerCase();
    if (conclusion) {
      if (["success", "neutral", "skipped"].includes(conclusion)) return "success";
      if (
        [
          "failure",
          "error",
          "timed_out",
          "cancelled",
          "action_required",
          "startup_failure",
        ].includes(conclusion)
      ) {
        return "failure";
      }
      return "pending";
    }
    return run.status.toLowerCase() === "completed" ? "success" : "pending";
  }

  function checkIcon(run: GitHubCheckRun): {
    name: "checkmark" | "cross" | "clock";
    class: string;
  } {
    switch (checkBucket(run)) {
      case "success":
        return { name: "checkmark", class: "text-psx-diff-insert-foreground" };
      case "failure":
        return { name: "cross", class: "text-psx-error-foreground" };
      default:
        return { name: "clock", class: "text-psx-warning-foreground" };
    }
  }

  function reviewLabel(decision: string): string {
    switch (decision) {
      case "approved":
        return "Approved";
      case "changes_requested":
        return "Changes requested";
      case "review_required":
        return "Review required";
      default:
        return "";
    }
  }

  function reviewStateLabel(reviewState: string): string {
    switch (reviewState) {
      case "approved":
        return "approved";
      case "changes_requested":
        return "changes requested";
      case "commented":
        return "commented";
      case "dismissed":
        return "dismissed";
      case "pending":
        return "pending";
      default:
        return reviewState;
    }
  }

  function formatDate(iso: string): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function stateLabel(detail: GitHubPRDetail): string {
    switch (detail.state) {
      case "merged":
        return "Merged";
      case "closed":
        return "Closed";
      case "draft":
        return "Draft";
      default:
        return "Open";
    }
  }
</script>

<div class="github-panel" tabindex="-1">
  {#if state.status === "loading"}
    <div class="github-panel-centered">
      <Spinner size={18} />
    </div>
  {:else if state.status === "error"}
    <div class="github-panel-centered github-panel-message">
      <Icon name="alert" size={18} class="text-psx-error-foreground" />
      <p>{state.message}</p>
      <button type="button" class="github-panel-button" onclick={() => load(worktreePath)}>
        Retry
      </button>
    </div>
  {:else if !state.repoSupported}
    <div class="github-panel-centered github-panel-message">
      <Icon name="git-branch" size={20} class="text-psx-foreground-tertiary" />
      <p>Camber couldn’t detect a supported GitHub remote.</p>
      <p class="github-panel-hint">
        Camber checks the resolved URL of the <code>origin</code> remote. Its hostname must be
        <code>github.com</code> or a recognizable GitHub Enterprise hostname. Git URL aliases,
        including <code>url.*.insteadOf</code>, must resolve to one of those hostnames. Check it
        with <code>git remote get-url origin</code>.
      </p>
    </div>
  {:else if !state.configured}
    <div class="github-panel-centered github-panel-message">
      <Icon name="github" size={20} class="text-psx-foreground-tertiary" />
      <p>Connect GitHub to see pull-request status.</p>
      <p class="github-panel-hint">
        Sign in with the GitHub CLI (<code>gh auth login</code>) or add a token in Settings →
        GitHub.
      </p>
    </div>
  {:else if !state.detail}
    <div class="github-panel-centered github-panel-message">
      <Icon name="git-branch" size={20} class="text-psx-foreground-tertiary" />
      <p>No open pull request for <code>{state.branch}</code>.</p>
      <div class="github-panel-actions">
        <button type="button" class="github-panel-button" onclick={openCurrentOrNewPR}>
          <Icon name="git-branch" size={12} />
          Open New PR
        </button>
        <button
          type="button"
          class="github-panel-button github-panel-button--ghost"
          onclick={() => load(worktreePath)}
        >
          Refresh
        </button>
      </div>
    </div>
  {:else}
    {@const detail = state.detail}
    {@const category = githubStatusCategory(detail, github.colorMode)}
    {@const checkRuns = detail.checkRuns ?? []}
    {@const comments = detail.comments ?? []}
    {@const reviews = detail.reviews ?? []}
    <div class="github-panel-scroll">
      <header class="github-panel-header">
        <div class="github-panel-title-row">
          <span class={["github-panel-state-dot", githubDotColorClass(category)]} aria-hidden="true"
          ></span>
          <h2 class="github-panel-title">{detail.title}</h2>
        </div>
        <div class="github-panel-subtitle">
          <span class="github-panel-state">{stateLabel(detail)}</span>
          <span>#{detail.number}</span>
          {#if detail.author}<span>by {detail.author}</span>{/if}
          {#if detail.headRefName}
            <span class="github-panel-branch">
              <Icon name="git-branch" size={11} />
              {detail.headRefName} → {detail.baseRefName}
            </span>
          {/if}
        </div>
        <div class="github-panel-actions">
          <button type="button" class="github-panel-button" onclick={() => openPR(detail.url)}>
            <Icon name="git-branch" size={12} />
            Open PR
          </button>
          <button
            type="button"
            class="github-panel-button github-panel-button--ghost"
            title="Refresh"
            aria-label="Refresh"
            onclick={() => load(worktreePath)}
          >
            <Icon name="rotate-ccw" size={12} />
          </button>
        </div>
      </header>

      {#if detail.reviewDecision || detail.checks.total > 0}
        <section class="github-panel-section github-panel-summary">
          {#if reviewLabel(detail.reviewDecision)}
            <span
              class={[
                "github-panel-chip",
                detail.reviewDecision === "approved"
                  ? "text-psx-diff-insert-foreground"
                  : detail.reviewDecision === "changes_requested"
                    ? "text-psx-error-foreground"
                    : "text-psx-foreground-secondary",
              ]}
            >
              <Icon
                name={detail.reviewDecision === "approved" ? "checkmark" : "review"}
                size={12}
              />
              {reviewLabel(detail.reviewDecision)}
            </span>
          {/if}
          {#if detail.checks.total > 0}
            <span class="github-panel-chip text-psx-foreground-secondary">
              {detail.checks.passed}/{detail.checks.total} checks passing
              {#if detail.checks.failed > 0}· {detail.checks.failed} failing{/if}
              {#if detail.checks.pending > 0}· {detail.checks.pending} running{/if}
            </span>
          {/if}
          {#if detail.changedFiles > 0}
            <span class="github-panel-chip text-psx-foreground-secondary">
              {detail.changedFiles} files
              <span class="text-psx-diff-insert-foreground">+{detail.additions}</span>
              <span class="text-psx-error-foreground">−{detail.deletions}</span>
            </span>
          {/if}
        </section>
      {/if}

      {#if checkRuns.length > 0}
        <section class="github-panel-section">
          <h3 class="github-panel-section-title">Checks</h3>
          <ul class="github-panel-list">
            {#each checkRuns as run (run.name + run.url)}
              {@const icon = checkIcon(run)}
              <li class="github-panel-check">
                {#if run.url}
                  <a
                    class="github-panel-check-row"
                    href={run.url}
                    aria-label={`Open ${run.name}`}
                    onclick={(event) => {
                      event.preventDefault();
                      openPR(run.url);
                    }}
                  >
                    <Icon name={icon.name} size={13} class={icon.class} />
                    <span class="github-panel-check-name" title={run.name}>{run.name}</span>
                  </a>
                {:else}
                  <span class="github-panel-check-row">
                    <Icon name={icon.name} size={13} class={icon.class} />
                    <span class="github-panel-check-name" title={run.name}>{run.name}</span>
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if reviews.length > 0}
        <section class="github-panel-section">
          <h3 class="github-panel-section-title">Reviews ({reviews.length})</h3>
          <ul class="github-panel-comments">
            {#each reviews as review (review.url + review.createdAt)}
              <li class="github-panel-comment">
                <div class="github-panel-comment-meta">
                  <span class="github-panel-comment-author">{review.author}</span>
                  <span class={["github-panel-review-state", `is-${review.state}`]}>
                    {reviewStateLabel(review.state)}
                  </span>
                  <span class="github-panel-comment-date">{formatDate(review.createdAt)}</span>
                </div>
                {#if review.body}
                  <div class="github-panel-markdown">
                    <GithubMarkdown content={review.body} />
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if comments.length > 0}
        <section class="github-panel-section">
          <h3 class="github-panel-section-title">
            Comments ({comments.length})
          </h3>
          <ul class="github-panel-comments">
            {#each comments as comment (comment.url + comment.createdAt)}
              <li class="github-panel-comment">
                <div class="github-panel-comment-meta">
                  <span class="github-panel-comment-author">{comment.author}</span>
                  <span class="github-panel-comment-date">{formatDate(comment.createdAt)}</span>
                </div>
                <div class="github-panel-markdown">
                  <GithubMarkdown content={comment.body} />
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if detail.body}
        <section class="github-panel-section">
          <h3 class="github-panel-section-title">Description</h3>
          <div class="github-panel-markdown">
            <GithubMarkdown content={detail.body} />
          </div>
        </section>
      {/if}
    </div>
  {/if}
</div>

<style lang="postcss">
  @reference "#tailwind.css";

  .github-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    outline: none;
    background: var(--color-psx-editor-background);
    color: var(--color-psx-foreground-primary);
  }

  .github-panel-centered {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 1.5rem;
    text-align: center;
  }

  .github-panel-message {
    color: var(--color-psx-foreground-secondary);
    font-size: 13px;
    line-height: 18px;
  }

  .github-panel-hint {
    color: var(--color-psx-foreground-tertiary);
    font-size: 12px;
  }

  .github-panel-hint code,
  .github-panel-message code {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    background: var(--color-psx-menu-hover-background);
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
  }

  .github-panel-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.75rem 1rem 1.5rem;
  }

  .github-panel-header {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--color-psx-border);
  }

  .github-panel-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .github-panel-state-dot {
    flex-shrink: 0;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 9999px;
  }

  .github-panel-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 20px;
  }

  .github-panel-subtitle {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-psx-foreground-secondary);
    font-size: 12px;
  }

  .github-panel-state {
    color: var(--color-psx-foreground-primary);
    font-weight: 600;
  }

  .github-panel-branch {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
  }

  .github-panel-actions {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.2rem;
  }

  .github-panel-button {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border: 1px solid var(--color-psx-button-secondary-border);
    background: var(--color-psx-button-secondary-background);
    color: var(--color-psx-button-secondary-foreground);
    border-radius: 6px;
    padding: 0.25rem 0.6rem;
    font-size: 12px;
    cursor: pointer;
  }

  .github-panel-button:hover {
    background: var(--color-psx-button-secondary-hover-background);
    border-color: var(--color-psx-button-secondary-hover-border);
  }

  .github-panel-button--ghost {
    padding: 0.25rem 0.4rem;
  }

  .github-panel-section {
    margin-top: 1rem;
  }

  .github-panel-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
  }

  .github-panel-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 12px;
  }

  .github-panel-section-title {
    margin: 0 0 0.5rem;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-psx-foreground-tertiary);
  }

  .github-panel-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .github-panel-check {
    font-size: 12px;
  }

  .github-panel-check-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    width: 100%;
    border-radius: 6px;
    padding: 0.2rem 0.25rem;
    color: inherit;
    text-decoration: none;
  }

  a.github-panel-check-row {
    cursor: pointer;
  }

  a.github-panel-check-row:hover {
    background: var(--color-psx-menu-hover-background);
  }

  a.github-panel-check-row:focus-visible {
    outline: 2px solid var(--color-psx-focus);
    outline-offset: 1px;
  }

  .github-panel-check-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-psx-foreground-secondary);
  }

  .github-panel-comments {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .github-panel-comment {
    border: 1px solid var(--color-psx-border);
    border-radius: 8px;
    padding: 0.5rem 0.6rem;
  }

  .github-panel-comment-meta {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
    font-size: 11px;
  }

  .github-panel-comment-author {
    font-weight: 600;
    color: var(--color-psx-foreground-primary);
  }

  .github-panel-comment-date {
    color: var(--color-psx-foreground-tertiary);
  }

  .github-panel-review-state {
    font-size: 11px;
    color: var(--color-psx-foreground-tertiary);
  }

  .github-panel-review-state.is-approved {
    color: var(--color-psx-diff-insert-foreground);
  }

  .github-panel-review-state.is-changes_requested {
    color: var(--color-psx-error-foreground);
  }

  .github-panel-markdown {
    font-size: 12px;
    line-height: 18px;
    color: var(--color-psx-foreground-secondary);
    word-break: break-word;
  }

  .github-panel-markdown :global(p:first-child) {
    margin-top: 0;
  }

  .github-panel-markdown :global(p:last-child) {
    margin-bottom: 0;
  }
</style>
