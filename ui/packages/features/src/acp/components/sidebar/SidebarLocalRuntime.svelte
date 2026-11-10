<script lang="ts">
  import Icon from "@camber/components/icon";
  import { formatError } from "@camber/lib/errors";
  import { InfoMessageType } from "@camber/rpc";
  import { LOCAL_AGENT_SERVER } from "../../agentServers";
  import { getLocalInferenceRepo } from "../../features/LocalInferenceRepository.svelte";
  import { getACPSessionRepo } from "../../features/SessionRepository.svelte";
  import { rpc } from "../../hostRpc";
  import {
    formatAutoUnload,
    formatLastPrompt,
    formatMemoryBytes,
    localRuntimeResidency,
  } from "../../localInferenceRuntime";
  import ConfirmationDialog from "../ui/ConfirmationDialog.svelte";
  import Tooltip from "../ui/Tooltip.svelte";

  interface Props {
    // Container classes; the parent controls placement (inline vs floating).
    class?: string;
    onShowSettings: () => void;
  }

  let { class: containerClass = "", onShowSettings }: Props = $props();

  const localInference = getLocalInferenceRepo();
  // The session repository context is set app-wide, but stay defensive like
  // the other local-inference surfaces: without it we simply skip the
  // active-response check.
  function optionalSessionRepo(): ReturnType<typeof getACPSessionRepo> | null {
    try {
      return getACPSessionRepo();
    } catch {
      return null;
    }
  }
  const sessions = optionalSessionRepo();
  const RESIDENCY_CLOCK_INTERVAL_MS = 30_000;
  const UNLOAD_RETRY_ATTEMPTS = 8;
  const UNLOAD_RETRY_DELAY_MS = 500;

  let nowMs = $state(Date.now());
  let unloading = $state(false);
  let confirmStopAndUnload = $state(false);

  const residency = $derived(localRuntimeResidency(localInference.state));

  // "Last prompt"/"frees automatically" read relative to now; keep them ticking
  // while a model is actually resident, and stop the timer the moment it isn't
  // (nothing to keep fresh, and the pill itself renders nothing). The interval
  // alone is not enough: WKWebView suspends timers while the window is hidden,
  // so nowMs would freeze and reappear hours stale (e.g. "frees in ~331 min").
  // Refresh eagerly on every residency change and when the webview becomes
  // visible again.
  $effect(() => {
    if (!residency) return;
    const refresh = () => {
      nowMs = Date.now();
    };
    refresh();
    const interval = setInterval(refresh, RESIDENCY_CLOCK_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  });

  function capitalize(text: string): string {
    return text.length > 0 ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
  }

  async function reclaimMemory(event: MouseEvent) {
    event.stopPropagation();
    if (unloading || confirmStopAndUnload) return;
    if ((sessions?.promptingSessionsForAgent(LOCAL_AGENT_SERVER).length ?? 0) > 0) {
      // The model is mid-response; unloading would rip it out from under the
      // turn. Confirm, then stop the response(s) before evicting.
      confirmStopAndUnload = true;
      return;
    }
    unloading = true;
    try {
      await localInference.unloadModel();
    } catch (error) {
      rpc.showInfoMessage(
        formatError(error, { prefix: "Failed to reclaim model memory" }),
        InfoMessageType.error,
      );
    } finally {
      unloading = false;
    }
  }

  // Dialog confirm: stop every active local response, then evict. Errors
  // surface inside the dialog (ConfirmationDialog renders what onConfirm
  // throws and stays open).
  async function stopResponsesAndUnload() {
    unloading = true;
    try {
      const prompting = sessions?.promptingSessionsForAgent(LOCAL_AGENT_SERVER) ?? [];
      await Promise.allSettled(prompting.map((session) => session.cancel()));
      // The sidecar refuses to unload while a request is in flight and the
      // cancelled generation can take a moment to wind down; retry briefly.
      for (let attempt = 0; ; attempt++) {
        await localInference.unloadModel();
        if (!localInference.state?.runtime.loadedModelId) break;
        if (attempt >= UNLOAD_RETRY_ATTEMPTS) {
          throw new Error("The model is still finishing a response — try again in a moment");
        }
        await new Promise((resolve) => setTimeout(resolve, UNLOAD_RETRY_DELAY_MS));
      }
      confirmStopAndUnload = false;
    } finally {
      unloading = false;
    }
  }
</script>

{#if residency}
  {@const memoryLabel = formatMemoryBytes(residency.memoryBytes)}
  {@const lastPromptLabel = formatLastPrompt(residency.lastActivityUnixMs, nowMs)}
  {@const autoUnloadLabel = formatAutoUnload(residency, nowMs)}
  <div class={containerClass}>
    <div
      class="text-psx-foreground-primary hover:bg-psx-menu-hover-background group mt-1 flex w-full min-w-0 items-center overflow-hidden rounded-lg bg-transparent transition-colors"
    >
      <Tooltip placement="top" gutter={8} openDelay={200} class="min-w-0 flex-1">
        {#snippet label()}
          <span class="flex max-w-72 flex-col gap-1 text-left">
            <span class="font-medium">{residency.modelName} is loaded</span>
            {#if memoryLabel}
              <span>Memory: {memoryLabel}</span>
            {/if}
            {#if lastPromptLabel}
              <span>Last prompt: {lastPromptLabel}</span>
            {/if}
            {#if autoUnloadLabel}
              <span>{capitalize(autoUnloadLabel)}</span>
            {/if}
          </span>
        {/snippet}
        <button
          type="button"
          class="outline-hidden focus-visible:outline-psx-focus flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left focus-visible:outline-2"
          aria-label={`Open on-device model settings for ${residency.modelName}`}
          onclick={onShowSettings}
        >
          <Icon name="on-device" size={12} class="text-psx-icon shrink-0" aria-hidden="true" />
          <span
            class="group-hover:text-psx-foreground-primary text-psx-foreground-secondary min-w-0 max-w-full truncate text-[11px]/[14px]"
          >
            {residency.modelName}{memoryLabel ? ` · ${memoryLabel}` : ""}
          </span>
        </button>
      </Tooltip>
      <Tooltip placement="top" gutter={8} openDelay={200}>
        {#snippet label()}
          <span>Unload Model from Memory</span>
        {/snippet}
        <button
          type="button"
          class="text-psx-foreground-secondary hover:bg-psx-menu-hover-background hover:text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus mr-1 flex size-6 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60"
          aria-label="Unload Model from Memory"
          disabled={unloading}
          onclick={(event) => void reclaimMemory(event)}
        >
          <Icon name="stop" size={14} />
        </button>
      </Tooltip>
    </div>
  </div>
  {#if confirmStopAndUnload}
    <ConfirmationDialog
      title="Stop response and unload model?"
      description={`${residency.modelName} is currently responding. Unloading it will stop the response and free ${memoryLabel ? `${memoryLabel} of` : "its"} memory.`}
      confirmLabel="Stop and Unload"
      onCancel={() => {
        confirmStopAndUnload = false;
      }}
      onConfirm={stopResponsesAndUnload}
    />
  {/if}
{/if}
