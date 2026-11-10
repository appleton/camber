<script lang="ts">
  import Icon, { type IconName } from "@camber/components/icon";
  import { DEFAULT_AGENT_SERVER, LOCAL_AGENT_SERVER } from "../../agentServers";
  import { agentServerIconUrl } from "../../localAgentIcon";
  import { getACPAgentRegistryRepo } from "../../features/AgentRegistryRepository.svelte";
  import { getACPChatSessionScope } from "../../features/ChatSessionScope.svelte";
  import RegistryAgentIcon from "../RegistryAgentIcon.svelte";
  import AcpKebabMenu from "../KebabMenu.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";
  import { appState } from "../../hostAdapter";
  import DesktopOpenTargetControl from "./DesktopOpenTargetControl.svelte";
  import { withShortcut } from "../../../keybindings";
  import { agentName as configuredAgentName } from "./menus/config/agentConfig";
  import { supportsNativeMenus } from "./desktopContextMenu";
  import { presentNativeMenu, type MenuSpecItem } from "../ui/menuSpec";

  interface Props {
    showSidebarActions?: boolean;
    sidebarWidth?: number;
    newConversationDisabled?: boolean;
    supportsTerminalPanel?: boolean;
    terminalPanelOpen?: boolean;
    desktopOpenTargetKind?: "project" | "worktree";
    desktopOpenTargetPath?: string;
    desktopInstanceWorktreeName?: string;
    editorSurface?: boolean;
    onExpandSidebar?: () => void;
    onNewConversation?: () => void;
    onToggleTerminalPanel?: () => void;
    onViewTrajectory?: () => void;
    onSaveTrajectory?: () => void;
  }

  let {
    showSidebarActions = false,
    sidebarWidth = 260,
    newConversationDisabled = false,
    supportsTerminalPanel = false,
    terminalPanelOpen = false,
    desktopOpenTargetKind = "project",
    desktopOpenTargetPath,
    desktopInstanceWorktreeName,
    editorSurface = false,
    onExpandSidebar,
    onNewConversation,
    onToggleTerminalPanel,
    onViewTrajectory,
    onSaveTrajectory,
  }: Props = $props();

  const registry = getACPAgentRegistryRepo();
  const chatSession = getACPChatSessionScope();
  let isDesktop = $derived($appState.environment.assistantHost === "desktop");
  const agentServer = $derived(
    chatSession.sessionAgentServer ?? chatSession.activeAgentServer ?? DEFAULT_AGENT_SERVER,
  );
  const agent = $derived(registry.getAgent(agentServer) ?? null);
  const activeAgentName = $derived(
    agentServer === DEFAULT_AGENT_SERVER
      ? "Camber"
      : agentServer === LOCAL_AGENT_SERVER
        ? "Camber Local"
        : (agent?.name ?? agentServer),
  );
  const iconUrl = $derived(agentServerIconUrl(agentServer, agent));
  const desktopInstance = $derived($appState.environment.desktopInstance);
  const hasDesktopInstanceColor = $derived(Boolean(desktopInstance?.color));
  const desktopWorktreeName = $derived(
    desktopInstanceWorktreeName || desktopInstance?.worktreeName,
  );
  const desktopFolderName = $derived(
    desktopInstanceWorktreeName && desktopInstance?.folderName === desktopInstance?.worktreeName
      ? undefined
      : desktopInstance?.folderName,
  );
  const desktopInstanceLabel = $derived(
    [desktopFolderName, desktopWorktreeName]
      .filter(
        (value, index, values): value is string =>
          Boolean(value) && values.indexOf(value) === index,
      )
      .join(" - "),
  );
  const kebabTriggerClass = $derived(
    [
      "outline-hidden focus-visible:outline-psx-focus pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-[6px] focus-visible:outline-2",
      hasDesktopInstanceColor
        ? "text-white/80 hover:bg-white/10"
        : "text-psx-icon hover:bg-psx-menu-hover-background",
    ].join(" "),
  );

  // Single source of truth for the kebab menu's actions: the DOM dropdown
  // renders these as DropdownItems, the native menu maps them to spec items.
  interface KebabMenuAction {
    id: "view-trajectory" | "save-trajectory";
    label: string;
    icon: IconName;
    onSelect: () => void;
  }

  const kebabMenuActions = $derived<KebabMenuAction[]>([
    {
      id: "view-trajectory",
      label: "View ACP Events",
      icon: "output",
      onSelect: () => onViewTrajectory?.(),
    },
    {
      id: "save-trajectory",
      label: "Save ACP events",
      icon: "export",
      onSelect: () => onSaveTrajectory?.(),
    },
  ]);

  const nativeMenus = $derived(supportsNativeMenus($appState.environment));
  const kebabMenuItems = $derived<MenuSpecItem[]>(
    kebabMenuActions.map(({ id, label, icon }) => ({ kind: "action", id, label, icon })),
  );

  let kebabTriggerButton: HTMLButtonElement | undefined = $state();
  let kebabMenuOpen = $state(false);

  async function openKebabNativeMenu(): Promise<void> {
    if (!kebabTriggerButton || kebabMenuOpen) return;
    const rect = kebabTriggerButton.getBoundingClientRect();
    kebabMenuOpen = true;
    try {
      const id = await presentNativeMenu(kebabMenuItems, {
        x: rect.right,
        y: rect.bottom + 4,
        align: "end",
      });
      kebabMenuActions.find((action) => action.id === id)?.onSelect();
    } finally {
      kebabMenuOpen = false;
    }
  }
</script>

