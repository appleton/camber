<script lang="ts">
  import { InfoMessageType } from "@camber/rpc";
  import { formatError } from "@camber/lib/errors";
  import { onMount } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import ArchivedConversationPreviewDialog from "./ArchivedConversationPreviewDialog.svelte";
  import { getACPConversationRepo } from "../features/ConversationRepository.svelte";
  import { getACPLocalHistoryRepo } from "../features/LocalHistoryRepository.svelte";
  import { getACPProjectRepo } from "../features/ProjectRepository.svelte";
  import { rpc } from "../hostRpc";
  import { isACPChatConversation, type ACPConversationSummary } from "../navTypes";
  import { ACP_CHAT_WORKSPACE_PATH } from "../workspaceScope";
  import {
    findVisibleNavSession,
    groupSessionsByProject,
    historySessionKey,
  } from "./sessionPickerUtil";
  import HistoryOverlay from "./sidebar/HistoryOverlay.svelte";
  import { setAcpSidebarController } from "./sidebar/SidebarController.svelte";
  import SettingsSection from "./settings/SettingsSection.svelte";
  import ConfirmationDialog from "./ui/ConfirmationDialog.svelte";

  interface Props {
    onShowChat?: () => void;
    activeConversationId?: string | null;
    onActiveConversationIdChange?: (id: string | null) => void;
  }

  let {
    onShowChat = () => {},
    activeConversationId = null,
    onActiveConversationIdChange,
  }: Props = $props();

  const conversations = getACPConversationRepo();
  const localHistory = getACPLocalHistoryRepo();
  const projects = getACPProjectRepo();
  const sidebar = setAcpSidebarController({
    onShowChat,
    onNewConversation: () => null,
    getActiveConversationId: () => activeConversationId,
    setActiveConversationId: (id) => onActiveConversationIdChange?.(id),
    isChatActive: () => false,
  });

  let searchQuery = $state("");
  let selectedProjectPath = $state("/");
  let hasArchivedChats = $state(false);
  let restoredHistorySessionKeys = $state(new Set<string>());
  let preview = $state<{
    conversationId: string;
    title: string;
    session: ACPConversationSummary;
    restoreSession?: ACPConversationSummary;
  } | null>(null);
  let deleteTarget = $state<{
    session: ACPConversationSummary;
    closePreviewAfterDelete: boolean;
  } | null>(null);
  let previewLoadGeneration = 0;
  let rootProjects = $derived(projects.projects.filter((project) => !project.isWorktree));
  let groupedHistorySessions = $derived(
    groupSessionsByProject(localHistory.sessions ?? [], searchQuery, projects.projects),
  );

  onMount(() => {
    void refreshHistory(selectedProjectPath);
  });

  async function refreshHistory(path: string): Promise<void> {
    await localHistory.refresh(path);
    if (path === "/" || path === ACP_CHAT_WORKSPACE_PATH) {
      hasArchivedChats = localHistory.sessions.some(isACPChatConversation);
    }
  }

  function getSessionAgentServer(session: { agentServer?: string }): string {
    return sidebar.getSessionAgentServer(session);
  }

  function visibleNavSessionForHistorySession(
    session: ACPConversationSummary,
  ): ACPConversationSummary | undefined {
    return findVisibleNavSession(
      session,
      conversations.sessions ?? [],
      restoredHistorySessionKeys,
      getSessionAgentServer,
    );
  }

  async function selectProject(path: string): Promise<void> {
    selectedProjectPath = path;
    searchQuery = "";
    restoredHistorySessionKeys = new Set();
    await refreshHistory(path);
  }

  async function restoreHistorySessionAndReport(session: ACPConversationSummary): Promise<boolean> {
    const targetPath =
      session.workspacePath && session.workspacePath !== "/"
        ? session.workspacePath
        : session.cwd || selectedProjectPath;
    try {
      await conversations.restoreConversation(targetPath, session);
      restoredHistorySessionKeys = new Set(restoredHistorySessionKeys).add(
        historySessionKey(session, getSessionAgentServer),
      );
      return true;
    } catch (error) {
      rpc.showInfoMessage(
        formatError(error, { prefix: "Failed to restore conversation" }),
        InfoMessageType.error,
      );
      return false;
    }
  }

  async function restoreHistorySession(session: ACPConversationSummary): Promise<boolean> {
    return restoreHistorySessionAndReport(session);
  }

  async function openRestoredHistorySession(
    session: ACPConversationSummary,
    navSession: ACPConversationSummary,
  ): Promise<void> {
    await openHistorySessionPreview(session, navSession, [], false);
  }

  async function openHistorySessionReadOnly(session: ACPConversationSummary): Promise<void> {
    const fallbackCwds = [
      session.workspacePath,
      selectedProjectPath,
      rootProjects[0]?.path,
      "/",
    ].filter((path): path is string => Boolean(path));
    await openHistorySessionPreview(session, session, fallbackCwds, true);
  }

  async function openHistorySessionPreview(
    historySession: ACPConversationSummary,
    sessionToLoad: ACPConversationSummary,
    fallbackCwds: string[],
    canRestore: boolean,
  ): Promise<void> {
    const generation = ++previewLoadGeneration;
    const title = historySession.title || "Untitled Conversation";
    const cwd =
      sessionToLoad.cwd ||
      historySession.cwd ||
      historySession.workspacePath ||
      selectedProjectPath ||
      "/";
    const restoreSession = canRestore ? historySession : undefined;
    preview = { conversationId: sessionToLoad.id, title, session: historySession, restoreSession };
    const conversationId = await sidebar.loadSessionPreview(sessionToLoad, cwd, fallbackCwds);
    if (generation !== previewLoadGeneration || !preview) return;
    preview = { conversationId, title, session: historySession, restoreSession };
  }

  async function restorePreviewSession(session?: ACPConversationSummary): Promise<void> {
    if (!session) return;
    if (await restoreHistorySessionAndReport(session)) closePreview();
  }

  function closePreview(): void {
    previewLoadGeneration++;
    preview = null;
  }

  async function archiveHistorySession(
    session: ACPConversationSummary,
    navSession: ACPConversationSummary,
    event: MouseEvent,
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const agentServer = getSessionAgentServer(navSession);
    if (sidebar.shouldInterruptSelectedSession(navSession.sessionId, agentServer)) {
      await sidebar.cancelActiveSession();
    }
    await conversations.archiveSession(
      navSession.cwd || session.cwd || selectedProjectPath || "/",
      navSession.sessionId,
      agentServer,
      navSession.id,
    );
    if (activeConversationId === navSession.id) {
      onActiveConversationIdChange?.(null);
    }
    const updated = new Set(restoredHistorySessionKeys);
    updated.delete(historySessionKey(session, getSessionAgentServer));
    restoredHistorySessionKeys = updated;
  }

  function requestDeleteHistorySession(
    session: ACPConversationSummary,
    event?: MouseEvent,
    closePreviewAfterDelete = false,
  ): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!session.sessionId) return;
    deleteTarget = { session, closePreviewAfterDelete };
  }

  async function confirmDeleteHistorySession(): Promise<void> {
    const target = deleteTarget;
    if (!target?.session.sessionId) return;
    const { session } = target;
    if (!session.sessionId) return;
    const agentServer = getSessionAgentServer(session);
    localHistory.deleteSession(session.sessionId, agentServer);
    if (selectedProjectPath === "/" || selectedProjectPath === ACP_CHAT_WORKSPACE_PATH) {
      hasArchivedChats = localHistory.sessions.some(isACPChatConversation);
    }
    const updated = new Set(restoredHistorySessionKeys);
    updated.delete(historySessionKey(session, getSessionAgentServer));
    restoredHistorySessionKeys = updated;
    await conversations.deleteSession(session.sessionId, agentServer);
    if (target.closePreviewAfterDelete) closePreview();
    deleteTarget = null;
  }

  function portalToBody(): Attachment {
    return (element: Element) => {
      document.body.appendChild(element);
      return () => element.remove();
    };
  }
