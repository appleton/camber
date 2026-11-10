<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import type { VoiceInputDownloadState, VoiceInputModel } from "@camber/helperapi";
  import { getUnknownErrorMessage } from "@camber/lib/errors";
  import { onMount } from "svelte";
  import { appState } from "../hostAdapter";
  import { rpc } from "../hostRpc";
  import { shortenHomeDirectoryInText } from "../shared/paths";
  import { voiceInputStore } from "./chat/speech/voiceInputStore.svelte";
  import {
    dangerPillButtonClass,
    primaryPillButtonClass,
    secondaryPillButtonClass,
  } from "./settings/pillButtonStyles";
  import SettingsSection from "./settings/SettingsSection.svelte";

  const store = voiceInputStore;

  type VoiceRecognitionDesktopRPC = typeof rpc & {
    openPathWithOpener(path: string, openerId: string): Promise<void>;
  };

  const desktopRpc = rpc as VoiceRecognitionDesktopRPC;

  let actionError = $state<string | null>(null);
  let pendingModelId = $state<string | null>(null);

  let voiceState = $derived(store.state);
  let models = $derived(
    [...(voiceState?.models ?? [])].sort(
      (left, right) => Number(Boolean(right.recommended)) - Number(Boolean(left.recommended)),
    ),
  );
  let unsupported = $derived(store.availability === "unsupported");

  onMount(() => {
    void store.ensureLoaded();
    void store.refresh();
  });

  async function runModelAction(modelId: string, action: () => Promise<void>): Promise<void> {
    if (pendingModelId) return;
    pendingModelId = modelId;
    actionError = null;
    try {
      await action();
    } catch (error) {
      actionError = getUnknownErrorMessage(error);
    } finally {
      pendingModelId = null;
    }
  }

  function downloadFor(model: VoiceInputModel): VoiceInputDownloadState | undefined {
    const download = voiceState?.download;
    return download?.modelId === model.id ? download : undefined;
  }

  function isDownloading(download: VoiceInputDownloadState | undefined): boolean {
    return download?.status === "downloading";
  }

  function downloadLabel(download: VoiceInputDownloadState): string {
    if (download.status === "failed") return download.error ?? "Download failed";
    if (download.status === "cancelled") return "Download cancelled";
    if (download.status === "completed") return "Download complete";
    return "Downloading";
  }

  function downloadDetail(download: VoiceInputDownloadState): string {
    const parts: string[] = [];
    if (download.bytesTotal) {
      parts.push(
        `${formatMegabytes(download.bytesDownloaded ?? 0)} / ${formatMegabytes(download.bytesTotal)}`,
      );
    }
    if (download.bytesPerSecond) parts.push(`${formatMegabytes(download.bytesPerSecond)}/s`);
    if (download.etaSeconds) parts.push(`${Math.max(1, Math.round(download.etaSeconds))}s left`);
    return parts.join(" · ");
  }

  function progressWidth(download: VoiceInputDownloadState): string {
    if (!download.bytesTotal) return "10%";
    const percent = Math.min(
      100,
      Math.round(((download.bytesDownloaded ?? 0) / download.bytesTotal) * 100),
    );
    return `${Math.max(2, percent)}%`;
  }

  function formatMegabytes(bytes: number): string {
    return `${Math.round(bytes / (1 << 20))} MB`;
  }

  function modelSize(model: VoiceInputModel): string | undefined {
    return model.downloadBytes ? formatMegabytes(model.downloadBytes) : undefined;
  }

  async function openModelsDirectory(path: string): Promise<void> {
    actionError = null;
    try {
      await desktopRpc.openPathWithOpener(path, "default");
    } catch (error) {
      actionError = getUnknownErrorMessage(error);
    }
  }
</script>

