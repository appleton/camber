<script lang="ts" module>
  export interface StartupIssue {
    kind: "slow" | "failed";
    message?: string;
    // Whether force-revealing the app is an option (i.e. it has mounted).
    canContinue?: boolean;
  }
</script>

<script lang="ts">
  import { CAMBER_ROUNDEL_ICON_URL, StreamingIndicator } from "@camber/features/acp/startup";

  interface Props {
    onCopyReport: () => Promise<void>;
    onShowLogs: () => void;
    onKeepWaiting: () => void;
    onContinueAnyway: () => void;
    onRetry: () => void;
  }

  let { onCopyReport, onShowLogs, onKeepWaiting, onContinueAnyway, onRetry }: Props = $props();

  let issue = $state<StartupIssue | null>(null);
  let copyState = $state<"idle" | "copying" | "copied" | "failed">("idle");
  let panelElement = $state<HTMLDivElement>();

  // Called by startup.ts when the watchdog trips or start() rejects.
  export function showIssue(next: StartupIssue): void {
    issue = next;
    copyState = "idle";
  }

  // Land keyboard/screen-reader users on the primary action instead of an
  // otherwise-empty document.
  $effect(() => {
    if (issue === null) return;
    panelElement?.querySelector<HTMLButtonElement>("button.primary")?.focus();
  });

  async function copyReport() {
    if (copyState === "copying") return;
    copyState = "copying";
    try {
      await onCopyReport();
      copyState = "copied";
    } catch {
      copyState = "failed";
    }
  }

  function keepWaiting() {
    issue = null;
    copyState = "idle";
    onKeepWaiting();
  }

  const copyLabel = $derived(
    copyState === "copied"
      ? "Copied"
      : copyState === "failed"
        ? "Copy failed — try Show logs"
        : "Copy diagnostic report",
  );
</script>

<div class="desktop-startup-working">
  {#if issue === null}
    <StreamingIndicator iconUrl={CAMBER_ROUNDEL_ICON_URL} size={24} />
  {:else}
    <div
      bind:this={panelElement}
      class="desktop-startup-issue"
      role="alertdialog"
      aria-labelledby="desktop-startup-issue-title"
    >
      <h1 id="desktop-startup-issue-title">
        {issue.kind === "failed"
          ? "Camber couldn’t start"
          : "Camber is taking longer than expected to start"}
      </h1>
      {#if issue.message}
        <p class="desktop-startup-issue-message">{issue.message}</p>
      {/if}
      <p>
        {issue.kind === "failed"
          ? "Retry, or copy a diagnostic report to share with the Camber team."
          : "Something may have gone wrong. You can keep waiting, retry, or copy a diagnostic report to share with the Camber team."}
      </p>
      <div class="desktop-startup-issue-actions">
        {#if issue.kind === "failed"}
          <button type="button" class="primary" onclick={onRetry}>Retry</button>
        {:else}
          <button type="button" class="primary" onclick={keepWaiting}>Keep waiting</button>
          <button type="button" onclick={onRetry}>Retry</button>
          {#if issue.canContinue ?? true}
            <button type="button" onclick={onContinueAnyway}>Continue anyway</button>
          {/if}
        {/if}
        <button type="button" onclick={copyReport} disabled={copyState === "copying"}>
          {copyLabel}
        </button>
        <button type="button" onclick={onShowLogs}>Show logs</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .desktop-startup-working {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
  }

  .desktop-startup-issue {
    display: flex;
    max-width: 26rem;
    flex-direction: column;
    align-items: center;
    padding: 0 1.5rem;
    animation: desktop-startup-issue-fade-in 200ms ease-out;
    color: light-dark(#1f1f1f, #e6e6e6);
    gap: 0.75rem;
    text-align: center;
  }

  h1 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }

  p {
    margin: 0;
    color: light-dark(#5c5c5c, #a0a0a0);
    font-size: 0.8125rem;
    line-height: 1.4;
  }

  .desktop-startup-issue-message {
    overflow: hidden;
    max-width: 100%;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }

  .desktop-startup-issue-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    margin-top: 0.5rem;
    gap: 0.5rem;
  }

  button {
    padding: 0.3125rem 0.75rem;
    border: 1px solid light-dark(rgb(0 0 0 / 20%), rgb(255 255 255 / 20%));
    border-radius: 0.375rem;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: 0.8125rem;
  }

  button:hover:enabled {
    background: light-dark(rgb(0 0 0 / 5%), rgb(255 255 255 / 8%));
  }

  button:disabled {
    cursor: default;
    opacity: 0.6;
  }

  button.primary {
    border-color: transparent;
    background: light-dark(#1f1f1f, #e6e6e6);
    color: light-dark(#ffffff, #1f1f1f);
  }

  button.primary:hover:enabled {
    background: light-dark(#3a3a3a, #cccccc);
  }

  @keyframes desktop-startup-issue-fade-in {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }
</style>