<div
  class={[
    "border-psx-border/60 text-psx-foreground-secondary relative flex shrink-0 border-b text-sm",
    hasDesktopInstanceColor
      ? "text-white"
      : isDesktop || editorSurface
        ? "bg-psx-editor-background"
        : "bg-psx-panel",
    !isDesktop
      ? "h-10 items-center px-2"
      : showSidebarActions
        ? "h-12 items-center"
        : "h-12 items-center px-4",
    showSidebarActions ? "justify-between" : "justify-start",
  ]}
  style:background-color={desktopInstance?.color}
  data-tauri-drag-region={isDesktop ? "deep" : undefined}
>
  {#if showSidebarActions}
    {#if isDesktop}
      <div
        class="pointer-events-none relative z-10 flex shrink-0 items-center pl-[var(--desktop-window-controls-space,88px)] pr-2"
        style={`width: ${sidebarWidth}px;`}
        data-testid="acp-header-sidebar-actions"
      >
        <button
          type="button"
          data-tauri-drag-region="false"
          class={[
            "outline-hidden focus-visible:outline-psx-focus pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-[6px] focus-visible:outline-2",
            hasDesktopInstanceColor
              ? "text-white/80 hover:bg-white/10"
              : "text-psx-icon hover:bg-psx-menu-hover-background",
          ]}
          aria-label="Expand conversations sidebar"
          onclick={() => onExpandSidebar?.()}
        >
          <Icon name="sidebar-show" size={16} />
        </button>
      </div>
    {:else}
      <div
        class="pointer-events-none relative z-10 flex w-[180px] shrink-0 items-center gap-1"
        data-testid="acp-header-sidebar-actions"
      >
        <button
          type="button"
          data-tauri-drag-region="false"
          class="text-psx-icon outline-hidden hover:bg-psx-menu-hover-background focus-visible:outline-psx-focus pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-[6px] focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Expand conversations sidebar"
          onclick={() => onExpandSidebar?.()}
        >
          <Icon name="sidebar-show" size={16} />
        </button>
      </div>
    {/if}
  {/if}
  <div
    class="pointer-events-none relative z-10 flex min-w-0 items-center gap-1.5"
    class:text-base={isDesktop}
  >
    <span class="shrink-0" class:pl-1.5={!isDesktop && !showSidebarActions}>Chatting with</span>
    <RegistryAgentIcon {iconUrl} size={16} />
    <span
      class={[
        "min-w-0 truncate font-medium",
        hasDesktopInstanceColor ? "text-white" : "text-psx-foreground-primary",
      ]}
    >
      {chatSession.handoffTargetAgentServer
        ? `Handing off to ${configuredAgentName(registry, chatSession.handoffTargetAgentServer)}`
        : activeAgentName}{desktopInstanceLabel ? ` - ${desktopInstanceLabel}` : ""}
    </span>
  </div>
  <div
    class={[
      "relative z-10 ml-auto flex shrink-0 items-center justify-end gap-1",
      showSidebarActions ? (isDesktop ? "pr-3" : "w-[180px]") : "",
    ]}
    style={showSidebarActions && isDesktop ? `width: ${sidebarWidth}px;` : undefined}
  >
    {#if isDesktop}
      <DesktopOpenTargetControl
        targetKind={desktopOpenTargetKind}
        targetPath={desktopOpenTargetPath}
        {hasDesktopInstanceColor}
      />
    {/if}

    {#if supportsTerminalPanel}
      <button
        type="button"
        data-tauri-drag-region="false"
        class={[
          "outline-hidden focus-visible:outline-psx-focus pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-[6px] focus-visible:outline-2",
          terminalPanelOpen
            ? hasDesktopInstanceColor
              ? "bg-white/15 text-white"
              : "bg-psx-menu-hover-background text-psx-foreground-primary"
            : hasDesktopInstanceColor
              ? "text-white/80 hover:bg-white/10"
              : "text-psx-icon hover:bg-psx-menu-hover-background",
        ]}
        aria-label={terminalPanelOpen ? "Hide terminal panel" : "Show terminal panel"}
        aria-pressed={terminalPanelOpen}
        title={terminalPanelOpen ? "Hide terminal" : "Show terminal"}
        onclick={() => onToggleTerminalPanel?.()}
      >
        <Icon name="terminal" size={15} />
      </button>
    {/if}

    {#if showSidebarActions}
      <button
        type="button"
        data-tauri-drag-region="false"
        class={[
          "outline-hidden focus-visible:outline-psx-focus pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-[6px] focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
          hasDesktopInstanceColor
            ? "text-white/80 hover:bg-white/10"
            : "text-psx-icon hover:bg-psx-menu-hover-background",
        ]}
        aria-label="New conversation"
        title={withShortcut("New conversation", "newConversation")}
        disabled={newConversationDisabled}
        onclick={() => onNewConversation?.()}
      >
        <Icon name="new" size={16} />
      </button>
    {/if}

    {#if chatSession.sessionId}
      {#if nativeMenus}
        <button
          type="button"
          bind:this={kebabTriggerButton}
          aria-label="More actions"
          title="More actions"
          aria-haspopup="menu"
          aria-expanded={kebabMenuOpen}
          data-tauri-drag-region="false"
          class={kebabTriggerClass}
          onclick={openKebabNativeMenu}
        >
          <Icon name="more" size={14} aria-hidden="true" />
        </button>
      {:else}
        <AcpKebabMenu
          label="More actions"
          triggerClass={kebabTriggerClass}
          triggerDragRegion={isDesktop}
        >
          {#each kebabMenuActions as action (action.id)}
            <DropdownItem icon={action.icon} label={action.label} onclick={action.onSelect} />
          {/each}
        </AcpKebabMenu>
      {/if}
    {/if}
  </div>
</div>
