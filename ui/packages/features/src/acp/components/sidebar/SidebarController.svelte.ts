import { createContext } from "svelte";
import { DEFAULT_AGENT_SERVER, LOCAL_AGENT_SERVER } from "../../agentServers";
import { getACPAgentRegistryRepo } from "../../features/AgentRegistryRepository.svelte";
import { getACPConversationRepo } from "../../features/ConversationRepository.svelte";
import { supportsSessionDelete } from "../../features/HistoryRepository.svelte";
import type { ACPSession } from "../../features/Session.svelte";
import { getACPSessionRepo } from "../../features/SessionRepository.svelte";
import { currentACPHostState, isSplitACPHost } from "../../hostAdapter";
import { rpc } from "../../hostRpc";
import { agentServerIconUrl } from "../../localAgentIcon";
import { isACPChatConversation, type ACPConversationSummary } from "../../navTypes";
import type { ACPResolvedSessionInfo } from "../../sessionInfo";
import { agentPickerIconProps, agentPickerIconUrl } from "../chat/menus/config/agentConfig";
import {
  ConversationPreviewCoordinator,
  type ConversationPreviewAnchorTarget,
} from "./ConversationPreviewCoordinator";

export interface SidebarLiveStatus {
  working: boolean;
  waitingForUser: boolean;
  unread: boolean;
}

const emptyLiveStatus: SidebarLiveStatus = {
  working: false,
  waitingForUser: false,
  unread: false,
};

export interface ConversationRowState {
  agentServer: string;
  agentName: string;
  iconUrl?: string;
  working: boolean;
  waitingForUser: boolean;
  unread: boolean;
  selected: boolean;
  iconClass: string;
  titleClass: string;
}

export interface SidebarConversationPreviewTarget extends ConversationPreviewAnchorTarget {
  session: ACPConversationSummary;
  agentName: string;
  iconUrl?: string;
  iconClass: string;
  iconSize: number;
  desktop: boolean;
}

// The sidebar row currently renaming inline (Finder-style). Worktrees are
// projects in the nav model, but the kind is kept distinct so only the row the
// menu was opened on enters edit mode.
export type SidebarRenameTarget =
  | { kind: "project" | "worktree"; path: string }
  | { kind: "conversation"; id: string };

export interface OpenSessionOptions {
  // Open the session for inspection only: the read-only banner shows and
  // prompting is disabled. Used by the archive so conversations can be read
  // (and copied from) without restoring them.
  readOnly?: boolean;
  // Working directories to retry session/load with when the session's own cwd
  // no longer exists (e.g. a removed worktree).
  fallbackCwds?: string[];
}

interface AcpSidebarControllerOptions {
  onShowChat: () => void;
  onNewConversation: (cwd?: string) => string | null | void | Promise<string | null | void>;
  getActiveConversationId?: () => string | null;
  getActiveSession?: () => ACPSession | null;
  setActiveConversationId?: (key: string | null) => void;
  resolveSessionCwd?: (session: ACPConversationSummary) => string;
  // When false, no conversation row renders as selected — e.g. while the
  // Connectors destination is open — so the sidebar never shows two active items.
  isChatActive?: () => boolean;
}

export class AcpSidebarController {
  private registry = getACPAgentRegistryRepo();
  private conversations = getACPConversationRepo();
  private repo = getACPSessionRepo();
  conversationPreviewTarget = $state<SidebarConversationPreviewTarget | null>(null);
  private conversationPreview =
    new ConversationPreviewCoordinator<SidebarConversationPreviewTarget>({
      onTargetChange: (target) => (this.conversationPreviewTarget = target),
    });
  // Bumped whenever the active conversation changes hands, so an openSession
  // whose history load resolves after the user has already switched elsewhere
  // cannot steal the active conversation back.
  private openSessionGeneration = 0;
  // Inline rename: the row matching renameTarget swaps its label for a
  // RenamableLabel input. The submit callback is captured at beginRename time
  // so row components stay ignorant of the mutation behind each kind.
  renameTarget = $state<SidebarRenameTarget | null>(null);
  private renameSubmitCallback: ((name: string) => void | Promise<void>) | null = null;

  constructor(private options: AcpSidebarControllerOptions) {}

  openConversationPreview(target: SidebarConversationPreviewTarget, event: PointerEvent): void {
    if (event.pointerType !== "mouse" || this.renameTarget) return;
    this.conversationPreview.rowEntered(target, { x: event.clientX, y: event.clientY });
  }

  leaveConversationPreview(key: string): void {
    this.conversationPreview.rowLeft(key);
  }

  cancelConversationPreviewOpen(key: string): void {
    this.conversationPreview.rowPointerDown(key);
  }

