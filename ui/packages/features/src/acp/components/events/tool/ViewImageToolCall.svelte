<script lang="ts">
  import { imageFilePathFromUri } from "@camber/components/assistant-ui";
  import Icon from "@camber/components/icon";
  import Tooltip from "../../ui/Tooltip.svelte";
  import { rpc } from "../../../hostRpc";
  import ToolFooter from "../../shared/ToolFooter.svelte";
  import ToolRoot from "../../shared/ToolRoot.svelte";
  import { appState } from "../../../hostAdapter";
  import { getReadableFileInfo } from "../../../shared/paths";
  import type { ToolCall } from "../../../types";
  import { getViewImagePreview } from "./viewImageTool";
  import type { WorkspaceFolder } from "@camber/rpc";

  interface Props {
    event: ToolCall;
    workspaceFolders?: WorkspaceFolder[];
  }

  let { event, workspaceFolders = [] }: Props = $props();

  let preview = $derived(getViewImagePreview(event));
  // A file:// or bare-path image_url points at the agent machine's disk: no
  // webview can fetch that as a URL (and a remote phone never can), so read
  // it through the host like the read-image tool does. Web and data URLs
  // render directly.
  let localPath = $derived(preview ? imageFilePathFromUri(preview.src) : undefined);
  let path = $derived(preview?.path ?? localPath);
  let displayPath = $derived(
    path ? getReadableFileInfo(path, workspaceFolders, $appState.homeDirectory).filePath : path,
  );
  let fileName = $derived(path?.split(/[\\/]/).filter(Boolean).at(-1) ?? path ?? "image");

  let hostSrc = $state<string | null>(null);
  let hostLoadFailed = $state(false);
  let loadVersion = 0;

  $effect(() => {
    const target = localPath;
    const version = ++loadVersion;
    hostSrc = null;
    hostLoadFailed = false;
    if (!target) return;
    void rpc
      .getImageFileData(target)
      .then((image) => {
        if (version !== loadVersion) return;
        if (!image) {
          hostLoadFailed = true;
          return;
        }
        hostSrc = `data:${image.mimeType};base64,${image.data}`;
      })
      .catch(() => {
        // A rejected read (transport drop) must still surface the fallback,
        // not leave the card blank on an unhandled rejection.
        if (version === loadVersion) hostLoadFailed = true;
      });
  });

  let src = $derived(localPath ? hostSrc : (preview?.src ?? null));
</script>

<ToolRoot tool={event}>
  <!-- self-start keeps the hover region at the header's width now that
       ToolRoot is w-full; without it the tooltip pops over the whole row. -->
  <Tooltip
    text={displayPath}
    placement="top"
    gutter={8}
    openDelay={200}
    hide={!path}
    class="min-w-0 max-w-full self-start"
  >
    <div
      class="hover:bg-psx-background-secondary text-psx-foreground-secondary hover:text-psx-foreground-primary group relative isolate flex h-6 w-fit min-w-0 max-w-full cursor-default select-none items-center gap-1.5 self-start rounded-md text-xs transition-colors"
    >
      <Icon name="file" size={14} class="shrink-0" />
      <span class="shrink-0">View image</span>
      <span class="min-w-0 truncate font-mono opacity-90">{fileName}</span>
    </div>
  </Tooltip>

  {#if preview}
    <div
      class="border-psx-border bg-psx-panel shadow-low dark:shadow-low-dark mt-1 w-fit max-w-full overflow-hidden rounded-md border"
    >
      {#if src}
        <button
          type="button"
          data-cursor="link"
          class="bg-psx-background block max-w-full text-left disabled:cursor-default"
          aria-label={`Open image file ${fileName}`}
          disabled={!path}
          onclick={() => path && rpc.openFile(path)}
        >
          <img
            class="max-h-80 max-w-full object-contain"
            {src}
            alt={`Viewed image ${fileName}`}
            data-camber-image-path={path}
            data-camber-image-name={fileName}
          />
        </button>
      {:else if hostLoadFailed}
        <div class="text-psx-foreground-secondary px-2.5 py-2 text-xs">Unable to preview image</div>
      {/if}
    </div>
  {/if}

  <ToolFooter />
</ToolRoot>
