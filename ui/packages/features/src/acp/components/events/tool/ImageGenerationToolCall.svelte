<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import Tooltip from "../../ui/Tooltip.svelte";
  import { rpc } from "../../../hostRpc";
  import ToolFooter from "../../shared/ToolFooter.svelte";
  import ToolRoot from "../../shared/ToolRoot.svelte";
  import { imageFilePathFromUri } from "../../../shared/imagePreview";
  import type { ToolCall } from "../../../types";
  import {
    getImageGenerationPreview,
    getImageGenerationPrompt,
    isImageGenerationPending,
  } from "./imageGenerationTool";

  interface Props {
    event: ToolCall;
  }

  let { event }: Props = $props();

  let preview = $derived(getImageGenerationPreview(event));
  let prompt = $derived(getImageGenerationPrompt(event));
  let pending = $derived(isImageGenerationPending(event));
  let status = $derived.by(() => {
    if (pending || event.status === "in_progress") return "generating";
    if (event.status === "failed") return "failed";
  });
  let fileSrc = $state<string | null>(null);
  let fileSrcPath = $state<string | null>(null);
  let fileLoadVersion = 0;

  let src = $derived.by(() => {
    if (!preview) return null;
    if (preview.kind === "data") return `data:${preview.mimeType};base64,${preview.data}`;
    if (preview.kind === "url") return preview.url;
    return preview.path === fileSrcPath ? fileSrc : null;
  });
  let openPath = $derived.by(() => {
    if (!preview) return null;
    if (preview.kind === "file") return preview.path;
    if (preview.kind === "data" && preview.uri) return imageFilePathFromUri(preview.uri) ?? null;
    return null;
  });
  let loadingPreview = $derived(pending || (preview?.kind === "file" && !src));

  $effect(() => {
    if (!preview || preview.kind !== "file") {
      fileSrc = null;
      fileSrcPath = null;
      return;
    }

    const version = ++fileLoadVersion;
    const path = preview.path;
    fileSrc = null;
    fileSrcPath = path;
    void rpc.getImageFileData(path).then((image) => {
      if (version !== fileLoadVersion || fileSrcPath !== path) return;
      fileSrc = image ? `data:${image.mimeType};base64,${image.data}` : null;
    });
  });
</script>

<ToolRoot tool={event}>
  <!-- self-start keeps the hover region at the header's width now that
       ToolRoot is w-full; without it the tooltip pops over the whole row. -->
  <Tooltip
    text={prompt}
    placement="top"
    gutter={8}
    openDelay={200}
    hide={!prompt}
    class="min-w-0 max-w-full self-start"
  >
    <div
      class="hover:bg-psx-background-secondary text-psx-foreground-secondary hover:text-psx-foreground-primary group relative isolate flex h-6 w-fit min-w-0 max-w-full cursor-default select-none items-center gap-1.5 self-start rounded-md text-xs transition-colors"
    >
      {#if event.status === "in_progress"}
        <Spinner aria-hidden size={12} class="shrink-0" />
      {:else}
        <Icon name="file" size={14} class="shrink-0" />
      {/if}
      <span class="shrink-0">Image generation</span>
      {#if status}
        <span class="shrink-0 uppercase opacity-80">{status}</span>
      {/if}
    </div>
  </Tooltip>

  <div
    class="border-psx-border bg-psx-panel shadow-low dark:shadow-low-dark mt-1 w-fit max-w-full overflow-hidden rounded-md border"
  >
    {#if src}
      <button
        type="button"
        data-cursor="link"
        class="bg-psx-background block max-w-full text-left disabled:cursor-default"
        aria-label="Open generated image file"
        disabled={!openPath}
        onclick={() => openPath && rpc.openFile(openPath)}
      >
        <img
          class="max-h-80 max-w-full object-contain"
          {src}
          alt="Generated result"
          data-camber-image-path={openPath ?? undefined}
          data-camber-image-name={preview?.title}
        />
      </button>
    {:else if loadingPreview}
      <div
        class="loading-preview bg-psx-background-secondary relative flex aspect-[4/3] w-[360px] max-w-[calc(100vw-3rem)] items-center justify-center overflow-hidden"
        role="status"
        aria-label="Generating image"
      >
        <div class="absolute inset-0 opacity-70"></div>
        <div
          class="border-psx-border bg-psx-panel/80 shadow-low dark:shadow-low-dark relative flex h-10 w-10 items-center justify-center rounded-full border"
        >
          <Spinner aria-hidden size={18} />
        </div>
      </div>
    {/if}
  </div>

  <ToolFooter />
</ToolRoot>

<style lang="postcss">
  @reference "#tailwind.css";

  .loading-preview::before {
    content: "";
    position: absolute;
    inset: 0;
    background:
      linear-gradient(
        90deg,
        transparent,
        color-mix(in srgb, var(--vscode-foreground) 10%, transparent),
        transparent
      ),
      repeating-linear-gradient(
        0deg,
        color-mix(in srgb, var(--vscode-foreground) 7%, transparent) 0,
        color-mix(in srgb, var(--vscode-foreground) 7%, transparent) 1px,
        transparent 1px,
        transparent 18px
      );
    animation: image-generation-scan 1.4s ease-in-out infinite;
  }

  @keyframes image-generation-scan {
    0% {
      transform: translateX(-70%);
      opacity: 0.45;
    }
    50% {
      opacity: 0.9;
    }
    100% {
      transform: translateX(70%);
      opacity: 0.45;
    }
  }
</style>
