<script lang="ts">
  import {
    AcpChatPane,
    AcpConnectorsView,
    AcpDesktopSplitsPane,
    DESKTOP_SPLITS_CACHE_LIMIT,
    DESKTOP_SETTINGS_SECTIONS,
    DesktopProjectSettingsView,
    DesktopSettingsView,
    DesktopSideBar,
    DesktopSplitsCache,
    getCurrentAssistantTerminalRepo,
    IDE_SETTINGS_SECTIONS,
    IDESideBar,
    ProjectSettingsView,
    terminalIdsForDesktopSplitsEntry,
    type DesktopSettingsSection,
    type DesktopSplitNavigationLocation,
    type DesktopSplitNavigationRequest,
    type DesktopSplitsEntry,
    type DesktopFileViewerPanelProps,
    type DesktopNewTabAvailability,
  } from "@camber/features/acp";
  import { onDestroy, onMount, type Component } from "svelte";

  import ACPAgentUpdateBanner from "./AgentUpdateBanner.svelte";
  import AssistantConfigErrorBanner from "./AssistantConfigErrorBanner.svelte";
  import { installPinchZoomBlocker } from "../lib/utils/pinchZoom";
  import RuntimeProviders from "./RuntimeProviders.svelte";
  import { DesktopRuntime } from "./runtime/DesktopRuntime.svelte";
  import { CoreRuntime, type TargetProps } from "./runtime/CoreRuntime.svelte";
  import {
    DesktopNavigationHistory,
    type DesktopNavigationEntry,
  } from "./runtime/desktop/DesktopNavigationHistory";
  import type { TauriDragDropSubscriber } from "./runtime/desktop/TauriDragDrop.svelte";

  interface Props extends TargetProps {
    desktopFileViewerPanel?: Component<DesktopFileViewerPanelProps>;
    tauriDragDropSubscriber?: TauriDragDropSubscriber;
    /** Chrome and navigation handlers are mounted; agent/history work may still be pending. */
    onShellInteractive?: () => void;
    onInitialScreenSettled?: () => void;
    onConversationActivityChange?: (active: boolean) => void;
  }

  const DESKTOP_NEW_CONVERSATION_EVENT = "camber:desktop-new-conversation";
  const DESKTOP_NEW_PROJECT_EVENT = "camber:desktop-new-project";
  const DESKTOP_OPEN_IN_IDE_EVENT = "camber:desktop-open-in-ide";
  const DESKTOP_TOGGLE_LEFT_SIDEBAR_EVENT = "camber:desktop-toggle-left-sidebar";
  const DESKTOP_TOGGLE_RIGHT_SIDEBAR_EVENT = "camber:desktop-toggle-right-sidebar";
  const DESKTOP_TOGGLE_BOTTOM_PANEL_EVENT = "camber:desktop-toggle-bottom-panel";
  const DESKTOP_NAVIGATE_BACK_EVENT = "camber:desktop-navigate-back";
  const DESKTOP_NAVIGATE_FORWARD_EVENT = "camber:desktop-navigate-forward";
  const DESKTOP_NAVIGATION_AVAILABILITY_EVENT = "camber:desktop-navigation-availability";

  let {
    desktopFileViewerPanel,
    tauriDragDropSubscriber,
    onShellInteractive,
    onInitialScreenSettled,
    onConversationActivityChange,
    ...runtimeProps
  }: Props = $props();

  const core = new CoreRuntime({ target: "desktop", ...runtimeProps });
  core.initialize();
  $effect(() => onConversationActivityChange?.(core.acpRepo.hasActiveConversations));
  const desktop = new DesktopRuntime(core, {
    tauriDragDropSubscriber,
    onNavigationChange: scheduleDesktopNavigationRecord,
  });
  desktop.initialize();
  // Optional startup-diagnostics hooks installed by the desktop host (see
  // desktop-assistant/src/startupDiagnostics.ts) for debugging launches stuck
  // on the startup frame: the probe samples every input to the initial-screen
  // gate. Inert on hosts that don't install the globals.
  const startupDiagnostics = globalThis as {
    __camberStartupDiag?: (event: string, data?: unknown) => void;
    __camberRegisterStartupProbe?: (name: string, probe: () => unknown) => void;
  };
  startupDiagnostics.__camberRegisterStartupProbe?.("initialScreenGate", () =>
    desktop.startupDiagnosticsSnapshot(),
  );
  onMount(() => {
    startupDiagnostics.__camberStartupDiag?.("desktopPanel.shellInteractive");
    onShellInteractive?.();
  });
  let initialScreenSettledNotified = false;
  $effect(() => {
    if (initialScreenSettledNotified || !desktop.initialScreenSettled) return;
    initialScreenSettledNotified = true;
    startupDiagnostics.__camberStartupDiag?.("desktopPanel.initialScreenSettled");
    onInitialScreenSettled?.();
  });
  let initialAgentReadyNotified = false;
  $effect(() => {
    if (initialAgentReadyNotified || !desktop.initialAgentReady) return;
    initialAgentReadyNotified = true;
    startupDiagnostics.__camberStartupDiag?.("desktopPanel.agentReadyForPrompt");
  });
  let activeSplitNavigation = $state<DesktopSplitNavigationLocation>();
  let splitNavigationRequest = $state<DesktopSplitNavigationRequest>();
  let splitNavigationRequestToken = 0;
  let navigationRecordQueued = false;
  const desktopNavigationHistory = new DesktopNavigationHistory(currentDesktopNavigationEntry());
  queueMicrotask(syncDesktopNavigationAvailability);
  const assistantTerminals = getCurrentAssistantTerminalRepo();
  let desktopNewTabAvailability = $state<DesktopNewTabAvailability>({});
  const desktopSplitsCache = new DesktopSplitsCache({
    maxEntries: DESKTOP_SPLITS_CACHE_LIMIT,
    onEvictEntry: closeDesktopSplitsEntryTerminals,
  });
  onDestroy(installPinchZoomBlocker());

  function currentDesktopNavigationEntry(): DesktopNavigationEntry {
    const split =
      desktop.view === "chat" && activeSplitNavigation?.layoutKey === desktop.desktopChatLayoutKey
        ? activeSplitNavigation
        : undefined;
    return {
      view: desktop.view,
      projectSettingsPath: desktop.projectSettingsPath,
      conversationId: desktop.activeConversationId,
      split,
    };
  }

  function scheduleDesktopNavigationRecord() {
    if (navigationRecordQueued) return;
    navigationRecordQueued = true;
    queueMicrotask(() => {
      navigationRecordQueued = false;
      desktopNavigationHistory.record(currentDesktopNavigationEntry());
      syncDesktopNavigationAvailability();
    });
  }

  function syncDesktopNavigationAvailability() {
    window.dispatchEvent(
      new CustomEvent(DESKTOP_NAVIGATION_AVAILABILITY_EVENT, {
        detail: {
          canGoBack: desktopNavigationHistory.canGoBack,
          canGoForward: desktopNavigationHistory.canGoForward,
        },
      }),
    );
  }

  function handleSplitNavigationChange(location: DesktopSplitNavigationLocation) {
    activeSplitNavigation = location;
    scheduleDesktopNavigationRecord();
  }

  function applyDesktopNavigation(entry: DesktopNavigationEntry | undefined) {
    if (!entry) return;
    desktop.restoreNavigation(entry);
    activeSplitNavigation = entry.split;
    splitNavigationRequest = entry.split
      ? { location: entry.split, token: ++splitNavigationRequestToken }
      : undefined;
  }

  function handleNavigateBack(event: Event) {
    if (!desktop.isDesktop) return;
    const entry = desktopNavigationHistory.back();
    syncDesktopNavigationAvailability();
    applyDesktopNavigation(entry);
    event.preventDefault();
  }

  function handleNavigateForward(event: Event) {
    if (!desktop.isDesktop) return;
    const entry = desktopNavigationHistory.forward();
    syncDesktopNavigationAvailability();
    applyDesktopNavigation(entry);
    event.preventDefault();
  }

  function closeDesktopSplitsEntryTerminals(entry: DesktopSplitsEntry) {
    for (const terminalId of terminalIdsForDesktopSplitsEntry(entry)) {
      void assistantTerminals.deleteTab(terminalId).catch((error) => {
        console.debug("Unable to delete cached assistant terminal", error);
      });
    }
  }

  function handleDesktopNewTabAvailabilityChange(next: DesktopNewTabAvailability) {
    if (desktopNewTabAvailabilityEquals(desktopNewTabAvailability, next)) return;
    desktopNewTabAvailability = next;
  }

  function desktopNewTabAvailabilityEquals(
    left: DesktopNewTabAvailability,
    right: DesktopNewTabAvailability,
  ): boolean {
    for (const kind of [
      "terminal",
      "files",
      "diff",
      "review",
      "trajectory",
      "github",
      "changes",
    ] as const) {
      const leftState = left[kind];
      const rightState = right[kind];
      if (leftState?.disabled !== rightState?.disabled) return false;
      if (leftState?.disabledReason !== rightState?.disabledReason) return false;
    }
    return true;
  }

  $effect(() => {
    window.addEventListener(DESKTOP_NEW_CONVERSATION_EVENT, handleNewConversationEvent);
    window.addEventListener(DESKTOP_NEW_PROJECT_EVENT, handleNewProjectEvent);
    window.addEventListener(DESKTOP_OPEN_IN_IDE_EVENT, handleOpenInIdeEvent);
    window.addEventListener(DESKTOP_TOGGLE_LEFT_SIDEBAR_EVENT, handleToggleLeftSidebarEvent);
    window.addEventListener(DESKTOP_TOGGLE_RIGHT_SIDEBAR_EVENT, handleToggleRightSidebarEvent);
    window.addEventListener(DESKTOP_TOGGLE_BOTTOM_PANEL_EVENT, handleToggleBottomPanelEvent);
    window.addEventListener(DESKTOP_NAVIGATE_BACK_EVENT, handleNavigateBack);
    window.addEventListener(DESKTOP_NAVIGATE_FORWARD_EVENT, handleNavigateForward);

    return () => {
      window.removeEventListener(DESKTOP_NEW_CONVERSATION_EVENT, handleNewConversationEvent);
      window.removeEventListener(DESKTOP_NEW_PROJECT_EVENT, handleNewProjectEvent);
      window.removeEventListener(DESKTOP_OPEN_IN_IDE_EVENT, handleOpenInIdeEvent);
      window.removeEventListener(DESKTOP_TOGGLE_LEFT_SIDEBAR_EVENT, handleToggleLeftSidebarEvent);
      window.removeEventListener(DESKTOP_TOGGLE_RIGHT_SIDEBAR_EVENT, handleToggleRightSidebarEvent);
      window.removeEventListener(DESKTOP_TOGGLE_BOTTOM_PANEL_EVENT, handleToggleBottomPanelEvent);
      window.removeEventListener(DESKTOP_NAVIGATE_BACK_EVENT, handleNavigateBack);
      window.removeEventListener(DESKTOP_NAVIGATE_FORWARD_EVENT, handleNavigateForward);
    };
  });

  function handleNewConversationEvent(event: Event) {
    if (!desktop.isDesktop) return;
    void desktop.handleNewConversation();
    event.preventDefault();
  }

  function handleNewProjectEvent(event: Event) {
    if (!desktop.isDesktop) return;
    void desktop.handleAddProject();
    event.preventDefault();
  }

  function handleOpenInIdeEvent(event: Event) {
    if (!desktop.isDesktop) return;
    desktop.handleOpenInIde();
    event.preventDefault();
  }

  function handleToggleLeftSidebarEvent(event: Event) {
    if (!desktop.isDesktop) return;
    desktop.toggleLeftPanel();
    event.preventDefault();
  }

  function handleToggleRightSidebarEvent(event: Event) {
    if (!desktop.isDesktop) return;
    desktop.toggleDesktopRightSidebarVisible();
    event.preventDefault();
  }

  function handleToggleBottomPanelEvent(event: Event) {
    if (!desktop.isDesktop) return;
    desktop.toggleDesktopBottomPanelVisible();
    event.preventDefault();
  }

  onDestroy(() => desktopSplitsCache.disposeAll());

  // "connectors" is intentionally not a settings view: it renders as its own
  // destination (AcpConnectorsView), not inside the settings frame/nav.
  function isSettingsView(view: string): boolean {
    return (
      view === "settings" ||
      view === "shortcuts" ||
      view === "models" ||
      view === "voice" ||
      view === "github" ||
      view === "agents" ||
      view === "archived" ||
      view === "remote"
    );
  }

  function isSettingsSidebarView(view: string): boolean {
    return isSettingsView(view) || view === "project-settings";
  }

  function activeSettingsSection(view: string, isDesktop: boolean): DesktopSettingsSection {
    if (
      view === "shortcuts" ||
      view === "models" ||
      view === "voice" ||
      view === "connectors" ||
      view === "github" ||
      view === "agents" ||
      view === "archived" ||
      view === "remote"
    ) {
      return view;
    }
    // Fall back to a section the host actually renders: the IDE section list
    // (IDE_SETTINGS_SECTIONS) has no "models", so it would come up empty.
    return isDesktop ? "preferences" : "connectors";
  }

  function showSettingsSection(section: DesktopSettingsSection) {
    if (section === "preferences") {
      desktop.showSettings();
    } else {
      desktop.showSettingsSection(section);
    }
  }

  // Coalesce resize-drag mousemoves to one geometry update per frame. On
  // high-refresh displays, mousemove can fire more often than frames render;
  // applying every event forces redundant layout work mid-drag.
  let pendingResizeMoveEvent: MouseEvent | undefined;
  let resizeMoveFrame: number | undefined;

  function handleResizeMouseMove(event: MouseEvent) {
    // Only queue while a resize drag is active. Besides skipping rAF work on
    // ordinary mouse motion, this keeps a mousemove that landed just before
    // the resize mousedown from being replayed into the fresh drag (the move
    // handlers check their resizing flags at rAF time, not enqueue time).
    if (
      !desktop.desktopSidebarResizing &&
      !desktop.desktopRightSidebarResizing &&
      !desktop.desktopBottomPanelResizing
    ) {
      return;
    }
    pendingResizeMoveEvent = event;
    resizeMoveFrame ??= requestAnimationFrame(applyPendingResizeMove);
  }

  function applyPendingResizeMove() {
    resizeMoveFrame = undefined;
    const event = pendingResizeMoveEvent;
    pendingResizeMoveEvent = undefined;
    if (!event) return;
    desktop.moveDesktopSidebarResize(event);
    desktop.moveDesktopRightSidebarResize(event);
    desktop.moveDesktopBottomPanelResize(event);
  }

  function handleResizeMouseUp() {
    if (resizeMoveFrame !== undefined) {
      cancelAnimationFrame(resizeMoveFrame);
      resizeMoveFrame = undefined;
    }
    // Apply the final position before ending the gesture so the release
    // point is never dropped.
    const event = pendingResizeMoveEvent;
    pendingResizeMoveEvent = undefined;
    if (event) {
      desktop.moveDesktopSidebarResize(event);
      desktop.moveDesktopRightSidebarResize(event);
      desktop.moveDesktopBottomPanelResize(event);
    }
    desktop.stopDesktopSidebarResize();
    desktop.stopDesktopRightSidebarResize();
    desktop.stopDesktopBottomPanelResize();
  }

  onDestroy(() => {
    if (resizeMoveFrame !== undefined) {
      cancelAnimationFrame(resizeMoveFrame);
    }
  });
