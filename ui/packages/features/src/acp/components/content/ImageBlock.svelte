<script lang="ts">
  import type { ImageContent } from "@agentclientprotocol/sdk";
  import Icon from "@camber/components/icon";
  import { imageFilePathFromUri } from "../../shared/imagePreview";
  import { appState } from "../../hostAdapter";
  import { getReadableFileInfo, shortenDirectoryPathsInText } from "../../shared/paths";
  import type { WorkspaceFolder } from "@camber/rpc";

  type Props = ImageContent & {
    alt?: string;
    workspaceFolders?: WorkspaceFolder[];
  };

  let { data, mimeType, uri = null, alt = "Image", workspaceFolders = [] }: Props = $props();

  let src = $derived(`data:${mimeType};base64,${data}`);
  let path = $derived(uri ? imageFilePathFromUri(uri) : undefined);
  let title = $derived(
    path
      ? getReadableFileInfo(path, workspaceFolders, $appState.homeDirectory).filePath
      : shortenDirectoryPathsInText(uri ?? alt, workspaceFolders, $appState.homeDirectory),
  );
</script>

<figure
  class="border-psx-border bg-psx-panel shadow-low dark:shadow-low-dark w-fit overflow-hidden rounded border text-left"
>
  <img
    class="max-h-64 max-w-full object-contain"
    {src}
    {alt}
    data-camber-image-path={path}
    data-camber-image-name={title}
  />
  <span
    class="border-psx-border text-psx-foreground-secondary flex items-center gap-1 border-t px-2 py-1 text-xs"
  >
    <Icon name="file" size={13} class="text-psx-icon" />
    <span class="max-w-64 truncate">{title}</span>
  </span>
</figure>
