<script lang="ts">
  import { Tooltip } from "@camber/components/assistant-ui";
  import Icon, { type IconName } from "@camber/components/icon";
  import { Switch } from "@camber/components/switch";
  import { onMount } from "svelte";
  import type { SplitNode } from "@camber/splits";
  import {
    clearStoredDefaultDesktopLayout,
    DESKTOP_DEFAULT_LAYOUT_CHANGED_EVENT,
    readStoredApplyDefaultDesktopLayoutToChats,
    readStoredDefaultDesktopLayout,
    readStoredWorktreeSetupSurface,
    writeStoredApplyDefaultDesktopLayoutToChats,
    writeStoredWorktreeSetupSurface,
    type DesktopWorktreeSetupSurface,
    type PersistedDesktopLayout,
    type PersistedDesktopTabDescriptor,
  } from "./chat/desktopLayoutPersistence";
  import type { DesktopSplitSurface } from "./chat/desktopSplitsCache";
  import RegistryAgentIcon from "./RegistryAgentIcon.svelte";
  import SettingsSection from "./settings/SettingsSection.svelte";

  type ClearStatus = "idle" | "clearing" | "error";

  interface SurfacePreview {
    surface: DesktopSplitSurface;
    visible: boolean;
    rootNode: SplitNode;
    descriptors: Record<string, PersistedDesktopTabDescriptor>;
    tabCount: number;
  }

  interface PanePreview {
    id: string;
    tabs: TabPreview[];
    selectedTab?: TabPreview;
  }

  interface TabPreview {
    id: string;
    label: string;
    selected: boolean;
    kind?: PersistedDesktopTabDescriptor["kind"];
    icon?: TabPreviewIcon;
  }

  type TabPreviewIcon =
    | {
        type: "agent";
      }
    | {
        type: "product";
        name: IconName;
      }
    | {
        type: "file";
        path: string;
      };

  const WORKTREE_SETUP_SURFACE_OPTIONS: Array<{
    value: DesktopWorktreeSetupSurface;
    label: string;
  }> = [
    { value: "sidebar", label: "Sidebar" },
    { value: "bottomPanel", label: "Bottom panel" },
    { value: "mainTab", label: "Main panel tab" },
  ];

  // What the app opens when no default is saved: a single chat tab in the main
  // panel with both auxiliary surfaces hidden. Shown as the preview so the
  // section always illustrates the effective layout.
  const STANDARD_DESKTOP_LAYOUT: PersistedDesktopLayout = {
    version: 1,
    surfaces: {
      main: {
        version: 1,
        rootNode: {
          type: "pane",
          pane: {
            id: "standard-main-pane",
            tabs: [{ id: "standard-chat-tab", title: "Chat", icon: "agent", isDirty: false }],
            selectedTabId: "standard-chat-tab",
          },
        },
      },
      rightSidebar: emptyStandardSurface("standard-right-pane"),
      bottomPanel: emptyStandardSurface("standard-bottom-pane"),
    },
    descriptors: {
      "standard-chat-tab": { kind: "chat" },
    },
    rightSidebarVisible: false,
    bottomPanelVisible: false,
    activeSurface: "main",
  };

  let layout = $state<PersistedDesktopLayout | undefined>();
  let applyDefaultLayoutToChats = $state(readStoredApplyDefaultDesktopLayoutToChats());
  let worktreeSetupSurface = $state<DesktopWorktreeSetupSurface>(readStoredWorktreeSetupSurface());
  let clearStatus = $state<ClearStatus>("idle");
  let error = $state("");
  let previewSelectedTabIds = $state<Record<string, string>>({});
  let previewLayout = $derived(layout ?? STANDARD_DESKTOP_LAYOUT);
  let mainPreview = $derived(buildSurfacePreview(previewLayout, "main"));
  let rightPreview = $derived(buildSurfacePreview(previewLayout, "rightSidebar"));
  let bottomPreview = $derived(buildSurfacePreview(previewLayout, "bottomPanel"));
  let showRightPreview = $derived(Boolean(rightPreview?.visible));
  let showBottomPreview = $derived(Boolean(bottomPreview?.visible));
  let layoutPreviewGridStyle = $derived(previewGridStyle(showRightPreview, showBottomPreview));

  onMount(() => {
    refreshDefaultLayout();

    const onDefaultLayoutChanged = () => refreshDefaultLayout();
    window.addEventListener(DESKTOP_DEFAULT_LAYOUT_CHANGED_EVENT, onDefaultLayoutChanged);
    return () => {
      window.removeEventListener(DESKTOP_DEFAULT_LAYOUT_CHANGED_EVENT, onDefaultLayoutChanged);
    };
  });

  function refreshDefaultLayout() {
    layout = readStoredDefaultDesktopLayout();
    applyDefaultLayoutToChats = readStoredApplyDefaultDesktopLayoutToChats();
    previewSelectedTabIds = {};
    clearStatus = "idle";
    error = "";
  }

  function setWorktreeSetupSurface(surface: DesktopWorktreeSetupSurface) {
    worktreeSetupSurface = surface;
    writeStoredWorktreeSetupSurface(surface);
  }

  function setApplyDefaultLayoutToChats(value: boolean) {
    const previousValue = applyDefaultLayoutToChats;
    applyDefaultLayoutToChats = value;
    error = "";
    try {
      writeStoredApplyDefaultDesktopLayoutToChats(value);
    } catch (err) {
      applyDefaultLayoutToChats = previousValue;
      error = toErrorMessage(err);
    }
  }

  function clearDefaultLayout() {
    if (!layout) return;

    clearStatus = "clearing";
    error = "";
    try {
      clearStoredDefaultDesktopLayout();
      layout = undefined;
      clearStatus = "idle";
    } catch (err) {
      clearStatus = "error";
      error = toErrorMessage(err);
    }
  }

  function buildSurfacePreview(
    persistedLayout: PersistedDesktopLayout,
    surface: DesktopSplitSurface,
  ): SurfacePreview {
    const splitState = persistedLayout.surfaces[surface];
    return {
      surface,
      visible:
        surface === "main" ||
        (surface === "rightSidebar" && persistedLayout.rightSidebarVisible) ||
        (surface === "bottomPanel" && persistedLayout.bottomPanelVisible),
      rootNode: splitState.rootNode,
      descriptors: persistedLayout.descriptors,
      tabCount: countTabs(splitState.rootNode),
    };
  }

  function countTabs(node: SplitNode): number {
    if (node.type === "pane") {
      return node.pane.tabs.length;
    }

    return countTabs(node.split.first) + countTabs(node.split.second);
  }

  function panePreview(
    surface: DesktopSplitSurface,
    node: Extract<SplitNode, { type: "pane" }>,
    descriptors: Record<string, PersistedDesktopTabDescriptor>,
  ): PanePreview {
    const selectionKey = previewPaneSelectionKey(surface, node.pane.id);
    const previewSelectedTabId = previewSelectedTabIds[selectionKey];
    const selectedTabId = node.pane.tabs.some((tab) => tab.id === previewSelectedTabId)
      ? previewSelectedTabId
      : node.pane.tabs[0]?.id;
    const tabs = node.pane.tabs.map((tab) => {
      return {
        id: tab.id,
        ...descriptorPreview(descriptors[tab.id], tab.title),
        selected: tab.id === selectedTabId,
      };
    });

    return {
      id: node.pane.id,
      tabs,
      selectedTab: tabs.find((tab) => tab.selected) ?? tabs[0],
    };
  }

  function setPreviewSelectedTab(surface: DesktopSplitSurface, paneId: string, tabId: string) {
    previewSelectedTabIds[previewPaneSelectionKey(surface, paneId)] = tabId;
  }

  function previewPaneSelectionKey(surface: DesktopSplitSurface, paneId: string): string {
    return `${surface}:${paneId}`;
  }

  function descriptorPreview(
    descriptor: PersistedDesktopTabDescriptor | undefined,
    fallbackLabel = "Empty",
  ): Pick<TabPreview, "label" | "kind" | "icon"> {
    switch (descriptor?.kind) {
      case "chat":
        return {
          kind: "chat",
          label: "Chat",
          icon: { type: "agent" },
        };
      case "terminal":
        return {
          kind: "terminal",
          label: "Terminal",
          icon: { type: "product", name: "terminal" },
        };
      case "review":
        return {
          kind: "review",
          label: "Review",
          icon: { type: "product", name: "review" },
        };
      case "trajectory":
        return {
          kind: "trajectory",
          label: "Events",
          icon: { type: "product", name: "output" },
        };
      case "files":
        return {
          kind: "files",
          label: "Files",
          icon: { type: "product", name: "folder-open" },
        };
      case "github":
        return {
          kind: "github",
          label: "GitHub",
          icon: { type: "product", name: "github" },
        };
      case "changes":
        return {
          kind: "changes",
          label: "Changes",
          icon: { type: "product", name: "diff" },
        };
      case "file":
        return {
          kind: "file",
          label: fileName(descriptor.path),
          icon: { type: "file", path: descriptor.path },
        };
      default:
        return {
          label: fallbackLabel,
        };
    }
  }

  function fileName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "File";
  }

  function previewFlex(value: number): number {
    if (!Number.isFinite(value)) return 0.5;
    return Math.min(0.9, Math.max(0.1, value));
  }

  function previewGridStyle(showRight: boolean, showBottom: boolean): string {
    const columns = showRight ? "48px minmax(0, 1fr) 96px" : "48px minmax(0, 1fr)";
    const rows = showBottom ? "minmax(0, 1fr) 76px" : "minmax(0, 1fr)";
    return `grid-template-columns: ${columns}; grid-template-rows: ${rows};`;
  }

  function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return "Unable to update default layout settings.";
  }

  function emptyStandardSurface(paneId: string): PersistedDesktopLayout["surfaces"]["main"] {
    return {
      version: 1,
      rootNode: {
        type: "pane",
        pane: { id: paneId, tabs: [], selectedTabId: undefined },
      },
    };
  }
