<script lang="ts">
  import Icon from "@camber/components/icon";
  import Button from "../lib/ui/CamberButton.svelte";
  import {
    extractErrorMessage,
    getACPAgentUpdateRepo,
    getACPChatSessionScope,
    normalizeAgentServerName,
  } from "@camber/features/acp";

  const updates = getACPAgentUpdateRepo();
  const chatSession = getACPChatSessionScope();

  let dismissedUpdate = $state<string | null>(null);
  let activeAgentServer = $derived(chatSession.activeAgentServer);
  let normalizedAgentServer = $derived(normalizeAgentServerName(activeAgentServer));
  let activeUpdate = $derived(updates.updateFor(normalizedAgentServer));
  let activeAgentName = $derived(
    activeUpdate?.agent.name.trim().replace(/\s+agent$/i, "") ?? "ACP",
  );
  let progress = $derived(updates.progressFor(normalizedAgentServer));
  let isUpdating = $derived(updates.busyAgentServer === normalizedAgentServer);
  let isInstall = $derived(activeUpdate?.kind === "install");
  let isRestart = $derived(activeUpdate?.kind === "restart");
  let restartBlocked = $derived(isRestart && updates.restartBlockedFor(normalizedAgentServer));
  let updateKey = $derived(
    `${normalizedAgentServer}:${activeUpdate?.kind}:${activeUpdate?.agent.version}`,
  );
  let shouldShow = $derived(activeUpdate != null && (isUpdating || dismissedUpdate !== updateKey));
  let updateFailure = $state<{ agentServer: string; message: string } | null>(null);
  let updateError = $derived(
    updateFailure?.agentServer === normalizedAgentServer ? updateFailure.message : null,
  );

  async function handleUpdate() {
    const agentServer = normalizedAgentServer;
    const agentName = activeAgentName;
    dismissedUpdate = null;
    updateFailure = null;
    try {
      await updates.update(agentServer);
    } catch (error) {
      updateFailure = {
        agentServer,
        message:
          updates.error ??
          extractErrorMessage(error, `The ${agentName} agent updater did not return error details`),
      };
    }
  }

  function handleDismiss() {
    updateFailure = null;
    dismissedUpdate = updateKey;
  }
</script>

{#if shouldShow && activeUpdate}
  <div
    class="mb-2 flex w-full items-center justify-between gap-2 rounded-[10px] border border-psx-border bg-psx-chrome px-2 py-1.5"
  >
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-1.5">
        <Icon name="package" size={16} class="shrink-0 text-amber-600 dark:text-amber-400/80" />
        <span class="truncate text-[13px]/tight text-psx-foreground-secondary">
          {isInstall
            ? `${activeAgentName} agent is configured but not installed on this machine`
            : isRestart
              ? `Restart required for the ${activeAgentName} agent`
              : `Update available for the ${activeAgentName} agent`}
        </span>
      </div>
      {#if !progress}
        <div class="mt-0.5 text-[12px]/[16px] text-psx-foreground-tertiary">
          {#if isInstall}
            Install the local ACP agent package to use this agent on this machine.
          {:else if isRestart}
            Version {activeUpdate.agent.version} is installed. {restartBlocked
              ? "Wait for this agent’s running conversations to finish, then restart to use it."
              : "Restart the agent to use it and refresh available models."}
          {:else}
            This updates the local ACP agent used for chats, not the Camber Assistant app.
          {/if}
        </div>
      {/if}

      {#if progress}
        <div class="mt-1.5">
          <div
            class="mb-1 flex items-center justify-between text-[11px] text-psx-foreground-tertiary"
          >
            <span>{progress.label}</span>
            <span>{progress.width}</span>
          </div>
          <div class="mb-1 text-[12px]/[16px] text-psx-foreground-tertiary">
            {#if isInstall}
              Installing the local ACP agent package for this machine.
            {:else if isRestart}
              Restarting the agent and refreshing available models.
            {:else}
              Updating the local ACP agent used for chats, not the Camber Assistant app.
            {/if}
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-psx-chrome-hover">
            <div
              class="h-full rounded-full bg-psx-vibrant transition-[width] duration-300"
              style:width={progress.width}
            ></div>
          </div>
        </div>
      {/if}

      {#if updateError}
        <div
          role="alert"
          class="mt-1.5 flex min-w-0 items-start gap-1 text-[12px]/[16px] text-psx-error-foreground"
          title={updateError}
        >
          <Icon name="alert" size={14} class="mt-px shrink-0 self-start" />
          <div class="min-w-0">
            <div>
              Couldn’t {isRestart ? "restart" : "update"} the {activeAgentName} agent{isRestart
                ? "."
                : ` to version ${activeUpdate.agent.version}.`}
            </div>
            <div class="line-clamp-2 break-words text-psx-foreground-tertiary">
              {updateError}
            </div>
          </div>
        </div>
      {/if}
    </div>

    <div class="flex shrink-0 items-center gap-1">
      {#if !isUpdating}
        <Button appearance="ghost" size="small" onclick={handleDismiss}>Dismiss</Button>
      {/if}
      <Button
        appearance="secondary"
        size="small"
        onclick={handleUpdate}
        disabled={updates.busyAgentServer != null || restartBlocked}
        class="-mr-0.5"
      >
        {isUpdating
          ? updates.busyLabel(normalizedAgentServer)
          : updateError
            ? "Retry"
            : isInstall
              ? "Install agent"
              : isRestart
                ? "Restart agent"
                : "Update agent"}
      </Button>
    </div>
  </div>
{/if}
