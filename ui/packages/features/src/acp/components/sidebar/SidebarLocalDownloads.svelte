<script lang="ts">
  import Icon from "@camber/components/icon";
  import type { LocalInferenceDownloadState } from "@camber/helperapi/schemas";
  import { formatError } from "@camber/lib/errors";
  import { InfoMessageType } from "@camber/rpc";
  import { onMount } from "svelte";
  import { getLocalInferenceRepo } from "../../features/LocalInferenceRepository.svelte";
  import { rpc } from "../../hostRpc";
  import {
    formatLocalInferenceDownloadCounts,
    formatLocalInferenceDownloadEta,
    formatLocalInferenceDownloadSpeed,
    localInferenceDownloadPercent,
    localInferenceDownloadProgressWidth,
    localInferenceDownloads,
  } from "../../localInferenceDownload";
  import Tooltip from "../ui/Tooltip.svelte";

  interface Props {
    // Container classes; the parent controls placement (inline vs floating).
    class?: string;
    onShowSettings: () => void;
  }

  let { class: containerClass = "", onShowSettings }: Props = $props();

  const localInference = getLocalInferenceRepo();
  const LOCAL_DOWNLOAD_PAUSED_HIDE_DELAY_MS = 3000;

  let pausingLocalDownloadId = $state<string | null>(null);
  let resumingLocalDownloadId = $state<string | null>(null);
  let hoveredLocalDownloadIds = $state(new Set<string>());
  // Paused (status "cancelled") downloads normally leave the list; while the
  // user is interacting with a pill we retain them briefly so the pause/resume
  // toggle doesn't vanish under the pointer.
  let retainedPausedLocalDownloadIds = $state(new Set<string>());
  const retainedPausedLocalDownloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let activeLocalDownloads = $derived.by(() => {
    const downloads = localInferenceDownloads(localInference.state);
    return downloads
      .filter(
        (download) =>
          download.status === "resolving" ||
          download.status === "downloading" ||
          (download.status === "cancelled" && retainedPausedLocalDownloadIds.has(download.modelId)),
      )
      .map((download) => {
        const model = localInference.state?.catalog.find(
          (candidate) =>
            candidate.id === download.modelId ||
            candidate.repoId === download.modelId ||
            candidate.download?.modelId === download.modelId,
        );
        return { download, modelName: model?.name ?? download.modelId };
      });
  });

  $effect(() => {
    const downloadsByModelId = new Map(
      localInferenceDownloads(localInference.state).map((download) => [download.modelId, download]),
    );
    const nextRetained = new Set(retainedPausedLocalDownloadIds);
    const nextHovered = new Set(hoveredLocalDownloadIds);
    let retainedChanged = false;
    let hoveredChanged = false;

    for (const modelId of retainedPausedLocalDownloadIds) {
      const download = downloadsByModelId.get(modelId);
      if (!download || (download.status !== "cancelled" && pausingLocalDownloadId !== modelId)) {
        clearRetainedPausedLocalDownloadTimer(modelId);
        retainedChanged = nextRetained.delete(modelId) || retainedChanged;
        hoveredChanged = nextHovered.delete(modelId) || hoveredChanged;
        continue;
      }

      if (download.status === "cancelled" && !hoveredLocalDownloadIds.has(modelId)) {
        scheduleRetainedPausedLocalDownloadDismiss(modelId);
      }
    }

    if (retainedChanged) {
      retainedPausedLocalDownloadIds = nextRetained;
    }
    if (hoveredChanged) {
      hoveredLocalDownloadIds = nextHovered;
    }
  });

  $effect(() => {
    return () => {
      for (const timer of retainedPausedLocalDownloadTimers.values()) {
        clearTimeout(timer);
      }
      retainedPausedLocalDownloadTimers.clear();
    };
  });

  onMount(() => {
    if (!localInference.state && !localInference.loading) {
      void localInference.refresh().catch(() => {});
    }
  });

  function clearRetainedPausedLocalDownloadTimer(modelId: string) {
    const timer = retainedPausedLocalDownloadTimers.get(modelId);
    if (!timer) return;
    clearTimeout(timer);
    retainedPausedLocalDownloadTimers.delete(modelId);
  }

  function scheduleRetainedPausedLocalDownloadDismiss(modelId: string) {
    if (!retainedPausedLocalDownloadIds.has(modelId)) return;
    clearRetainedPausedLocalDownloadTimer(modelId);
    retainedPausedLocalDownloadTimers.set(
      modelId,
      setTimeout(() => {
        retainedPausedLocalDownloadTimers.delete(modelId);
        forgetRetainedPausedLocalDownload(modelId);
      }, LOCAL_DOWNLOAD_PAUSED_HIDE_DELAY_MS),
    );
  }

  function retainPausedLocalDownload(modelId: string) {
    clearRetainedPausedLocalDownloadTimer(modelId);
    retainedPausedLocalDownloadIds = new Set(retainedPausedLocalDownloadIds).add(modelId);
  }

  function forgetRetainedPausedLocalDownload(modelId: string) {
    clearRetainedPausedLocalDownloadTimer(modelId);
    if (retainedPausedLocalDownloadIds.has(modelId)) {
      const nextRetained = new Set(retainedPausedLocalDownloadIds);
      nextRetained.delete(modelId);
      retainedPausedLocalDownloadIds = nextRetained;
    }
    if (hoveredLocalDownloadIds.has(modelId)) {
      const nextHovered = new Set(hoveredLocalDownloadIds);
      nextHovered.delete(modelId);
      hoveredLocalDownloadIds = nextHovered;
    }
  }

  function handleLocalDownloadPointerEnter(modelId: string) {
    clearRetainedPausedLocalDownloadTimer(modelId);
    hoveredLocalDownloadIds = new Set(hoveredLocalDownloadIds).add(modelId);
  }

  function handleLocalDownloadPointerLeave(modelId: string) {
    if (hoveredLocalDownloadIds.has(modelId)) {
      const nextHovered = new Set(hoveredLocalDownloadIds);
      nextHovered.delete(modelId);
      hoveredLocalDownloadIds = nextHovered;
    }
    const download = localInferenceDownloads(localInference.state).find(
      (candidate) => candidate.modelId === modelId,
    );
    if (download?.modelId === modelId && download.status === "cancelled") {
      scheduleRetainedPausedLocalDownloadDismiss(modelId);
    }
  }

  function localDownloadActionDisabled(download: LocalInferenceDownloadState): boolean {
    return (
      pausingLocalDownloadId === download.modelId || resumingLocalDownloadId === download.modelId
    );
  }

  async function toggleLocalDownload(event: MouseEvent, download: LocalInferenceDownloadState) {
    if (download.status === "cancelled") {
      await resumeLocalDownload(event, download.modelId);
    } else {
      await pauseLocalDownload(event, download.modelId);
    }
  }

  async function pauseLocalDownload(event: MouseEvent, modelId: string) {
    event.stopPropagation();
    if (pausingLocalDownloadId || resumingLocalDownloadId) return;
    pausingLocalDownloadId = modelId;
    retainPausedLocalDownload(modelId);
    try {
      await localInference.cancelDownload(modelId);
    } catch (error) {
      forgetRetainedPausedLocalDownload(modelId);
      rpc.showInfoMessage(
        formatError(error, { prefix: "Failed to pause model download" }),
        InfoMessageType.error,
      );
    } finally {
      pausingLocalDownloadId = null;
    }
  }

  async function resumeLocalDownload(event: MouseEvent, modelId: string) {
    event.stopPropagation();
    if (pausingLocalDownloadId || resumingLocalDownloadId) return;
    clearRetainedPausedLocalDownloadTimer(modelId);
    resumingLocalDownloadId = modelId;
    try {
      await localInference.downloadModel(modelId);
      forgetRetainedPausedLocalDownload(modelId);
    } catch (error) {
      rpc.showInfoMessage(
        formatError(error, { prefix: "Failed to resume model download" }),
        InfoMessageType.error,
      );
    } finally {
      resumingLocalDownloadId = null;
    }
  }