  unmountConversationPreviewRow(key: string, anchor: HTMLElement): void {
    this.conversationPreview.rowUnmounted(key, anchor);
  }

  refreshConversationPreview(target: SidebarConversationPreviewTarget): void {
    this.conversationPreview.refreshTarget(target);
  }

  enterConversationPreview(): void {
    this.conversationPreview.popoverEntered();
  }

  leaveOpenConversationPreview(): void {
    this.conversationPreview.popoverLeft();
  }

  trackConversationPreviewPointer(event: MouseEvent): void {
    this.conversationPreview.pointerMoved({ x: event.clientX, y: event.clientY });
  }

  setConversationPreviewElement(element: HTMLElement | null): void {
    this.conversationPreview.setPopoverElement(element);
  }

  closeConversationPreview(): void {
    this.conversationPreview.closeNow();
  }

  destroy(): void {
    this.conversationPreview.destroy();
  }

  beginRename(target: SidebarRenameTarget, onSubmit: (name: string) => void | Promise<void>): void {
    this.renameTarget = target;
    this.renameSubmitCallback = onSubmit;
  }

  cancelRename(): void {
    this.renameTarget = null;
    this.renameSubmitCallback = null;
  }

  async commitRename(name: string): Promise<void> {
    const submit = this.renameSubmitCallback;
    this.cancelRename();
    if (!submit) return;
    try {
      await submit(name);
    } catch (error) {
      console.error("Failed to rename ACP sidebar item", error);
    }
  }

  isRenamingWorkspace(kind: "project" | "worktree", path: string): boolean {
    return this.renameTarget?.kind === kind && this.renameTarget.path === path;
  }

  isRenamingConversation(conversationId: string): boolean {
    return this.renameTarget?.kind === "conversation" && this.renameTarget.id === conversationId;
  }

  get isLoading(): boolean {
    if (this.isSplitACPHost()) return false;
    return this.activeSession?.loadState.status === "loading";
  }

  getSessionAgentServer(session: { agentServer?: string }): string {
    return session.agentServer ?? DEFAULT_AGENT_SERVER;
  }

  getAgentName(agentServer: string): string {
    if (agentServer === DEFAULT_AGENT_SERVER) {
      return "Camber";
    }
    if (agentServer === LOCAL_AGENT_SERVER) {
      return "Camber Local";
    }
    return this.registry.getAgent(agentServer)?.name ?? agentServer;
  }

  // Brand tint for an agent's roundel in the row hover preview, reusing the
  // agent-picker palette (Camber / Camber Local purple, Claude orange).
  // Agents without a brand colour fall back to the neutral icon token.
  agentIconColorClass(agentServer: string): string {
    return agentPickerIconProps(this.registry, agentServer).class || "text-psx-icon";
  }

  agentPickerIconAppearance(agentServer: string): {
    iconUrl?: string;
    class: string;
    overlayIconUrl?: string;
    overlayClass?: string;
  } {
    return {
      iconUrl: agentPickerIconUrl(this.registry, agentServer),
      ...agentPickerIconProps(this.registry, agentServer),
    };
  }

  getAgentIconUrl(agentServer: string): string | undefined {
    return agentServerIconUrl(agentServer, this.registry.getAgent(agentServer));
  }

  getLiveStatus(sessionId: string, agentServer: string): SidebarLiveStatus {
    if (this.isSplitACPHost()) {
      return emptyLiveStatus;
    }
    return this.repo.getConversationStatus?.(sessionId, agentServer) ?? emptyLiveStatus;
  }

  reviewSessionKey(session: ACPConversationSummary): string {
    return `${this.getSessionAgentServer(session)}:${session.id}`;
  }

  rowState(session: ACPConversationSummary): ConversationRowState {
    // Navigation summaries cover unloaded conversations and may briefly lag a
    // handoff. Once a conversation is loaded, its routed live session is the
    // authoritative agent for every active UI surface.
    const agentServer =
      this.liveSessionFor(session)?.agentServer ?? this.getSessionAgentServer(session);
    const liveStatus = this.rowLiveStatus(session, agentServer);
    const selected =
      (this.isSplitACPHost()
        ? isLiveStatusActive(liveStatus)
        : this.isSelectedSession(session.sessionId, session.id, agentServer)) &&
      (this.options.isChatActive?.() ?? true);
    return {
      agentServer,
      agentName: this.getAgentName(agentServer),
      iconUrl: this.getAgentIconUrl(agentServer),
      working: liveStatus.working,
      waitingForUser: liveStatus.waitingForUser,
      unread: liveStatus.unread,
      selected,
      iconClass: this.iconClass(selected, liveStatus),
      titleClass: this.titleClass(liveStatus),
    };
  }

