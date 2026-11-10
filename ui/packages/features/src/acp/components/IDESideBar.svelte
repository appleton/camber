<script lang="ts">
  import { createPopover, melt } from "@melt-ui/svelte";
  import Icon, { type IconName } from "@camber/components/icon";
  import { formatError } from "@camber/lib/errors";
  import { InfoMessageType, type WorkspaceFolder } from "@camber/rpc";
  import { onDestroy, onMount } from "svelte";
  import type { ACPSession } from "../features/Session.svelte";
  import { ACP_IDE_WORKSPACE_PATH, acpProtocolCwd, acpSessionLoadCwd } from "../workspaceScope";
  import { rpc } from "../hostRpc";
  import {
    ACP_DESKTOP_CONVERSATIONS_EVENT,
    type ACPConversationSummary,
    type ACPConversationsState,
  } from "../navTypes";
  import { getACPConversationRepo } from "../features/ConversationRepository.svelte";
  import { getACPLocalHistoryRepo } from "../features/LocalHistoryRepository.svelte";
  import { conversationFitsWorkspaceFolders } from "../workspacePaths";
  import { findVisibleNavSession, groupSessions, historySessionKey } from "./sessionPickerUtil";
  import CollapsedSidebarActions from "./sidebar/CollapsedSidebarActions.svelte";
  import { setAcpSidebarController } from "./sidebar/SidebarController.svelte";
  import ConversationGroup from "./sidebar/ConversationGroup.svelte";
  import ConversationPreview from "./sidebar/ConversationPreview.svelte";
  import ContextMenu, { type ContextMenuItem } from "./sidebar/ContextMenu.svelte";
  import HistoryOverlay from "./sidebar/HistoryOverlay.svelte";
  import { sidebarOpensViewLabel, sidebarRenameLabel } from "./sidebar/menuLabels";
  import RenameDialog from "./sidebar/RenameDialog.svelte";
  import ConfirmationDialog from "./ui/ConfirmationDialog.svelte";
  import { getOptionalACPConnectionPoolContext } from "../connectionPoolContext";
  import ACPLogCaptureConfirmation from "./sidebar/ACPLogCaptureConfirmation.svelte";
  import { acpLogCaptureMenuAction, type ACPLogCaptureTarget } from "./sidebar/acpLogCapture";
  import SidebarIconButton from "./sidebar/SidebarIconButton.svelte";
  import SidebarSearch from "./sidebar/SidebarSearch.svelte";
  import SidebarToasts from "./sidebar/SidebarToasts.svelte";
  import { sidebarToasts } from "./sidebar/sidebarToastsState.svelte";
  import { suppressContextMenu } from "./sidebar/contextMenuHelpers";
  import IDESettingsPill from "./sidebar/IDESettingsPill.svelte";
  import { UNDO_COUNTDOWN_SECONDS, UndoCountdown } from "./sidebar/undoCountdown";
  import { rowExitAnimation } from "./sidebar/rowExitAnimation.svelte";

  interface Props {
    collapsed: boolean;
    showCollapsedActions?: boolean;
    currentWorkspaceFolders: WorkspaceFolder[];
    onCollapsedChange: (collapsed: boolean) => void;
    onNewConversation: () => void;
    onShowAgents: () => void;
    onShowConnectors?: () => void;
    onShowChat: () => void;
    fillWidth?: boolean;
    collapsible?: boolean;
    showHeaderActions?: boolean;
    activeConversationId?: string | null;
    activeSession?: ACPSession | null;
    onActiveConversationIdChange?: (id: string | null) => void;
  }

  let {
    collapsed,
    showCollapsedActions = false,
    currentWorkspaceFolders,
    onCollapsedChange,
    onNewConversation,
    onShowAgents,
    onShowConnectors,
    onShowChat,
    fillWidth = false,
    collapsible = true,
    showHeaderActions = true,
    activeConversationId = null,
    activeSession = null,
    onActiveConversationIdChange,
  }: Props = $props();

  const conversations = getACPConversationRepo();
  const acpConnectionPool = getOptionalACPConnectionPoolContext();
  const history = getACPLocalHistoryRepo();
  const sidebar = setAcpSidebarController({
    onShowChat,
    onNewConversation,
    getActiveConversationId: () => activeConversationId,
    getActiveSession: () => activeSession,
    setActiveConversationId: (id) => onActiveConversationIdChange?.(id),
    resolveSessionCwd: (session) => acpSessionLoadCwd(session.cwd, currentWorkspaceFolders),
    isChatActive: () => true,
  });
  onDestroy(() => sidebar.destroy());

  let searchQuery = $state("");
  let showingHistory = $state(false);
  let restoredHistorySessionKeys = $state(new Set<string>());
  let navSessions = $state<ACPConversationSummary[]>([]);
  let contextMenu = $state<{
    x: number;
    y: number;
    actions: ContextMenuItem[];
  } | null>(null);
  let renameTarget = $state<{ id: string; name: string } | null>(null);
  let acpLogCaptureTarget = $state<ACPLogCaptureTarget | null>(null);
  let deleteConversationTarget = $state<{
    session: ACPConversationSummary;
    name: string;
  } | null>(null);
  let exitingConversationIds = $state(new Set<string>());
  let rowExitAnimating = $derived(rowExitAnimation.animating);
  const conversationArchiveCountdown = new UndoCountdown(() => {});
  let isLoading = $derived(sidebar.isLoading);
  let groupedHistorySessions = $derived(groupSessions(history.sessions ?? [], searchQuery));

  const {
    elements: { trigger: settingsTrigger, content: settingsContent },
    states: { open: settingsOpen },
  } = createPopover({
    positioning: { placement: "top-end", gutter: 8 },
    forceVisible: true,
  });

  let visibleSessions = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    return navSessions.filter((session) => {
      if (exitingConversationIds.has(session.id)) return false;
      if (!conversationFitsWorkspaceFolders(session, currentWorkspaceFolders)) return false;
      if (!query) return true;
      return (
        (session.title || "Untitled Conversation").toLowerCase().includes(query) ||
        getAgentName(getSessionAgentServer(session)).toLowerCase().includes(query)
      );
    });
  });

  onMount(() => {
    const handleConversationState = (event: Event) => {
      navSessions = [...(event as CustomEvent<ACPConversationsState>).detail.sessions];
    };
    conversations.emitter.addEventListener(
      ACP_DESKTOP_CONVERSATIONS_EVENT,
      handleConversationState,
    );
    navSessions = conversations.sessions ?? [];
    if (navSessions.length === 0) {
      void conversations.refresh();
    }
    return () => {
      conversations.emitter.removeEventListener(
        ACP_DESKTOP_CONVERSATIONS_EVENT,
        handleConversationState,
      );
      conversationArchiveCountdown.destroy();
      for (const conversationId of exitingConversationIds) {
        sidebarToasts.dismiss(conversationArchiveToastId(conversationId));
      }
    };
  });

  function getSessionAgentServer(session: { agentServer?: string }): string {
    return sidebar.getSessionAgentServer(session);
  }

  function getAgentName(agentServer: string): string {
    return sidebar.getAgentName(agentServer);
  }

  function visibleNavSessionForHistorySession(
    session: ACPConversationSummary,
  ): ACPConversationSummary | undefined {
    return findVisibleNavSession(
      session,
      navSessions,
      restoredHistorySessionKeys,
      getSessionAgentServer,
    );
  }

  function conversationArchiveToastId(conversationId: string): string {
    return `conversation-archive:${conversationId}`;
  }

  function isSessionExiting(session: ACPConversationSummary): boolean {
    return exitingConversationIds.has(session.id);
  }

  function setConversationExiting(conversationId: string, exiting: boolean) {
    if (exitingConversationIds.has(conversationId) === exiting) return;
    const next = new Set(exitingConversationIds);
    if (exiting) next.add(conversationId);
    else next.delete(conversationId);
    exitingConversationIds = next;
    if (exiting) rowExitAnimation.hold();
  }

  async function openHistory() {
    restoredHistorySessionKeys = new Set();
    searchQuery = "";
    showingHistory = true;
    await history.refresh(acpProtocolCwd(currentWorkspaceFolders));
  }

  async function restoreHistorySession(session: ACPConversationSummary) {
    // Restoring only un-archives the conversation in local nav state; it does not
    // move the session in the agent, which still holds it under its original cwd.
    // Re-homing the record onto the current folder here would make the next
    // session/load look in a directory the agent never stored the session under.
    const cwd = acpSessionLoadCwd(session.cwd, currentWorkspaceFolders);
    const workingDirectories = session.workingDirectories?.length
      ? Array.from(session.workingDirectories)
      : [cwd];
    await conversations.restoreConversation(ACP_IDE_WORKSPACE_PATH, {
      ...session,
      cwd,
      workingDirectories,
    });
    restoredHistorySessionKeys = new Set(restoredHistorySessionKeys).add(
      historySessionKey(session, getSessionAgentServer),
    );
  }

  async function openRestoredHistorySession(
    session: ACPConversationSummary,
    navSession: ACPConversationSummary,
  ) {
    showingHistory = false;
    await sidebar.openSession(
      navSession,
      acpSessionLoadCwd(navSession.cwd || session.cwd, currentWorkspaceFolders),
    );
  }

  // Opens an archived conversation as a read-only transcript without
  // restoring it, falling back to the current workspace folder when the
  // session's original directory no longer exists. The history overlay stays
  // open so the user can keep browsing and open other conversations.
  async function openHistorySessionReadOnly(session: ACPConversationSummary) {
    await sidebar.openSession(session, acpSessionLoadCwd(session.cwd, currentWorkspaceFolders), {
      readOnly: true,
      fallbackCwds: [acpProtocolCwd(currentWorkspaceFolders), "/"],
    });
  }

  async function performArchiveSession(
    sessionId: string | null,
    agentServer: string,
    conversationId: string,
  ) {
    conversationArchiveCountdown.cancel(conversationId);
    sidebarToasts.dismiss(conversationArchiveToastId(conversationId));
    setConversationExiting(conversationId, true);
    try {
      if (sidebar.shouldInterruptSelectedSession(sessionId, agentServer)) {
        await sidebar.cancelActiveSession();
      }
      await conversations.archiveSession(
        ACP_IDE_WORKSPACE_PATH,
        sessionId,
        agentServer,
        conversationId,
      );
      if (sessionId) {
        await rpc.closeAcpChat({ conversationId, agentServer, sessionId });
      }
    } catch (error) {
      rpc.showInfoMessage(
        formatError(error, {
          prefix: "Failed to archive conversation",
        }),
        InfoMessageType.error,
      );
    } finally {
      setConversationExiting(conversationId, false);
    }
  }

  async function handleArchiveSession(
    sessionId: string | null,
    agentServer: string,
    conversationId: string,
    event: Event,
  ) {
    event.preventDefault();
    event.stopPropagation();
    await performArchiveSession(sessionId, agentServer, conversationId);
  }

  function handleArchiveRowSession(session: ACPConversationSummary, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setConversationExiting(session.id, true);
    sidebarToasts.addProgressToast(
      conversationArchiveToastId(session.id),
      "Archiving conversation...",
      { kind: "countdown", durationMs: UNDO_COUNTDOWN_SECONDS * 1000 },
      { label: "Cancel", onClick: () => undoArchiveSession(session.id) },
    );
    conversationArchiveCountdown.start(
      session.id,
      () =>
        void performArchiveSession(session.sessionId, getSessionAgentServer(session), session.id),
    );
  }

  function handleArchiveRowSessionNow(session: ACPConversationSummary, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    void performArchiveSession(session.sessionId, getSessionAgentServer(session), session.id);
  }

  function undoArchiveSession(conversationId: string) {
    conversationArchiveCountdown.cancel(conversationId);
    sidebarToasts.dismiss(conversationArchiveToastId(conversationId));
    setConversationExiting(conversationId, false);
  }

  async function handleArchiveHistorySession(
    session: ACPConversationSummary,
    navSession: ACPConversationSummary,
    event: Event,
  ) {
    await handleArchiveSession(
      navSession.sessionId,
      getSessionAgentServer(navSession),
      navSession.id,
      event,
    );
    const updated = new Set(restoredHistorySessionKeys);
    updated.delete(historySessionKey(session, getSessionAgentServer));
    restoredHistorySessionKeys = updated;
  }

  async function handleDeleteHistorySession(session: ACPConversationSummary, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!session.sessionId) return;
    const agentServer = getSessionAgentServer(session);
    history.deleteSession(session.sessionId, agentServer);
    const updated = new Set(restoredHistorySessionKeys);
    updated.delete(historySessionKey(session, getSessionAgentServer));
    restoredHistorySessionKeys = updated;
    await conversations.deleteSession(session.sessionId, agentServer);
  }

  async function handleDeleteSession(session: ACPConversationSummary, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    const agentServer = getSessionAgentServer(session);
    // Marked exiting so the row plays the same slide-out as an archive; the
    // finally re-reveals it if the delete failed.
    setConversationExiting(session.id, true);
    try {
      if (sidebar.shouldInterruptSelectedSession(session.sessionId, agentServer)) {
        await sidebar.cancelActiveSession();
      }
      await conversations.deleteConversation(session.id, session.sessionId, agentServer);
      if (session.sessionId) {
        await rpc.closeAcpChat({
          conversationId: session.id,
          agentServer,
          sessionId: session.sessionId,
        });
      }
    } finally {
      setConversationExiting(session.id, false);
    }
  }

  function openContextMenu(event: MouseEvent, actions: ContextMenuItem[]) {
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    contextMenu = {
      x: event.clientX,
      y: event.clientY,
      actions,
    };
  }

  function openSessionContextMenu(session: ACPConversationSummary, event: MouseEvent) {
    const canDelete = !session.sessionId || sidebar.canDeleteSession(session);
    openContextMenu(event, [
      {
        name: sidebarRenameLabel("Conversation"),
        icon: "pencil",
        callback: () => {
          renameTarget = { id: session.id, name: session.title || "Untitled Conversation" };
        },
      },
      acpLogCaptureMenuAction(
        acpConnectionPool?.debug?.capture,
        {
          agentServer: getSessionAgentServer(session),
          conversationId: session.id,
          sessionId: session.sessionId,
        },
        (target) => (acpLogCaptureTarget = target),
      ),
      { kind: "separator" },
      {
        name: "Copy Session ID",
        icon: "copy",
        disabled: !session.sessionId,
        callback: () => {
          if (session.sessionId) rpc.writeToClipboard(session.sessionId);
        },
      },
      { kind: "separator" },
      {
        name: "Archive Conversation",
        icon: "archive",
        callback: () => handleArchiveRowSession(session, event),
      },
      {
        name: sidebarOpensViewLabel("Delete Conversation"),
        icon: "trash",
        disabled: !canDelete,
        callback: () => {
          deleteConversationTarget = {
            session,
            name: session.title || "Untitled Conversation",
          };
        },
      },
    ]);
  }

  async function submitRename(value: string) {
    const target = renameTarget;
    if (!target) return;
    renameTarget = null;
    try {
      await conversations.renameConversation(target.id, value);
    } catch (error) {
      console.error("Failed to rename ACP conversation", error);
    }
  }

  function setCollapsed(nextCollapsed: boolean) {
    if (!collapsible) return;
    onCollapsedChange(nextCollapsed);
  }

  let isCollapsed = $derived(collapsible && collapsed);