</script>

<svelte:window onmousemove={handleResizeMouseMove} onmouseup={handleResizeMouseUp} />

<RuntimeProviders runtime={core}>
  <!--
    NOTE: the `desktop.isDesktop` (assistantHost === "desktop") branches below are surprising in a
    file named DesktopPanel. This panel is meant for Desktop only, but the Visual Studio extension
    (not VS Code) currently mounts it too — it has no panel-based experience yet. These non-desktop
    branches (chrome and settings sections) are temporary and should be removed once VS gets
    dedicated panels.
  -->
  <!-- On non-desktop (VS) hosts, connectors renders inside the settings frame
       (it is still an IDE settings section); on desktop it is its own
       destination, handled below. -->
  {#if (isSettingsView(desktop.view) || desktop.view === "connectors") && !desktop.isDesktop}
    <div class="h-screen min-w-0 bg-psx-panel">
      <DesktopSettingsView
        section={activeSettingsSection(desktop.view, desktop.isDesktop)}
        availableSections={desktop.isDesktop ? DESKTOP_SETTINGS_SECTIONS : IDE_SETTINGS_SECTIONS}
        onSectionChange={showSettingsSection}
        onShowConnectors={desktop.showConnectors}
        onDone={desktop.showChat}
      />
    </div>
  {:else}
    <!-- `desktop-app-surface` is a styling hook: on macOS the desktop app clears this
         background (app.css, `.platform-macos`) so native window vibrancy shows through
         the sidebar band; elsewhere `bg-psx-panel` keeps it opaque. -->
    <div
      class={["flex h-screen min-w-0", desktop.isDesktop ? "desktop-app-surface bg-psx-panel" : ""]}
    >
      <!-- VS borrows this panel: desktop sidebar chrome vs the IDE sidebar (temporary; see note above) -->
      {#if desktop.isDesktop}
        <DesktopSideBar
          collapsed={desktop.sidebarCollapsed}
          currentView={desktop.view}
          width={desktop.desktopSidebarWidth}
          minWidth={desktop.DESKTOP_SIDEBAR_MIN_WIDTH}
          maxWidth={desktop.DESKTOP_SIDEBAR_MAX_WIDTH}
          resizing={desktop.desktopSidebarResizing}
          collapseDisabled={isSettingsSidebarView(desktop.view)}
          showCollapsedActions={desktop.view === "agents" ||
            desktop.view === "settings" ||
            desktop.view === "shortcuts" ||
            desktop.view === "models" ||
            desktop.view === "voice" ||
            desktop.view === "connectors" ||
            desktop.view === "github" ||
            desktop.view === "archived" ||
            desktop.view === "remote" ||
            desktop.view === "chat" ||
            desktop.view === "project-settings" ||
            desktop.isBlockingSessionLoading}
          currentWorkspaceFolders={desktop.currentACPWorkspaceFolders}
          onCollapsedChange={desktop.setSidebarCollapsed}
          onResizeStart={desktop.startDesktopSidebarResize}
          onWidthChange={desktop.setDesktopSidebarWidth}
          onNewConversation={desktop.handleNewConversation}
          onNewChat={desktop.handleNewChat}
          onShowSettings={desktop.showSettings}
          onShowShortcuts={desktop.showShortcuts}
          onShowModels={desktop.showModels}
          onShowVoice={desktop.showVoice}
          onShowConnectors={desktop.showConnectors}
          onShowGithub={desktop.showGithub}
          onShowAgents={desktop.showAgents}
          onShowArchived={desktop.showArchived}
          onShowRemote={desktop.showRemote}
          onShowProjectSettings={desktop.showProjectSettings}
          onShowChat={desktop.showChat}
          activeConversationId={desktop.activeConversationId}
          activeSession={desktop.activeSession}
          newTabAvailability={desktopNewTabAvailability}
          onActiveConversationIdChange={desktop.handleActiveConversationIdChange}
        />
      {:else}
        <IDESideBar
          collapsed={desktop.sidebarCollapsed}
          showCollapsedActions={desktop.isBlockingSessionLoading}
          currentWorkspaceFolders={desktop.currentACPWorkspaceFolders}
          onCollapsedChange={desktop.setSidebarCollapsed}
          onNewConversation={() => desktop.handleNewConversation()}
          onShowAgents={desktop.showAgents}
          onShowChat={desktop.showChat}
          activeConversationId={desktop.activeConversationId}
          activeSession={desktop.activeSession}
          onActiveConversationIdChange={desktop.handleActiveConversationIdChange}
        />
      {/if}

      {#if desktop.isDesktop && isSettingsView(desktop.view)}
        <DesktopSettingsView
          desktopFrame
          section={activeSettingsSection(desktop.view, desktop.isDesktop)}
          availableSections={DESKTOP_SETTINGS_SECTIONS}
          onSectionChange={showSettingsSection}
          onShowConnectors={desktop.showConnectors}
          onShowChat={desktop.showChat}
          activeConversationId={desktop.activeConversationId}
          onActiveConversationIdChange={desktop.handleActiveConversationIdChange}
        />
      {:else if desktop.view === "connectors" && desktop.isDesktop}
        <AcpConnectorsView
          desktopFrame
          sidebarCollapsed={desktop.sidebarCollapsed}
          onDone={desktop.showChat}
        />
      {:else if desktop.view === "project-settings" && desktop.isDesktop}
        <DesktopProjectSettingsView projectPath={desktop.projectSettingsPath} />
      {:else if desktop.view === "project-settings" && desktop.projectSettingsPath}
        <div class="min-w-0 flex-1">
          <ProjectSettingsView
            projectPath={desktop.projectSettingsPath}
            projectName={desktop.projectSettingsProject?.name}
            centerHeader={desktop.sidebarCollapsed}
            sidebarWidth={desktop.desktopSidebarWidth}
            onDone={desktop.showChat}
            desktopFrame={desktop.isDesktop}
          />
        </div>
      {:else if desktop.isDesktop}
        <AcpDesktopSplitsPane
          layoutKey={desktop.desktopChatLayoutKey}
          splitsCache={desktopSplitsCache}
          terminalWorktreePath={desktop.terminalWorktreePath}
          sidebarCollapsed={desktop.sidebarCollapsed}
          desktopSidebarWidth={desktop.desktopSidebarWidth}
          rightSidebarVisible={desktop.desktopRightSidebarVisible}
          rightSidebarWidth={desktop.desktopRightSidebarWidth}
          rightSidebarMinWidth={desktop.DESKTOP_RIGHT_SIDEBAR_MIN_WIDTH}
          rightSidebarMaxWidth={desktop.DESKTOP_RIGHT_SIDEBAR_MAX_WIDTH}
          rightSidebarResizing={desktop.desktopRightSidebarResizing}
          bottomPanelVisible={desktop.desktopBottomPanelVisible}
          bottomPanelHeight={desktop.desktopBottomPanelHeight}
          bottomPanelMinHeight={desktop.DESKTOP_BOTTOM_PANEL_MIN_HEIGHT}
          bottomPanelMaxHeight={desktop.DESKTOP_BOTTOM_PANEL_MAX_HEIGHT}
          bottomPanelResizing={desktop.desktopBottomPanelResizing}
          {desktopFileViewerPanel}
          activeConversationId={desktop.activeConversationId}
          onActiveConversationIdChange={desktop.handleActiveConversationIdChange}
          onNewTabAvailabilityChange={handleDesktopNewTabAvailabilityChange}
          navigationRequest={splitNavigationRequest}
          onNavigationChange={handleSplitNavigationChange}
          onExpandSidebar={desktop.expandSidebar}
          onRightSidebarVisibleChange={desktop.setDesktopRightSidebarVisible}
          onRightSidebarResizeStart={desktop.startDesktopRightSidebarResize}
          onRightSidebarWidthChange={desktop.setDesktopRightSidebarWidth}
          onBottomPanelVisibleChange={desktop.setDesktopBottomPanelVisible}
          onBottomPanelResizeStart={desktop.startDesktopBottomPanelResize}
          onBottomPanelHeightChange={desktop.setDesktopBottomPanelHeight}
          onNewConversation={desktop.handleNewConversation}
          onAddProject={desktop.handleAddProject}
          onShowAgentSettings={desktop.showAgents}
          onShowModelSettings={desktop.isDesktop ? desktop.showModels : undefined}
        >
          {#snippet promptBanners()}
            <AssistantConfigErrorBanner />
            <ACPAgentUpdateBanner />
          {/snippet}
        </AcpDesktopSplitsPane>
      {:else}
        <AcpChatPane
          chrome={{
            sidebar: {
              collapsed: desktop.sidebarCollapsed,
              width: desktop.desktopSidebarWidth,
              onExpand: desktop.expandSidebar,
            },
          }}
          activeConversationId={desktop.activeConversationId}
          onActiveConversationIdChange={desktop.handleActiveConversationIdChange}
          onNewConversation={desktop.handleNewConversation}
          onAddProject={desktop.handleAddProject}
          onShowAgentSettings={desktop.showAgents}
          onShowModelSettings={desktop.isDesktop ? desktop.showModels : undefined}
        >
          {#snippet promptBanners()}
            <AssistantConfigErrorBanner />
            <ACPAgentUpdateBanner />
          {/snippet}
        </AcpChatPane>
      {/if}
    </div>
  {/if}
</RuntimeProviders>

<style lang="postcss">
  :global(body.desktop-sidebar-resizing),
  :global(body.desktop-right-sidebar-resizing) {
    cursor: col-resize !important;
    user-select: none;
  }

  :global(body.desktop-sidebar-resizing *),
  :global(body.desktop-right-sidebar-resizing *) {
    cursor: col-resize !important;
  }

  :global(body.desktop-bottom-panel-resizing) {
    cursor: row-resize !important;
    user-select: none;
  }

  :global(body.desktop-bottom-panel-resizing *) {
    cursor: row-resize !important;
  }
</style>