</script>

<SettingsSection
  title="Default Layout"
  subtitle="Use Window > Save Layout as Default to save a new default."
>
  <div class="flex min-w-0 flex-col items-start gap-3 px-3 pb-3 pt-3">
    <div
      class="border-psx-border bg-psx-panel relative grid aspect-[16/10] w-full min-w-0 max-w-[440px] gap-1 rounded-[6px] border p-1"
      style={layoutPreviewGridStyle}
      aria-label={layout ? "Current default layout preview" : "Standard layout preview"}
    >
      <span
        class="pointer-events-none absolute left-[9px] top-[9px] z-20 flex items-center gap-1"
        aria-hidden="true"
      >
        <span class="size-[6px] rounded-full border border-black/10 bg-[#ff5f57]"></span>
        <span class="size-[6px] rounded-full border border-black/10 bg-[#ffbd2e]"></span>
        <span class="size-[6px] rounded-full border border-black/10 bg-[#28c840]"></span>
      </span>
      <div
        class={[
          "flex min-h-0 min-w-0 flex-col gap-1 pl-[5px] pr-1 pt-5",
          showBottomPreview ? "row-span-2" : "",
        ]}
        aria-hidden="true"
      >
        {@render placeholderLine("w-8", "bg-psx-border/70")}
        {@render placeholderLine("w-6", "bg-psx-border/55")}
        {@render placeholderLine("mt-1 w-7", "bg-psx-border/55")}
        {@render placeholderLine("w-5", "bg-psx-border/40")}
      </div>
      <div class="min-h-0 min-w-0">
        {@render surfacePreview(mainPreview)}
      </div>
      {#if showRightPreview}
        <div
          class={[
            "border-psx-border min-h-0 min-w-0 border-l pl-1",
            showBottomPreview ? "row-span-2" : "",
          ]}
        >
          {@render surfacePreview(rightPreview)}
        </div>
      {/if}
      {#if showBottomPreview}
        <div class="border-psx-border min-h-0 min-w-0 border-t pt-1">
          {@render surfacePreview(bottomPreview)}
        </div>
      {/if}
    </div>
    {#if !layout}
      <p class="text-psx-foreground-tertiary text-[12px]/[16px]">
        No default set — new conversations open a single chat panel.
      </p>
    {/if}

    <div class="flex min-w-0 items-start gap-2">
      <Switch
        id="desktop-default-layout-chats-switch"
        checked={applyDefaultLayoutToChats}
        onCheckedChange={setApplyDefaultLayoutToChats}
      />
      <div class="min-w-0 max-w-[440px]">
        <label
          class="text-psx-foreground-primary cursor-pointer text-[13px]/[18px]"
          for="desktop-default-layout-chats-switch"
        >
          Also apply to new chats
        </label>
        <p class="text-psx-foreground-tertiary text-[12px]/[16px]">
          By default, chats always get a single tab layout. Project sessions always use the saved
          default layout.
        </p>
      </div>
    </div>

    <label class="flex min-w-0 flex-col gap-1">
      <span class="text-psx-foreground-primary text-[13px]/[18px]">
        Run worktree setup scripts in
      </span>
      <select
        class="border-psx-border bg-psx-input-background text-psx-foreground-primary focus:border-psx-focus h-8 w-full min-w-0 max-w-[180px] rounded-[5px] border px-2 text-[13px]/[18px] outline-none"
        value={worktreeSetupSurface}
        onchange={(event) =>
          setWorktreeSetupSurface(event.currentTarget.value as DesktopWorktreeSetupSurface)}
      >
        {#each WORKTREE_SETUP_SURFACE_OPTIONS as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
      <span class="text-psx-foreground-tertiary text-[12px]/[16px]">
        Setup runs in an existing terminal there when one is open for the worktree.
      </span>
    </label>

    {#if layout}
      <button
        type="button"
        class="text-psx-error-foreground outline-hidden hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-[13px]/[16px] focus-visible:outline-2"
        disabled={clearStatus === "clearing"}
        onclick={clearDefaultLayout}
      >
        Clear default layout
      </button>
    {/if}

    {#if clearStatus === "error"}
      <p class="text-psx-error-foreground truncate text-[13px]/[18px]" title={error}>{error}</p>
    {/if}
  </div>
</SettingsSection>

{#snippet surfacePreview(surface: SurfacePreview | undefined)}
  <div class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[5px]">
    {#if surface && surface.tabCount > 0}
      <div class="min-h-0 min-w-0 flex-1">
        {@render splitNodePreview(surface.surface, surface.rootNode, surface.descriptors)}
      </div>
    {:else}
      <div
        class="text-psx-foreground-tertiary flex min-h-0 flex-1 items-center justify-center text-[11px]/[13px]"
      >
        Empty
      </div>
    {/if}
  </div>
{/snippet}

{#snippet splitNodePreview(
  surface: DesktopSplitSurface,
  node: SplitNode,
  descriptors: Record<string, PersistedDesktopTabDescriptor>,
)}
  {#if node.type === "pane"}
    {@render paneNodePreview(surface, panePreview(surface, node, descriptors))}
  {:else}
    {@const firstFlex = previewFlex(node.split.dividerPosition)}
    {@const secondFlex = previewFlex(1 - node.split.dividerPosition)}
    <div
      class={[
        "flex h-full min-h-0 min-w-0 gap-1.5",
        node.split.orientation === "horizontal" ? "flex-row" : "flex-col",
      ]}
    >
      <div class="min-h-0 min-w-0" style={`flex: ${firstFlex} 1 0;`}>
        {@render splitNodePreview(surface, node.split.first, descriptors)}
      </div>
      <div class="min-h-0 min-w-0" style={`flex: ${secondFlex} 1 0;`}>
        {@render splitNodePreview(surface, node.split.second, descriptors)}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet paneNodePreview(surface: DesktopSplitSurface, pane: PanePreview)}
  <div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[4px]">
    {#if pane.tabs.length > 0}
      <div class="relative z-10 flex h-[14px] min-w-0 shrink-0 items-end gap-px overflow-hidden">
        {#each pane.tabs.slice(0, 3) as tab (tab.id)}
          <Tooltip text={tab.label} placement="top" gutter={4} openDelay={200}>
            <button
              class={[
                "border-psx-border outline-hidden focus-visible:outline-psx-focus flex h-[13px] w-[42px] flex-none items-center justify-start overflow-hidden rounded-t-[3px] border px-[4px] focus-visible:outline-1",
                tab.selected
                  ? "bg-psx-editor-background text-psx-foreground-primary border-b-psx-editor-background cursor-default"
                  : "bg-psx-input-background text-psx-icon cursor-pointer",
              ]}
              type="button"
              aria-pressed={tab.selected}
              aria-label={`Show ${tab.label} preview`}
              onclick={() => setPreviewSelectedTab(surface, pane.id, tab.id)}
            >
              {@render tabPreviewIcon(tab, 10)}
            </button>
          </Tooltip>
        {/each}
      </div>
      <Tooltip
        text={pane.selectedTab?.label ?? "Empty"}
        placement="top"
        gutter={4}
        openDelay={200}
        class="min-h-0 w-full flex-1"
      >
        <div
          class="border-psx-border bg-psx-editor-background -mt-px flex h-full min-h-0 w-full items-center justify-center rounded-b-[4px] rounded-tr-[4px] border p-1.5"
        >
          {#if pane.selectedTab}
            {@render paneContentPreview(pane.selectedTab)}
          {/if}
        </div>
      </Tooltip>
    {:else}
      <Tooltip
        text="Empty"
        placement="top"
        gutter={4}
        openDelay={200}
        class="min-h-0 w-full flex-1"
      >
        <div
          class="border-psx-border bg-psx-editor-background text-psx-foreground-tertiary flex h-full min-h-0 w-full items-center justify-center rounded-[4px] border text-[10px]/[12px]"
        >
          Empty
        </div>
      </Tooltip>
    {/if}
  </div>
{/snippet}

{#snippet paneContentPreview(tab: TabPreview)}
  {#if tab.kind === "chat"}
    {@render chatContentPreview()}
  {:else if tab.kind === "review"}
    {@render reviewContentPreview()}
  {:else if tab.kind === "terminal"}
    {@render terminalContentPreview()}
  {:else if tab.kind === "files"}
    {@render filesContentPreview()}
  {:else}
    {@render defaultContentPreview()}
  {/if}
{/snippet}

{#snippet chatContentPreview()}
  <div class="flex h-full min-h-0 w-full min-w-0 flex-col justify-between gap-1">
    <div class="flex min-h-0 flex-col gap-1 overflow-hidden">
      <div
        class="ml-auto h-[11px] w-[58%] max-w-[72px] rounded-[7px]"
        style="background: var(--psx-bubble-background);"
      ></div>
      <div class="flex min-w-0 flex-col gap-1">
        {@render placeholderLine("w-16", "bg-psx-border/70")}
        {@render placeholderLine("w-20 max-w-full", "bg-psx-border/55")}
        {@render placeholderLine("w-12", "bg-psx-border/45")}
      </div>
    </div>
    <div
      class="border-psx-border bg-psx-input-background flex h-[13px] w-full shrink-0 items-center justify-end rounded-[4px] border px-1"
    >
      <span class="bg-psx-foreground-tertiary size-[7px] rounded-full"></span>
    </div>
  </div>
{/snippet}

{#snippet defaultContentPreview()}
  <div class="flex h-full min-h-0 w-full min-w-0 flex-col gap-1 overflow-hidden">
    {@render placeholderLine("w-20 max-w-full", "bg-psx-border/65")}
    {@render placeholderLine("w-16", "bg-psx-border/55")}
    {@render placeholderLine("w-18", "bg-psx-border/45")}
    {@render placeholderLine("w-12", "bg-psx-border/40")}
  </div>
{/snippet}

{#snippet terminalContentPreview()}
  <div class="flex h-full min-h-0 w-full min-w-0 flex-col justify-center gap-1 overflow-hidden">
    <div class="flex min-w-0 flex-col gap-1">
      {@render placeholderLine("w-20 max-w-full", "bg-psx-border/65")}
      {@render placeholderLine("w-14", "bg-psx-border/55")}
      {@render placeholderLine("w-18", "bg-psx-border/45")}
    </div>
    <div
      class="text-psx-foreground-tertiary flex min-w-0 items-center gap-1 font-mono text-[8px]/[8px]"
    >
      <span class="shrink-0">$</span>
    </div>
  </div>
{/snippet}

{#snippet reviewContentPreview()}
  <div class="flex h-full min-h-0 w-full min-w-0 flex-col gap-1 overflow-hidden">
    <div class="border-psx-border flex shrink-0 flex-col overflow-hidden rounded-[3px] border">
      <div class="border-psx-border h-[8px] shrink-0 border-b"></div>
      <div class="flex min-h-0 flex-col gap-0.5 overflow-hidden p-1">
        {@render placeholderLine("w-14", "bg-psx-border/70")}
        {@render placeholderLine("w-20 max-w-full", "bg-psx-diff-insert-foreground/50")}
        {@render placeholderLine("w-12", "bg-psx-diff-delete-foreground/50")}
        {@render placeholderLine("w-16", "bg-psx-diff-insert-foreground/50")}
        {@render placeholderLine("w-10", "bg-psx-border/45")}
      </div>
    </div>
    <div class="border-psx-border flex shrink-0 flex-col overflow-hidden rounded-[3px] border">
      <div class="border-psx-border h-[8px] shrink-0 border-b"></div>
      <div class="flex min-h-0 flex-col gap-0.5 overflow-hidden p-1">
        {@render placeholderLine("w-10", "bg-psx-border/70")}
        {@render placeholderLine("w-18", "bg-psx-diff-delete-foreground/50")}
        {@render placeholderLine("w-14", "bg-psx-diff-insert-foreground/50")}
        {@render placeholderLine("w-20 max-w-full", "bg-psx-diff-delete-foreground/50")}
        {@render placeholderLine("w-12", "bg-psx-diff-insert-foreground/50")}
        {@render placeholderLine("w-16", "bg-psx-diff-delete-foreground/50")}
        {@render placeholderLine("w-10", "bg-psx-diff-insert-foreground/50")}
        {@render placeholderLine("w-16", "bg-psx-border/45")}
      </div>
    </div>
  </div>
{/snippet}

{#snippet filesContentPreview()}
  <div class="flex h-full min-h-0 w-full min-w-0 flex-col gap-1 overflow-hidden">
    <div class="flex min-w-0 flex-col gap-0.5">
      {@render folderTreeRow("w-14", "bg-psx-border/70")}
      {@render folderTreeRow("w-18", "bg-psx-border/60")}
      {@render folderTreeRow("w-12", "bg-psx-border/55")}
      {@render folderTreeRow("w-16", "bg-psx-border/50")}
      {@render folderTreeRow("w-11", "bg-psx-border/50")}
      {@render folderTreeRow("w-10", "bg-psx-border/50", true)}
      <div class="ml-[4px] mt-0.5 flex min-w-0 gap-1">
        <span class="bg-psx-border/45 w-px shrink-0 rounded-full"></span>
        <div class="flex min-w-0 flex-col gap-1 py-0.5 pl-1">
          {@render fileTreeRow("w-12", "bg-psx-border/50")}
          {@render fileTreeRow("w-16", "bg-psx-border/45")}
          {@render fileTreeRow("w-10", "bg-psx-border/40")}
          {@render fileTreeRow("w-14", "bg-psx-border/40")}
        </div>
      </div>
    </div>
  </div>
{/snippet}

{#snippet folderTreeRow(widthClass: string, colorClass: string, isOpen = false)}
  <div class="flex min-w-0 items-center gap-1">
    <Icon
      name="chevron"
      size={6}
      class={["text-psx-foreground-tertiary shrink-0", isOpen ? "" : "-rotate-90"]}
      aria-hidden="true"
    />
    {@render placeholderLine(widthClass, colorClass)}
  </div>
{/snippet}

{#snippet fileTreeRow(widthClass: string, colorClass: string)}
  <div class="flex min-w-0 items-center gap-1">
    <span class="bg-psx-foreground-tertiary/55 size-[4px] shrink-0 rounded-full"></span>
    {@render placeholderLine(widthClass, colorClass)}
  </div>
{/snippet}

{#snippet placeholderLine(widthClass: string, colorClass: string)}
  <span class={[colorClass, "h-[3px] rounded-full", widthClass]}></span>
{/snippet}

{#snippet tabPreviewIcon(tab: TabPreview, size: number)}
  {#if tab.icon?.type === "agent"}
    <RegistryAgentIcon fallback="sparkles" {size} class="shrink-0 opacity-80" />
  {:else if tab.icon?.type === "file"}
    <Icon
      type="file"
      name={tab.icon.path}
      fallback="file"
      {size}
      class="shrink-0 opacity-80"
      aria-hidden="true"
    />
  {:else if tab.icon?.type === "product"}
    <Icon name={tab.icon.name} {size} class="shrink-0 opacity-80" aria-hidden="true" />
  {/if}
{/snippet}