</script>

{#snippet settingsMenuItem(
  icon: IconName,
  title: string,
  description: string,
  onclick: () => void,
  disabled = false,
)}
  <button
    type="button"
    class="hover:bg-psx-menu-hover-background outline-hidden focus-visible:outline-psx-focus flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
    {onclick}
    {disabled}
    oncontextmenu={suppressContextMenu}
  >
    <Icon name={icon} size={18} class="text-psx-icon shrink-0" />
    <span class="flex min-w-0 flex-col">
      <span class="text-psx-foreground-primary text-xs font-medium">{title}</span>
      <span class="text-psx-foreground-secondary text-[11px]">{description}</span>
    </span>
  </button>
{/snippet}

{#if isCollapsed}
  {#if showCollapsedActions}
    <CollapsedSidebarActions
      expandLabel="Expand conversations sidebar"
      {isLoading}
      onExpand={() => setCollapsed(false)}
      {onNewConversation}
    />
  {:else}
    <aside
      class="text-psx-foreground-primary relative z-20 h-full w-0 shrink-0 select-none"
    ></aside>
  {/if}
{:else}
  <aside
    class={[
      "border-psx-border bg-psx-panel text-psx-foreground-primary relative z-20 flex h-full shrink-0 select-none flex-col border-r",
      fillWidth ? "w-full" : "w-[260px]",
    ]}
    aria-label="ACP conversations"
  >
    {#if showHeaderActions}
      <div class="flex h-10 shrink-0 items-center gap-1 border-b border-transparent pl-2 pr-2">
        {#if collapsible}
          <SidebarIconButton
            icon="sidebar-hide"
            label="Collapse conversations sidebar"
            onclick={() => setCollapsed(true)}
          />
        {/if}
        <div class="min-w-0 flex-1"></div>
        <SidebarIconButton
          icon="new"
          label="New conversation"
          disabled={isLoading}
          onclick={onNewConversation}
        />
      </div>
    {/if}

    <SidebarSearch
      bind:value={searchQuery}
      placeholder={showingHistory ? "Search history" : "Search conversations"}
      archiveLabel="Show archived conversations"
      onArchive={openHistory}
    />

    <div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5 pt-px">
      {#if conversations.refreshState.status === "failure"}
        <div class="text-psx-foreground-secondary px-2 py-4 text-center text-xs">
          {formatError(conversations.refreshState.error, {
            prefix: "Failed to load conversations",
          })}
        </div>
      {:else if visibleSessions.length === 0 && !rowExitAnimating}
        {#if searchQuery.trim()}
          <div
            class="text-psx-foreground-primary mx-auto flex min-w-0 max-w-[80%] items-center justify-center gap-2 px-2 py-6 text-sm"
          >
            <Icon
              name="search"
              size={14}
              class="text-psx-foreground-primary shrink-0"
              aria-hidden="true"
            />
            <span class="min-w-0 truncate">
              No conversations found with {searchQuery.trim()}
            </span>
          </div>
        {:else}
          <div class="text-psx-foreground-primary px-2 py-8 text-center text-sm">
            No conversations yet
          </div>
        {/if}
      {:else}
        <ConversationGroup
          sessions={visibleSessions}
          workspacePath={ACP_IDE_WORKSPACE_PATH}
          {searchQuery}
          expanded
          visibleLimit={visibleSessions.length}
          onToggleExpanded={() => {}}
          onArchiveSession={handleArchiveRowSession}
          onArchiveSessionNow={handleArchiveRowSessionNow}
          onSessionContextMenu={openSessionContextMenu}
          {isSessionExiting}
        />
      {/if}
    </div>

    <SidebarToasts class="flex shrink-0 flex-col px-1.5 pb-12" />

    {#if showingHistory}
      <HistoryOverlay
        bind:searchQuery
        {groupedHistorySessions}
        state={history.state}
        sessionCount={history.sessions.length}
        backLabel="Back to Active Chats"
        reconciling={history.reconciling}
        listFailures={history.listFailures}
        {visibleNavSessionForHistorySession}
        onBack={() => (showingHistory = false)}
        onOpenRestoredHistorySession={openRestoredHistorySession}
        onOpenHistorySessionReadOnly={openHistorySessionReadOnly}
        onArchiveHistorySession={handleArchiveHistorySession}
        onRestoreHistorySession={restoreHistorySession}
        onDeleteHistorySession={handleDeleteHistorySession}
      />
    {/if}

    <IDESettingsPill trigger={$settingsTrigger} active={$settingsOpen} />

    {#if $settingsOpen}
      <div
        use:melt={$settingsContent}
        class="menu-surface z-50 flex w-[224px] flex-col gap-0.5 p-1.5"
      >
        {#if onShowConnectors}
          {@render settingsMenuItem("mcp", "Connectors", "MCP servers & tools", () => {
            settingsOpen.set(false);
            onShowConnectors();
          })}
        {/if}
        {@render settingsMenuItem("sparkles", "Agents", "Configure & enable agents", () => {
          settingsOpen.set(false);
          onShowAgents();
        })}
        {@render settingsMenuItem("gear", "Extension Settings", "Camber extension options", () => {
          settingsOpen.set(false);
          rpc.openSettings();
        })}
      </div>
    {/if}
  </aside>
{/if}

<ConversationPreview />

{#if contextMenu}
  <ContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    actions={contextMenu.actions}
    onClose={() => (contextMenu = null)}
  />
{/if}

{#if deleteConversationTarget}
  <ConfirmationDialog
    destructive
    title="Delete conversation?"
    description={`Delete ${deleteConversationTarget.name}. This removes the conversation and cannot be undone.`}
    confirmLabel="Delete Conversation"
    onCancel={() => (deleteConversationTarget = null)}
    onConfirm={async () => {
      const target = deleteConversationTarget;
      if (!target) return;
      await handleDeleteSession(target.session);
      deleteConversationTarget = null;
    }}
  />
{/if}

{#if renameTarget}
  <RenameDialog
    title="Rename conversation"
    label="Name"
    value={renameTarget.name}
    onCancel={() => (renameTarget = null)}
    onRename={submitRename}
  />
{/if}

{#if acpLogCaptureTarget}
  <ACPLogCaptureConfirmation
    target={acpLogCaptureTarget}
    onClose={() => (acpLogCaptureTarget = null)}
  />
{/if}
