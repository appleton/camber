<script lang="ts" module>
  import type { ToolKind } from "@agentclientprotocol/sdk";

  const LABELS: Record<Exclude<ToolKind, "other">, string> = {
    read: "Read",
    edit: "Edit",
    delete: "Delete",
    move: "Move",
    search: "Search",
    execute: "Run",
    think: "Think",
    fetch: "Fetch",
    switch_mode: "Switch mode",
  };
</script>

<script lang="ts">
  import type { SvelteHTMLElements } from "svelte/elements";
  import Icon from "@camber/components/icon";
  import { Spinner } from "@camber/components/spinner";
  import { DiffStats } from "@camber/components/diff";
  import FileButton from "./FileButton.svelte";
  import { getToolContext } from "./ToolRoot.svelte";
  import { CollapsibleTrigger } from "@camber/components/collapsible";
  import { getReadableFileInfo, shortenDirectoryPathsInText } from "../../shared/paths";
  import Tooltip from "../ui/Tooltip.svelte";
  import { getToolNameLabel, getToolPath, isMcpOutputFilePath } from "./toolPaths";
  import {
    getToolCommandLabel,
    getToolSearchQuery,
    isPermissionDeniedToolCall,
  } from "./toolStatus";

  type Props = SvelteHTMLElements["div"] & {
    expandable?: boolean;
  };

  let { class: className, expandable = true, ...rest }: Props = $props();

  const context = getToolContext();
  const tool = $derived(context.tool);
  // `_meta.tool_name` can override the coarse ACP kind label — e.g. a file
  // "write" arrives as kind "edit" (so it would read as "Edit"), and a
  // directory listing arrives as kind "read".
  const label = $derived(
    getToolNameLabel(tool) ?? (tool.kind && tool.kind !== "other" ? LABELS[tool.kind] : undefined),
  );
  const path = $derived(getToolPath(tool));
  const parsedPath = $derived(
    path ? getReadableFileInfo(path, context.workspaceFolders, context.homeDirectory) : undefined,
  );
  // A read of an agent-spilled MCP output temp file shows a friendly name
  // instead of the raw temp path, which otherwise reads as alarming. The
  // tooltip still shows the real path.
  const fileLabel = $derived(
    path && isMcpOutputFilePath(path) ? "MCP tool output" : parsedPath?.fileName,
  );
  const isPermissionDenied = $derived(isPermissionDeniedToolCall(tool));
  const commandLabel = $derived(getToolCommandLabel(tool));
  const searchQuery = $derived(getToolSearchQuery(tool));
  const displayTitle = $derived(
    shortenDirectoryPathsInText(tool.title, context.workspaceFolders, context.homeDirectory),
  );
  const displayCommandLabel = $derived(
    commandLabel
      ? shortenDirectoryPathsInText(commandLabel, context.workspaceFolders, context.homeDirectory)
      : commandLabel,
  );
  const displaySearchQuery = $derived(
    searchQuery
      ? shortenDirectoryPathsInText(searchQuery, context.workspaceFolders, context.homeDirectory)
      : searchQuery,
  );
  // A recognized kind normally renders a kind-specific detail next to its label
  // (file path, command, or search query). Kinds like "think" have a label but
  // no detail renderer, so the descriptive title would be dropped, leaving a bare
  // "Think". When there's no inline detail, show the title in place of the label
  // (matching how kind "other" renders) rather than an empty kind word.
  const hasInlineDetail = $derived(
    !!path || (isPermissionDenied && !!commandLabel) || !!searchQuery,
  );
  const titleFallback = $derived(
    !hasInlineDetail && tool.title && tool.title !== label ? displayTitle : undefined,
  );
  const status = $derived.by(() => {
    if (isPermissionDenied) return "denied";
    if (tool.status === "failed") return "error";
    if (tool.status === "cancelled") return "cancelled";
  });
  const iconSize = $derived(
    context.icon && typeof context.icon !== "string" && context.icon.type === "file" ? 16 : 14,
  );
</script>

<div
  {...rest}
  class={[
    "hover:bg-psx-background-secondary text-psx-foreground-secondary hover:text-psx-foreground-primary group relative isolate flex h-6 w-fit min-w-0 max-w-full select-none items-center gap-1.5 self-start rounded-md text-xs transition-colors",
    expandable ? "cursor-pointer" : "cursor-default",
    className,
  ]}
>
  <!-- Single full-area click target so the whole row toggles, including the
       gaps between icon/label/chevron. The icon, label, and chevron are plain
       (non-interactive); only the file link sits above this overlay. -->
  {#if expandable}
    <CollapsibleTrigger
      aria-label={context.open ? "Collapse tool call" : "Expand tool call"}
      appearance="plain"
      class="absolute inset-0 z-10"
    />
  {/if}

  <span class="flex w-4 shrink-0 items-center justify-center">
    {#if context.icon === "loading"}
      <Spinner aria-hidden size={12} class="shrink-0" />
    {:else if context.icon}
      <Icon
        size={iconSize}
        class="shrink-0"
        {...typeof context.icon === "string" ? { name: context.icon } : context.icon}
      />
    {/if}
  </span>

  {#if label}
    <span class="text-auto flex min-w-0 items-baseline gap-1.5 text-current">
      {#if titleFallback}
        <span class="min-w-0 truncate">{titleFallback}</span>
      {:else}
        <span class="shrink-0">
          {isPermissionDenied && tool.kind === "execute" ? "Execute" : label}
        </span>
        {#if isPermissionDenied && displayCommandLabel}
          <span class="truncate font-mono opacity-90">{displayCommandLabel}</span>
        {:else if displaySearchQuery}
          <span class="truncate font-mono opacity-90">{displaySearchQuery}</span>
        {/if}
      {/if}
    </span>
    {#if path}
      <Tooltip
        text={parsedPath?.filePath}
        placement="top"
        gutter={8}
        openDelay={200}
        class="relative z-20 min-w-0"
      >
        <FileButton
          path={parsedPath?.absolutePath ?? path}
          icon={false}
          class="-mx-0.5 min-w-0 px-0.5 font-normal text-current no-underline hover:underline"
        >
          {fileLabel}
        </FileButton>
      </Tooltip>
    {/if}
  {:else}
    <span class="text-auto min-w-0 truncate text-current">{displayTitle}</span>
  {/if}

  {#if context.diff}
    <span class="shrink-0" data-size="xs">
      <DiffStats stats={context.diffStats} />
    </span>
  {/if}

  {#if status}
    <span class="shrink-0 uppercase opacity-80">{status}</span>
  {/if}

  {#if expandable}
    <span class="ml-0.5 flex shrink-0 items-center text-current">
      <Icon
        name="chevron"
        class={[
          "shrink-0 transition-all",
          !context.open && "-rotate-90 opacity-0 group-hover:opacity-100",
        ]}
      />
    </span>
  {/if}
</div>