</script>

<SettingsSection
  title="Archived Chats"
  subtitle="Browse archived conversations across all of your projects."
  class="archived-chats-settings-section [&_button]:cursor-default"
>
  <HistoryOverlay
    bind:searchQuery
    embedded
    {groupedHistorySessions}
    state={localHistory.state}
    sessionCount={localHistory.sessions.length}
    backLabel="Back"
    emptyLabel="No archived chats"
    reconciling={localHistory.reconciling}
    listFailures={localHistory.listFailures}
    projects={projects.projects}
    {selectedProjectPath}
    {hasArchivedChats}
    onSelectProject={selectProject}
    {visibleNavSessionForHistorySession}
    onBack={() => {}}
    onOpenRestoredHistorySession={openRestoredHistorySession}
    onOpenHistorySessionReadOnly={openHistorySessionReadOnly}
    onArchiveHistorySession={archiveHistorySession}
    onRestoreHistorySession={restoreHistorySession}
    onDeleteHistorySession={requestDeleteHistorySession}
  />
</SettingsSection>

{#if preview}
  {@const activePreview = preview}
  <div class="archive-preview-dialog-portal contents" {@attach portalToBody()}>
    <ArchivedConversationPreviewDialog
      conversationId={activePreview.conversationId}
      title={activePreview.title}
      onRestore={activePreview.restoreSession
        ? () => restorePreviewSession(activePreview.restoreSession)
        : undefined}
      onDelete={() => requestDeleteHistorySession(activePreview.session, undefined, true)}
      deleteDisabled={!sidebar.canDeleteSession(activePreview.session)}
      closeDisabled={Boolean(deleteTarget)}
      onClose={closePreview}
    />
  </div>
{/if}

{#if deleteTarget}
  <div class="archive-delete-dialog-portal contents" {@attach portalToBody()}>
    <ConfirmationDialog
      destructive
      title="Delete Conversation?"
      description={isACPChatConversation(deleteTarget.session)
        ? "This removes the conversation and any associated files and cannot be undone."
        : "This removes the conversation and cannot be undone."}
      confirmLabel="Delete Conversation"
      onCancel={() => (deleteTarget = null)}
      onConfirm={confirmDeleteHistorySession}
    />
  </div>
{/if}