</script>

{#snippet localDownloadTooltip(download: LocalInferenceDownloadState, modelName: string)}
  <span class="flex max-w-72 flex-col gap-1 text-left">
    <span class="font-medium">{modelName}</span>
    {#if localInferenceDownloadPercent(download)}
      <span>Progress: {localInferenceDownloadPercent(download)}</span>
    {/if}
    <span>Downloaded: {formatLocalInferenceDownloadCounts(download) ?? "Resolving files"}</span>
    {#if download.status === "cancelled"}
      <span>Status: Paused</span>
    {:else}
      <span>Speed: {formatLocalInferenceDownloadSpeed(download) ?? "Calculating"}</span>
      <span>ETA: {formatLocalInferenceDownloadEta(download) ?? "Calculating"}</span>
    {/if}
  </span>
{/snippet}

{#if activeLocalDownloads.length > 0}
  <div class={containerClass}>
    {#each activeLocalDownloads as item (item.download.modelId)}
      <Tooltip placement="top" gutter={8} openDelay={200} class="w-full">
        {#snippet label()}
          {@render localDownloadTooltip(item.download, item.modelName)}
        {/snippet}
        <div
          class="text-psx-foreground-primary hover:bg-psx-menu-hover-background group flex w-full min-w-0 flex-col overflow-hidden rounded-lg bg-transparent transition-colors"
          onpointerenter={() => handleLocalDownloadPointerEnter(item.download.modelId)}
          onpointerleave={() => handleLocalDownloadPointerLeave(item.download.modelId)}
        >
          <div class="flex min-w-0 items-end gap-1">
            <button
              type="button"
              class="outline-hidden focus-visible:outline-psx-focus flex min-w-0 flex-1 flex-col gap-1 px-2 pb-1 pt-1.5 text-left focus-visible:outline-2"
              aria-label={`Open on-device model settings for ${item.modelName}`}
              onclick={onShowSettings}
            >
              <span class="block h-1 w-full overflow-hidden rounded-full bg-gray-200">
                {#if item.download.status === "resolving"}
                  <span
                    class="local-sidebar-download-progress-indeterminate block h-full w-1/3 rounded-full bg-blue-500"
                  ></span>
                {:else}
                  <span
                    class="block h-full min-w-1 rounded-full bg-blue-500 transition-[width] duration-500 ease-out"
                    style:width={localInferenceDownloadProgressWidth(item.download)}
                  ></span>
                {/if}
              </span>
              <span
                class="group-hover:text-psx-foreground-primary text-psx-foreground-secondary min-w-0 max-w-full truncate text-[11px]/[14px]"
              >
                {item.download.status === "cancelled" ? "Paused" : "Downloading"}
                {item.modelName}
              </span>
            </button>
            <button
              type="button"
              class="text-psx-foreground-secondary hover:bg-psx-menu-hover-background hover:text-psx-foreground-primary outline-hidden focus-visible:outline-psx-focus mb-1 mr-1 flex size-6 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60"
              aria-label={`${item.download.status === "cancelled" ? "Resume" : "Pause"} ${item.modelName} download`}
              disabled={localDownloadActionDisabled(item.download)}
              onclick={(event) => void toggleLocalDownload(event, item.download)}
            >
              <Icon name={item.download.status === "cancelled" ? "run" : "pause"} size={14} />
            </button>
          </div>
        </div>
      </Tooltip>
    {/each}
  </div>
{/if}

<style>
  @keyframes local-sidebar-download-progress-slide {
    from {
      transform: translateX(-110%);
    }
    to {
      transform: translateX(310%);
    }
  }

  .local-sidebar-download-progress-indeterminate {
    animation: local-sidebar-download-progress-slide 1.35s ease-in-out infinite;
  }
</style>