{#if store.availability !== "unknown" && (!unsupported || voiceState?.unavailableReason)}
  <SettingsSection
    title="Voice Recognition"
    subtitle="Local Whisper models that transcribe dictation from this desktop and paired phones."
  >
    <div class="voice-catalog px-3 pb-4 pt-3">
      {#if unsupported}
        <p class="text-psx-foreground-secondary text-[13px]/[18px]">
          {voiceState?.unavailableReason ?? "Voice recognition is unavailable on this machine."}
        </p>
      {:else}
        {#if voiceState?.modelsDirectory}
          {@const modelsDirectory = voiceState.modelsDirectory}
          {@const modelsDirectoryLabel = shortenHomeDirectoryInText(
            modelsDirectory,
            $appState.homeDirectory,
          )}
          <p
            class="text-psx-foreground-secondary flex min-w-0 items-center gap-1 pl-4 text-[12px]/[17px]"
          >
            <span>Models downloaded to</span>
            <button
              type="button"
              class="hover:text-psx-foreground-primary min-w-0 truncate font-mono underline-offset-2 hover:underline"
              aria-label={`Open voice recognition models directory in Finder: ${modelsDirectoryLabel}`}
              title={modelsDirectory}
              onclick={() => void openModelsDirectory(modelsDirectory)}
            >
              {modelsDirectoryLabel}
            </button>
          </p>
        {/if}
        {#if actionError}
          <p class="text-psx-error-foreground mt-2 text-[13px]/[18px]">{actionError}</p>
        {/if}
        <div class="mt-3 flex flex-col gap-2">
          {#each models as model (model.id)}
            {@const download = downloadFor(model)}
            {@const downloading = isDownloading(download)}
            {@const busy = pendingModelId === model.id}
            {@const selected = model.id === voiceState?.selectedModelId}
            <article
              class="hover:bg-psx-menu-hover-background flex min-w-0 cursor-default flex-col rounded-xl p-4 transition-colors"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2">
                  <span
                    class="border-psx-border bg-psx-panel inline-grid size-8 shrink-0 place-items-center rounded-[9px] border dark:border-black/10 dark:bg-white"
                    aria-hidden="true"
                  >
                    <Icon
                      name="microphone"
                      size={18}
                      class="text-psx-icon shrink-0 dark:text-neutral-500"
                    />
                  </span>
                  <span
                    class="text-psx-foreground-primary min-w-0 truncate text-[13px]/[18px] font-medium"
                  >
                    {model.name}
                  </span>
                  {#if model.recommended}
                    <span
                      class="text-psx-foreground-secondary bg-psx-chrome-hover shrink-0 rounded-full px-1.5 py-0.5 text-xs"
                    >
                      Recommended
                    </span>
                  {/if}
                  {#if model.multilingual}
                    <span
                      class="text-psx-foreground-secondary bg-psx-chrome-hover shrink-0 rounded-full px-1.5 py-0.5 text-xs"
                    >
                      Multilingual
                    </span>
                  {/if}
                  {#if modelSize(model)}
                    <span class="text-psx-foreground-secondary shrink-0 text-xs">
                      {modelSize(model)}
                    </span>
                  {/if}
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  {#if downloading}
                    <button
                      type="button"
                      class={secondaryPillButtonClass}
                      onclick={() =>
                        void runModelAction(model.id, () => store.cancelDownload(model.id))}
                      disabled={busy}
                    >
                      {#if busy}<Spinner size={12} />{/if}
                      Cancel
                    </button>
                  {:else if model.downloaded}
                    {#if selected}
                      <span
                        class="text-psx-foreground-primary bg-psx-menu-active-background/40 shrink-0 rounded-full px-2 py-0.5 text-xs"
                      >
                        In use
                      </span>
                    {:else}
                      <button
                        type="button"
                        class={secondaryPillButtonClass}
                        onclick={() =>
                          void runModelAction(model.id, () => store.selectModel(model.id))}
                        disabled={busy}
                      >
                        {#if busy}<Spinner size={12} />{/if}
                        Use
                      </button>
                    {/if}
                    <button
                      type="button"
                      class={dangerPillButtonClass}
                      onclick={() =>
                        void runModelAction(model.id, () => store.deleteModel(model.id))}
                      disabled={busy}
                    >
                      {#if busy}<Spinner size={12} />{/if}
                      Delete
                    </button>
                  {:else}
                    <button
                      type="button"
                      class={primaryPillButtonClass}
                      onclick={() =>
                        void runModelAction(model.id, () => store.downloadModel(model.id))}
                      disabled={busy}
                    >
                      {#if busy}<Spinner size={12} />{/if}
                      Download
                    </button>
                  {/if}
                </div>
              </div>
              {#if download && download.status !== "completed"}
                <div class="mt-2">
                  <div
                    class="text-psx-foreground-secondary mb-1 flex min-w-0 items-center justify-between gap-3 text-[11px]"
                  >
                    <span
                      class={[
                        "min-w-0 truncate",
                        download.status === "failed" && "text-psx-error-foreground",
                      ]}
                    >
                      {downloadLabel(download)}
                    </span>
                    {#if downloading && downloadDetail(download)}
                      <span class="shrink-0">{downloadDetail(download)}</span>
                    {/if}
                  </div>
                  {#if downloading}
                    <div class="h-2 overflow-hidden rounded-full bg-gray-200 shadow-inner">
                      <div
                        class="h-full min-w-2 rounded-full bg-blue-500 transition-[width] duration-500 ease-out"
                        style:width={progressWidth(download)}
                      ></div>
                    </div>
                  {/if}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </div>
  </SettingsSection>
{/if}

<style>
  .voice-catalog {
    width: 100%;
    max-width: 56rem;
  }
</style>
