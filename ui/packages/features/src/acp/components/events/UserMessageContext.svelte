<script lang="ts">
  import type { ContentBlock, ResourceLink, EmbeddedResource } from "@agentclientprotocol/sdk";
  import Icon from "@camber/components/icon";
  import { slide } from "svelte/transition";
  import { appState } from "../../hostAdapter";
  import { rpc } from "../../hostRpc";
  import { getDirname, getFilenameFromPath, removeRootPathFromFilename } from "../../shared/paths";
  import FileSelection from "../../prompt/menus/context/FileSelection.svelte";
  import { partition } from "lodash";

  interface Props {
    blocks: ContentBlock[];
  }

  let { blocks }: Props = $props();

  type UserMessageContextItem =
    | (ResourceLink & { type: "resource_link" })
    | (EmbeddedResource & { type: "resource" });

  function getURI(item: UserMessageContextItem): string {
    return item.type === "resource" ? item.resource.uri : item.uri;
  }

  function getFileLabel(item: UserMessageContextItem): string {
    return item.type === "resource"
      ? getFilenameFromPath(item.resource.uri) || "Untitled"
      : (item.title ?? item.name ?? getFilenameFromPath(item.uri) ?? "Untitled");
  }

  function getTitle(item: UserMessageContextItem): string {
    return item.type === "resource" ? getURI(item) : (item.title ?? item.name ?? getURI(item));
  }

  function getSelectedLines(item: UserMessageContextItem):
    | {
        startLine?: number;
        endLine?: number;
      }
    | undefined {
    const meta = item.type === "resource" ? item.resource._meta : item._meta;
    return meta?.selection as { startLine?: number; endLine?: number } | undefined;
  }

  function isLink(item: UserMessageContextItem): boolean {
    if (item.type === "resource_link") {
      return /^https?:\/\//i.test(item.uri);
    }
    if (item.type === "resource") {
      return /^https?:\/\//i.test(item.resource.uri);
    }
    return false;
  }
  function isRecentFile(item: UserMessageContextItem): boolean {
    if (item.type === "resource_link") {
      return item._meta?.recent === true;
    }
    if (item.type === "resource") {
      return item.resource._meta?.recent === true;
    }
    return false;
  }

  function isActiveFile(item: UserMessageContextItem): boolean {
    if (item.type === "resource_link") {
      return item._meta?.active === true;
    }
    if (item.type === "resource") {
      return item.resource._meta?.active === true;
    }
    return false;
  }

  const { hasResources, urlLinks, recentFiles, activeFiles, attachedFiles } = $derived.by(() => {
    const resources: UserMessageContextItem[] = blocks.filter(
      (b) => b.type === "resource" || b.type === "resource_link",
    );

    const [urlLinks, fileLinks] = partition(resources, (block) => isLink(block));
    const [recentFiles, nonRecentFiles] = partition([...fileLinks], (block) => isRecentFile(block));
    const [activeFiles, attachedFiles] = partition(nonRecentFiles, (block) => isActiveFile(block));
    const hasResources = resources.length > 0;
    return { hasResources, urlLinks, recentFiles, activeFiles, attachedFiles };
  });

  let customUI = $derived($appState.environment.capabilities.customUI ?? false);

  function fileFolder(path: string): string {
    return getDirname(removeRootPathFromFilename(path, $appState.workspaces));
  }
</script>

{#snippet fileRow(item: UserMessageContextItem)}
  {@const uri = getURI(item)}
  {@const label = getFileLabel(item)}
  {@const selectedLines = getSelectedLines(item)}
  <button
    type="button"
    data-cursor="link"
    class="text-psx-foreground-primary hover:text-psx-link active:outline-hidden group flex items-center gap-x-1 py-px text-left"
    onclick={() => rpc.openFile(uri)}
  >
    <Icon type="file" name={uri} />
    <span class="text-psx-foreground-primary group-hover:text-psx-link truncate">
      {label}
    </span>
    {#if selectedLines && selectedLines.startLine !== undefined && selectedLines.endLine !== undefined}
      <FileSelection selection={[selectedLines.startLine, selectedLines.endLine]} />
    {/if}
    <span class="ml-1 flex-1 truncate text-[12px]">
      {fileFolder(uri)}
    </span>
  </button>
{/snippet}

{#if hasResources}
  <div
    transition:slide={{ duration: 150 }}
    class={["relative -mt-2 flex w-full flex-col self-stretch", customUI ? "" : "-mx-4"]}
  >
    <div class={["relative -mb-px flex justify-end", customUI ? "mr-[18px]" : "mr-[20px]"]}>
      <svg
        width="20"
        height="11"
        viewBox="0 0 20 11"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect
          x="9.89948"
          y="3.29289"
          width="15"
          height="15"
          transform="rotate(45 9.89948 3.29289)"
          fill="var(--psx-editor-background)"
          stroke="var(--psx-border)"
        />
      </svg>
    </div>
    <div
      class={[
        "border-psx-border from-psx-editor-background flex w-full flex-col justify-end border-t bg-gradient-to-b to-transparent text-left",
        customUI ? "bubble px-3.5 pb-2 pt-3" : "px-4 py-2.5",
      ]}
    >
      {#if recentFiles.length > 0}
        <span class="title">Recently opened</span>
        {#each recentFiles as item, i (`recent-file-link-${i}`)}
          {@render fileRow(item)}
        {/each}
      {/if}

      {#if activeFiles.length > 0}
        <span class="title">Active Files</span>
        {#each activeFiles as item, i (`active-file-link-${i}`)}
          {@render fileRow(item)}
        {/each}
      {/if}

      {#if attachedFiles.length > 0}
        <span class="title">Included files</span>
        {#each attachedFiles as item, i (`file-link-${i}`)}
          {@render fileRow(item)}
        {/each}
      {/if}

      {#if urlLinks.length > 0}
        <span class="title">Included websites</span>
        {#each urlLinks as item, i (`url-link-${i}`)}
          {@const uri = getURI(item)}
          {@const title = getTitle(item)}
          <a
            href={uri}
            class="hover:text-psx-link group flex items-center gap-x-1 py-px"
            rel="noopener noreferrer"
            target="_blank"
          >
            <Icon name="web" />
            <span class="truncate">{title}</span>
          </a>
        {/each}
      {/if}
    </div>
    <hr class="border-psx-border mb-1 mt-2 border-t" />
  </div>
{/if}

<style lang="postcss">
  @reference "#tailwind.css";
  .title {
    @apply text-psx-foreground-secondary py-1 text-xs font-medium;
  }

  .bubble {
    @apply border-psx-border bg-psx-panel shadow-xs mt-4 rounded-2xl border;
  }
</style>