  isSelectedSession(
    sessionId: string | null,
    conversationId: string,
    agentServer: string,
  ): boolean {
    if (this.isSplitACPHost()) {
      return false;
    }
    const activeSession = this.activeSession;
    return (
      activeSession?.conversationId === conversationId && activeSession.agentServer === agentServer
    );
  }

  liveSessionFor(session: ACPConversationSummary): ACPSession | null {
    if (this.isSplitACPHost()) return null;
    return this.repo.getSessionByConversationId(session.id);
  }

  async newConversation(cwd?: string, event?: Event): Promise<string | null> {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.isLoading) return null;
    return (await this.options.onNewConversation(cwd)) ?? null;
  }

  async openSession(
    session: ACPConversationSummary,
    cwd?: string,
    openOptions: OpenSessionOptions = {},
  ): Promise<void> {
    const generation = ++this.openSessionGeneration;
    const agentServer = this.getSessionAgentServer(session);
    const sessionCwd = cwd ?? this.options.resolveSessionCwd?.(session) ?? session.cwd;
    const fallbackCwds = openOptions.fallbackCwds ?? [];

    this.options.onShowChat();
    if (this.isSplitACPHost()) {
      await rpc.openAcpChat({
        conversationId: session.id,
        agentServer,
        sessionId: session.sessionId ?? undefined,
        agentName: this.getAgentName(agentServer),
        agentIconUrl: this.getAgentIconUrl(agentServer),
        sessionTitle: session.title || "Untitled Conversation",
        cwd: sessionCwd,
        workingDirectories: cloneStringArray(session.workingDirectories),
        ...(openOptions.readOnly ? { readOnly: true } : {}),
        ...(fallbackCwds.length ? { fallbackCwds: Array.from(fallbackCwds) } : {}),
      });
      return;
    }

    if (!session.sessionId) {
      this.createSession(
        sessionCwd,
        agentServer,
        session.id,
        isACPChatConversation(session) ? { isChat: true } : {},
      );
      return;
    }

    const activeSession = this.conversations.getSession(session.sessionId, agentServer);
    let seedInfo: Partial<ACPResolvedSessionInfo> | undefined = activeSession
      ? { ...activeSession, sessionId: session.sessionId }
      : undefined;
    if (openOptions.readOnly) {
      // Archived conversations have no active nav record; seed from the
      // summary itself so the pane keys on the archived conversation id and
      // the existing read-only affordances (banner, disabled prompt) engage.
      seedInfo = {
        ...(seedInfo ?? { ...session, sessionId: session.sessionId }),
        conversationId: seedInfo?.conversationId ?? session.id,
        readOnly: true,
      };
    }
    const load = this.repo.loadSessionRecord(
      session.sessionId,
      sessionCwd,
      [],
      seedInfo,
      agentServer,
      {
        fallbackCwds,
        ...(openOptions.readOnly === true ? { readOnlyInspection: true } : {}),
        ...(isACPChatConversation(session) ? { isChat: true } : {}),
      },
    );
    this.options.setActiveConversationId?.(session.id);
    if (this.shouldMarkRead()) {
      this.repo.clearUnread(session.sessionId, agentServer);
      this.clearDescendantUnread(session.id);
    }
    const loadedSession = await load;
    // Native navigation (for example Cmd+N) can select another draft without
    // going through this controller or advancing its open-session generation.
    const stillSelected =
      !this.options.getActiveConversationId ||
      this.options.getActiveConversationId() === session.id;
    if (loadedSession && generation === this.openSessionGeneration && stillSelected) {
      this.options.setActiveConversationId?.(loadedSession.conversationId);
      if (loadedSession.sessionId && this.shouldMarkRead()) {
        this.repo.clearUnread(loadedSession.sessionId, loadedSession.agentServer);
        this.clearDescendantUnread(loadedSession.conversationId);
      }
    }
  }

  async loadSessionPreview(
    session: ACPConversationSummary,
    cwd: string,
    fallbackCwds: string[] = [],
  ): Promise<string> {
    if (!session.sessionId) return session.id;

    const agentServer = this.getSessionAgentServer(session);
    const activeSession = this.conversations.getSession(session.sessionId, agentServer);
    const seedInfo: Partial<ACPResolvedSessionInfo> = {
      ...(activeSession ?? session),
      sessionId: session.sessionId,
      conversationId: activeSession?.conversationId ?? session.id,
      readOnly: true,
    };
    const loadedSession = await this.repo.loadSessionRecord(
      session.sessionId,
      cwd,
      [],
      seedInfo,
      agentServer,
      {
        fallbackCwds,
        readOnlyInspection: true,
        ...(isACPChatConversation(session) ? { isChat: true } : {}),
      },
    );
    return loadedSession?.conversationId ?? seedInfo.conversationId ?? session.id;
  }

  createSession(
    cwd: string,
    agentServer: string,
    conversationId: string | null,
    options: { isChat?: boolean } = {},
  ): string {
    this.openSessionGeneration++;
    const created = this.repo.createSession(cwd, agentServer, conversationId, {
      ...options,
      isPendingConversationPersisted: conversationId !== null,
    }).conversationId;
    this.options.setActiveConversationId?.(created);
    return created;
  }

  canDeleteSession(session: ACPConversationSummary): boolean {
    if (!session.sessionId) return false;
    const agentServer = this.getSessionAgentServer(session);
    const capabilities = this.repo.agents.getInitializeResponse(agentServer)?.agentCapabilities;
    // Unknown capabilities mean the agent hasn't connected in this webview.
    // That's the steady state on split hosts (VS Code / VS), where the sidebar
    // never opens an agent connection of its own, and a startup race elsewhere.
    // Assume support instead of permanently disabling delete; an agent that
    // rejects session/delete surfaces the failure at call time.
    if (!capabilities) return true;
    return supportsSessionDelete(capabilities);
  }

  shouldInterruptSelectedSession(sessionId: string | null, agentServer: string): boolean {
    if (this.isSplitACPHost()) return false;
    const activeSession = this.activeSession;
    return Boolean(
      sessionId &&
        activeSession?.sessionId === sessionId &&
        activeSession.agentServer === agentServer &&
        (activeSession.isPrompting || activeSession.isSending),
    );
  }

  async cancelActiveSession(): Promise<void> {
    await this.activeSession?.cancel();
  }

  private iconClass(selected: boolean, _liveStatus: SidebarLiveStatus): string {
    // Waiting-for-user (elicitation / permission prompt) no longer tints the
    // row; it surfaces as an amber dot in the trailing column instead, mirroring
    // the blue completed/unread dot.
    return selected ? "" : "text-psx-foreground-secondary";
  }

  private titleClass(_liveStatus: SidebarLiveStatus): string {
    return "";
  }

  private rowLiveStatus(session: ACPConversationSummary, agentServer: string): SidebarLiveStatus {
    if (this.isSplitACPHost()) {
      return session.liveStatus ?? emptyLiveStatus;
    }

    // The helper-pushed liveStatus is the only signal for turns started on
    // ANOTHER surface (e.g. a phone remote prompting this conversation); the
    // local repository/session flags only cover turns started here. Unread is
    // helper-owned and shared: every surface reports the conversation it is
    // viewing (see conversationViewState.ts), the helper marks a completing
    // turn unread only when nobody watches, and reading the conversation on
    // ANY surface clears the dot everywhere. The local repository's unread
    // only backs OS notifications now, not the sidebar.
    const pushedStatus = session.liveStatus ?? emptyLiveStatus;
    const repositoryStatus = session.sessionId
      ? this.getLiveStatus(session.sessionId, agentServer)
      : emptyLiveStatus;
    const liveSession = this.liveSessionFor(session);

    return {
      working:
        pushedStatus.working ||
        repositoryStatus.working ||
        Boolean(liveSession && (liveSession.isPrompting || liveSession.isSending)),
      waitingForUser:
        pushedStatus.waitingForUser ||
        repositoryStatus.waitingForUser ||
        Boolean(liveSession && liveSession.pendingPermissionRequests.length > 0),
      unread: pushedStatus.unread,
    };
  }

  private isSplitACPHost(): boolean {
    return isSplitACPHost(currentACPHostState().environment.assistantHost);
  }

  private clearDescendantUnread(conversationId: string): void {
    this.repo.clearDescendantUnread(conversationId, this.conversations.sessions);
  }

  private shouldMarkRead(): boolean {
    return currentACPHostState().isEditorFocused === true;
  }

  private get activeSession(): ACPSession | null {
    return (
      this.options.getActiveSession?.() ??
      this.repo.getSessionByConversationId(this.options.getActiveConversationId?.() ?? null)
    );
  }
}

function cloneStringArray(value: readonly string[] | undefined): string[] | undefined {
  return value ? Array.from(value) : undefined;
}

function isLiveStatusActive(status: SidebarLiveStatus): boolean {
  return status.working || status.waitingForUser || status.unread;
}

const [getAcpSidebarControllerContext, setAcpSidebarControllerContext] =
  createContext<AcpSidebarController>();

export function setAcpSidebarController(
  options: AcpSidebarControllerOptions,
): AcpSidebarController {
  const controller = new AcpSidebarController(options);
  setAcpSidebarControllerContext(controller);
  return controller;
}

export function getAcpSidebarController(): AcpSidebarController {
  return getAcpSidebarControllerContext();
}
