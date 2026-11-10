<script lang="ts">
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import Tooltip from "../../ui/Tooltip.svelte";
  import { rpc } from "../../../hostRpc";
  import ToolFooter from "../../shared/ToolFooter.svelte";
  import ToolRoot from "../../shared/ToolRoot.svelte";
  import type { ToolCall } from "../../../types";
  import { getReadImagePath } from "./readImageTool";

  interface Props {
    event: ToolCall;
  }

  let { event }: Props = $props();

  let path = $derived(getReadImagePath(event));
  let fileName = $derived(path?.split(/[\\/]/).filter(Boolean).at(-1) ?? path ?? "image");
  let src = $state<string | null>(null);
  let loadState = $state<"loading" | "loaded" | "missing">("loading");
  let loadVersion = 0;

  $effect(() => {
    if (!path) {
      src = null;
      loadState = "missing";
      return;
    }

    const version = ++loadVersion;
    const currentPath = path;
    src = null;
    loadState = "loading";

    void rpc
      .getImageFileData(currentPath)
      .then((image) => {
        if (version !== loadVersion || path !== currentPath) return;
        if (!image) {
          loadState = "missing";
          return;
        }
        src = `data:${image.mimeType};base64,${image.data}`;
        loadState = "loaded";
      })
      .catch(() => {
        // A rejected read (unreadable path, transport drop) must still surface
        // the fallback, not leave the card shimmering on an unhandled rejection.
        if (version === loadVersion && path === currentPath) loadState = "missing";
      });
  });
</script>

<ToolRoot tool={event}>
  <!-- self-start keeps the hover region at the header's width now that
       ToolRoot is w-full; without it the tooltip pops over the whole row. -->
  <Tooltip
    text={path}
    placement="top"
    gutter={8}
    openDelay={200}
    hide={!path}
    class="min-w-0 max-w-full self-start"
  >
    <div
      class="hover:bg-psx-background-secondary text-psx-foreground-secondary hover:text-psx-foreground-primary group relative isolate flex h-6 w-fit min-w-0 max-w-full cursor-default select-none items-center gap-1.5 self-start rounded-md text-xs transition-colors"
    >
      {#if event.status === "in_progress" || loadState === "loading"}
        <Spinner aria-hidden size={12} class="shrink-0" />
      {:else}
        <Icon name="file" size={14} class="shrink-0" />
      {/if}
      <span class="shrink-0">Read image</span>
      <span class="min-w-0 truncate font-mono opacity-90">{fileName}</span>
    </div>
  </Tooltip>

  <div
    class="border-psx-border bg-psx-panel shadow-low dark:shadow-low-dark mt-1 w-fit max-w-full overflow-hidden rounded-md border"
  >
    {#if src}
      <button
        type="button"
        class="bg-psx-background block max-w-full text-left"
        aria-label={`Open image file ${fileName}`}
        onclick={() => path && rpc.openFile(path)}
      >
        <img class="max-h-80 max-w-full object-contain" {src} alt={`Read image ${fileName}`} />
      </button>
    {:else if loadState === "loading"}
      <div
        class="loading-preview bg-psx-background-secondary relative flex aspect-[4/3] w-[360px] max-w-[calc(100vw-3rem)] items-center justify-center overflow-hidden"
        role="status"
        aria-label="Loading image"
      >
        <div
          class="border-psx-border bg-psx-panel/80 shadow-low dark:shadow-low-dark relative flex h-10 w-10 items-center justify-center rounded-full border"
        >
          <Spinner aria-hidden size={18} />
        </div>
      </div>
    {:else}
      <div class="text-psx-foreground-secondary px-2.5 py-2 text-xs">Unable to preview image</div>
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
    animation: read-image-scan 1.4s ease-in-out infinite;
  }

  @keyframes read-image-scan {
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
