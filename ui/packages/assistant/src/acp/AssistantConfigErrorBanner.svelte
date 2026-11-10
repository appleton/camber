<script lang="ts">
  import Icon from "@camber/components/icon";
  import {
    appState,
    canOpenAssistantConfigFile,
    extractErrorMessage,
    getACPAgentServersRepo,
    openAssistantConfigFile,
  } from "@camber/features/acp";
  import { isFailure, isLoading } from "@camber/lib/async-state";
  import Button from "../lib/ui/CamberButton.svelte";

  const agentServers = getACPAgentServersRepo();

  let dismissedError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let configError = $derived(
    isFailure(agentServers.state) ? agentServers.state.error.message : null,
  );
  let shouldShow = $derived(configError != null && dismissedError !== configError);
  let isRetrying = $derived(isLoading(agentServers.state));
  let canOpenFile = $derived(canOpenAssistantConfigFile($appState.environment.assistantHost));

  $effect(() => {
    if (agentServers.state.status === "success") {
      dismissedError = null;
      actionError = null;
    }
  });

  function handleDismiss() {
    if (configError) dismissedError = configError;
    actionError = null;
  }

  async function handleOpenFile() {
    actionError = null;
    try {
      await openAssistantConfigFile();
    } catch (error) {
      actionError = extractErrorMessage(error, "Couldn’t open assistant.json");
    }
  }

  async function handleRetry() {
    actionError = null;
    await agentServers.refresh();
  }
</script>

{#if shouldShow && configError}
  <div
    role="alert"
    class="mb-2 flex w-full items-start justify-between gap-2 rounded-[10px] border border-psx-error-foreground/30 bg-psx-error-foreground/10 px-2 py-1.5"
  >
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-1.5">
        <Icon name="alert" size={16} class="shrink-0 text-psx-error-foreground" />
        <span class="truncate text-[13px]/tight text-psx-foreground-secondary">
          Couldn’t load assistant.json
        </span>
      </div>
      <div class="mt-0.5 text-[12px]/[16px] text-psx-foreground-tertiary">
        Camber is using the last successfully loaded agent configuration.
      </div>
      <div
        class="mt-1 line-clamp-2 text-[12px]/[16px] break-words text-psx-error-foreground"
        title={configError}
      >
        {configError}
      </div>
      {#if actionError}
        <div class="mt-1 text-[12px]/[16px] text-psx-error-foreground">
          {actionError}
        </div>
      {/if}
    </div>

    <div class="flex shrink-0 flex-wrap items-center justify-end gap-1">
      <Button appearance="ghost" size="small" onclick={handleDismiss}>Dismiss</Button>
      <Button appearance="ghost" size="small" onclick={handleRetry} disabled={isRetrying}>
        {isRetrying ? "Retrying" : "Retry"}
      </Button>
      {#if canOpenFile}
        <Button appearance="secondary" size="small" onclick={handleOpenFile} class="-mr-0.5">
          Open file
        </Button>
      {/if}
    </div>
  </div>
{/if}
