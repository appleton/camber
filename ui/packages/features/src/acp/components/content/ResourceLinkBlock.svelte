<script lang="ts">
  import type { ResourceLink } from "@agentclientprotocol/sdk";
  import Icon from "@camber/components/icon";
  import { appState } from "../../hostAdapter";
  import { getReadableFileInfo, shortenDirectoryPathsInText } from "../../shared/paths";
  import type { WorkspaceFolder } from "@camber/rpc";
  import { isPreviewableImagePath, isPreviewableImageUrl } from "./imagePreview";

  type Props = ResourceLink & {
    type: "resource_link";
    workspaceFolders?: WorkspaceFolder[];
  };

  let { mimeType = null, name, title = null, uri, workspaceFolders = [] }: Props = $props();

  let label = $derived.by(() => {
    const rawLabel = title ?? name ?? uri;
    const readable = getReadableFileInfo(rawLabel, workspaceFolders, $appState.homeDirectory);
    if (readable.absolutePath === rawLabel || rawLabel.startsWith("file:")) {
      return readable.filePath;
    }
    return shortenDirectoryPathsInText(rawLabel, workspaceFolders, $appState.homeDirectory);
  });
  let isImage = $derived(
    mimeType?.startsWith("image/") || isPreviewableImageUrl(uri) || isPreviewableImagePath(uri),
  );
</script>

{#if isImage}
  <span
    class="border-psx-border bg-psx-panel shadow-low dark:shadow-low-dark flex max-w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-sm"
  >
    <Icon name="file" size={14} />
    <span class="min-w-0 truncate">{label}</span>
  </span>
{:else}
  <span
    class="border-psx-border bg-psx-panel shadow-low dark:shadow-low-dark flex max-w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-sm"
  >
    <Icon name="file" size={14} />
    <span class="min-w-0 truncate">{label}</span>
  </span>
{/if}
