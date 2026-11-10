import type { AgentCapabilities, SessionId } from "@agentclientprotocol/sdk";
import {
  camberAcpNavArchiveConversation,
  camberAcpNavDeleteConversation,
  camberAcpNavList,
  camberAcpNavRenameConversation,
  camberAcpNavRestoreConversation,
  camberAcpNavUpsertConversation,
  camberAcpRenameSession,
  camberAcpSessionClose,
  camberAcpSessionDelete,
} from "@camber/helperapi";
import { failure, fromPromise, success, waiting, type AsyncState } from "@camber/lib/async-state";
import { createContext } from "svelte";
import { DEFAULT_AGENT_SERVER, normalizeAgentServerName } from "../agentServers";
import { normalizeACPError, type ACPRequestError } from "../errors";
import {
  ACP_DESKTOP_CONVERSATIONS_EVENT,
  ACP_SESSION_CLOSE_EVENT,
  ACP_SESSION_DELETE_EVENT,
  conversationToNav,
  dedupeConversationSummaries,
  navToConversationSummary,
  newConversationID,
  pendingConversationSummary,
  type ACPClosedSession,
  type ACPConversationSummary,
  type ACPConversationsState,
  type ACPNavConversation,
  type ACPNavState,
} from "../navTypes";
import { titleFromPrompt } from "./session/content";

type NoSetters<T> = { readonly [K in keyof T]: T[K] };
type ACPDeletedSession = { sessionId: SessionId; agentServer: string };
interface ACPRefreshOptions {
  showLoading?: boolean;
}
export interface ACPAgentCapabilitiesSource {
  capabilitiesFor(agentServer: string): AgentCapabilities | null;
}

export type ACPConversationRepository = NoSetters<ACPConversationRepositoryWriter>;

export class ACPConversationRepositoryWriter {
  private titleOverrides = new Map<string, string>();
  private draftPromptPresence = new Map<string, boolean>();
  private hiddenSessions = new Set<string>();

  constructor(private readonly agents?: ACPAgentCapabilitiesSource) {}

  refreshState = $state<AsyncState<ACPConversationSummary[], ACPRequestError>>(waiting);
  deleteState = $state<AsyncState<ACPDeletedSession, ACPRequestError>>(waiting);
  emitter = new EventTarget();

  readonly sessions = $derived(
    this.refreshState.status === "success" ? this.refreshState.value : [],
  );

  async refresh({ showLoading = true }: ACPRefreshOptions = {}): Promise<void> {
    const result = await fromPromise(
      async () => {
        const state = await camberAcpNavList({});
        return this.conversationsFromNavState(state);
      },
      (state) => {
        if (!showLoading && state.status === "loading") return;
        this.refreshState = state;
      },
      { mapError: normalizeACPError },
    );

    if (result.status === "success") {
      this.emitState();
    }
  }

  async upsertConversation(
    workspacePath: string,
    session: ACPConversationSummary,
  ): Promise<ACPConversationSummary | undefined> {
    // Pending drafts should appear with the view switch, not after the helper
    // round trip. The response reconciles this preview by the same stable id.
    if (!session.sessionId) {
      this.setSessions(
        this.applySessionOverrides(dedupeConversationSummaries([...this.sessions, session])),
      );
    }
    const state = await camberAcpNavUpsertConversation({
      conversation: conversationToNav(workspacePath, session),
    });
    this.applyNavState(state);
    await this.persistPendingTitleOverride(workspacePath, session);
    return this.sessions.find((candidate) => candidate.id === session.id);
  }

  async restoreConversation(
    workspacePath: string,
    session: ACPConversationSummary,
  ): Promise<ACPConversationSummary | undefined> {
    this.applyNavState(
      await camberAcpNavRestoreConversation({
        conversation: conversationToNav(workspacePath, session),
      }),
    );
    return this.findRestoredSession(session);
  }

  async createPendingConversation(
    workspacePath: string,
    cwd: string,
    agentServer = DEFAULT_AGENT_SERVER,
    workingDirectories: string[] = [cwd || workspacePath].filter(Boolean),
  ): Promise<ACPConversationSummary> {
    agentServer = normalizeAgentServerName(agentServer);
    const session = pendingConversationSummary({
      id: newConversationID(),
      cwd: cwd || workspacePath,
      agentServer,
      workingDirectories,
    });
    try {
      return (await this.upsertConversation(workspacePath, session)) ?? session;
    } catch (error) {
      console.error("Failed to create pending ACP conversation", error);
      return session;
    }
  }

  getSession(
    sessionId: SessionId,
    agentServer = DEFAULT_AGENT_SERVER,
  ): ACPConversationSummary | undefined {
    agentServer = normalizeAgentServerName(agentServer);
    return this.sessions.find(
      (session) => session.sessionId === sessionId && session.agentServer === agentServer,
    );
  }

  updateSessionTitle(conversationId: string, title: string): void {
    this.titleOverrides.set(conversationId, title);
    this.setSessions(this.sessions.map((s) => (s.id === conversationId ? { ...s, title } : s)));
    const session = this.sessions.find((s) => s.id === conversationId);
    if (session) {
      void this.upsertConversation(session.workspacePath || session.cwd, { ...session, title });
    }
  }

  // Front-end-only preview of a draft's title from the text being composed, so the
  // sidebar row reads back what the user is typing. Rides the local titleOverrides
  // map (no backend write per keystroke; survives nav refreshes) and is overwritten
  // once the agent titles the session. Nicknames are explicit user labels and
  // always stay ahead of this preview.
  setDraftTitle(conversationId: string, text: string): void {
    const session = this.sessions.find((candidate) => candidate.id === conversationId);
    const draftPromptPresent = text.trim().length > 0;
    this.draftPromptPresence.set(conversationId, draftPromptPresent);
    if (session?.nickname) {
      if (session.draftPromptPresent === draftPromptPresent) return;
      this.setSessions(
        this.sessions.map((session) =>
          session.id === conversationId ? { ...session, draftPromptPresent } : session,
        ),
      );
      return;
    }
    const title = text.trim() ? titleFromPrompt(text) : "New conversation";
    this.titleOverrides.set(conversationId, title);
    if (!session) return;
    if (session.title === title && session.draftPromptPresent === draftPromptPresent) return;
    this.setSessions(
      this.sessions.map((session) =>
        session.id === conversationId && !session.nickname
          ? { ...session, title, draftPromptPresent }
          : session,
      ),
    );
  }

  setDraftPromptPresence(conversationId: string, draftPromptPresent: boolean): void {
    const session = this.sessions.find((candidate) => candidate.id === conversationId);
    this.draftPromptPresence.set(conversationId, draftPromptPresent);
    if (!session) return;
    if (session.draftPromptPresent === draftPromptPresent) return;
    this.setSessions(
      this.sessions.map((session) =>
        session.id === conversationId ? { ...session, draftPromptPresent } : session,
      ),
    );
  }

  // Advances a conversation's updatedAt to "now" when the user sends a prompt.
  // Optimistically patches the local list and persists through upsert so the
  // sidebar reorders/relabels by last user turn. No-ops for unknown ids (e.g.
  // a brand new session whose record was just created by upsertConversation).
  touchSession(conversationId: string): void {
    const session = this.sessions.find((s) => s.id === conversationId);
    if (!session) return;
    const updatedAt = new Date().toISOString();
    this.setSessions(this.sessions.map((s) => (s.id === conversationId ? { ...s, updatedAt } : s)));
    void this.upsertConversation(session.workspacePath || session.cwd, { ...session, updatedAt });
  }

  hideSession(conversationId: string): void {
    this.hiddenSessions.add(conversationId);
    this.setSessions(this.sessions.filter((s) => s.id !== conversationId));
  }

  showSession(conversationId: string): void {
    this.hiddenSessions.delete(conversationId);
  }

  async archiveSession(
    workspacePath: string,
    sessionId: SessionId | null,
    agentServer = DEFAULT_AGENT_SERVER,
    conversationId?: string,
  ): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    this.applyNavState(
      await camberAcpNavArchiveConversation({
        workspacePath,
        conversationId,
        agentServer,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
    if (sessionId) {
      // Release the agent-side session resources (helper no-ops for agents
      // that can't close or couldn't reopen). Restoring goes through the
      // normal session/resume / session/load path, so archive stays reversible.
      // Deliberate: closing cancels an in-flight turn, extending the existing
      // archive-cancels-the-selected-conversation behavior (DesktopSideBar)
      // to background rows — archiving means the user is done with the work.
      try {
        await camberAcpSessionClose({ agentServer, sessionId });
      } catch (e) {
        console.error("Failed to close ACP session on archive", e);
      }
    }
    this.emitClosedSession({ agentServer, sessionId, conversationId });
  }

  async archiveAgentServer(agentServer = DEFAULT_AGENT_SERVER): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    let sessions = this.sessions.filter((session) => session.agentServer === agentServer);
    try {
      const state = await camberAcpNavList({});
      sessions = this.conversationsFromNavState(state).filter(
        (session) => session.agentServer === agentServer,
      );
    } catch (error) {
      console.error("Failed to load ACP conversations for disabled agent", error);
    }
    if (sessions.length === 0) {
      return;
    }

    this.setSessions(this.sessions.filter((session) => session.agentServer !== agentServer));
    try {
      for (const session of sessions) {
        await this.archiveSession(
          session.cwd,
          session.sessionId,
          agentServer,
          session.sessionId ? undefined : session.id,
        );
      }
    } catch (error) {
      console.error("Failed to archive ACP conversations for disabled agent", error);
      await this.refresh({ showLoading: false });
    }
  }

  async deleteSession(sessionId: SessionId, agentServer = DEFAULT_AGENT_SERVER): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    const deleted = { sessionId, agentServer };

    this.setSessions(
      this.sessions.filter(
        (s) => !(s.sessionId === deleted.sessionId && s.agentServer === deleted.agentServer),
      ),
    );
    this.deleteState = success(deleted);
    this.emitter.dispatchEvent(new CustomEvent(ACP_SESSION_DELETE_EVENT, { detail: deleted }));
    this.emitClosedSession(deleted);

    try {
      await camberAcpNavDeleteConversation({ agentServer, sessionId });
      await camberAcpSessionDelete({ agentServer, sessionId });
    } catch (e) {
      this.deleteState = failure(normalizeACPError(e));
      console.error("Failed to delete ACP session", e);
    }
  }

  async deleteConversation(
    conversationId: string,
    sessionId: SessionId | null,
    agentServer = DEFAULT_AGENT_SERVER,
  ): Promise<void> {
    agentServer = normalizeAgentServerName(agentServer);
    this.setSessions(this.sessions.filter((s) => s.id !== conversationId));
    if (sessionId) {
      this.deleteState = success({ sessionId, agentServer });
      this.emitter.dispatchEvent(
        new CustomEvent(ACP_SESSION_DELETE_EVENT, { detail: { sessionId, agentServer } }),
      );
      this.emitClosedSession({ agentServer, sessionId, conversationId });
    }

    try {
      await camberAcpNavDeleteConversation({ conversationId });
      if (sessionId) {
        await camberAcpSessionDelete({ agentServer, sessionId });
      }
    } catch (e) {
      this.deleteState = failure(normalizeACPError(e));
      console.error("Failed to delete ACP conversation", e);
      await this.refresh({ showLoading: false });
    }
  }

  async renameConversation(
    conversationId: string,
    nickname: string,
  ): Promise<ACPConversationSummary | undefined> {
    const trimmed = nickname.trim();
    if (!conversationId || !trimmed) return undefined;
    const existing = this.sessions.find((session) => session.id === conversationId);
    const canRenameSession = Boolean(
      existing?.sessionId && supportsSessionRename(this.agents, existing.agentServer),
    );
    this.titleOverrides.delete(conversationId);
    this.setSessions(
      this.sessions.map((session) =>
        session.id === conversationId ? { ...session, title: trimmed, nickname: trimmed } : session,
      ),
    );
    try {
      this.applyNavState(
        await camberAcpNavRenameConversation({
          conversationId,
          nickname: trimmed,
          ...(canRenameSession ? { title: trimmed } : {}),
        }),
      );
    } catch (error) {
      await this.refresh({ showLoading: false });
      throw error;
    }

    const renamed = this.sessions.find((session) => session.id === conversationId);
    const sessionForACP = renamed ?? existing;
    if (sessionForACP?.sessionId && canRenameSession) {
      void camberAcpRenameSession({
        agentServer: sessionForACP.agentServer,
        sessionId: sessionForACP.sessionId,
        title: trimmed,
      }).catch((error) => {
        console.debug("ACP session rename failed", error);
      });
    }

    return renamed;
  }

  replaceConversations(conversations: ACPNavConversation[]): void {
    this.applyConversations(conversations);
  }

  async archivedConversations(): Promise<ACPNavConversation[]> {
    const state = await camberAcpNavList({});
    return (state.conversations ?? []).filter((conversation) => conversation.archived);
  }

  publicAPI(): ACPConversationRepository {
    return this as ACPConversationRepository;
  }

  applyNavState(state: ACPNavState): void {
    this.setSessions(this.conversationsFromNavState(state));
  }

  private applyConversations(conversations: ACPNavConversation[]): void {
    this.setSessions(this.conversationsFromNavConversations(conversations));
  }

  private conversationsFromNavState(state: ACPNavState): ACPConversationSummary[] {
    return this.conversationsFromNavConversations(state.conversations ?? []);
  }

  private conversationsFromNavConversations(
    conversations: ACPNavConversation[],
  ): ACPConversationSummary[] {
    return this.applySessionOverrides(
      dedupeConversationSummaries(
        conversations
          .filter((conversation) => conversation.active && !conversation.archived)
          .map((conversation) => navToConversationSummary(conversation)),
      ),
    );
  }

  private setSessions(sessions: ACPConversationSummary[]): void {
    this.refreshState = success(sessions);
    this.emitState();
  }

  private applySessionOverrides(sessions: ACPConversationSummary[]): ACPConversationSummary[] {
    return sessions
      .filter((session) => !this.hiddenSessions.has(session.id))
      .map((session) => {
        const title = this.titleOverrides.get(session.id);
        const draftPromptPresent = this.draftPromptPresence.get(session.id);
        const withDraftPromptPresence =
          draftPromptPresent === undefined ? session : { ...session, draftPromptPresent };
        return title && !session.nickname
          ? { ...withDraftPromptPresence, title }
          : withDraftPromptPresence;
      });
  }

  private emitState(): void {
    this.emitter.dispatchEvent(
      new CustomEvent<ACPConversationsState>(ACP_DESKTOP_CONVERSATIONS_EVENT, {
        detail: { sessions: this.sessions },
      }),
    );
  }

  private emitClosedSession(detail: ACPClosedSession): void {
    this.emitter.dispatchEvent(
      new CustomEvent<ACPClosedSession>(ACP_SESSION_CLOSE_EVENT, { detail }),
    );
  }

  private async persistPendingTitleOverride(
    workspacePath: string,
    session: ACPConversationSummary,
  ): Promise<void> {
    if (!session.sessionId) return;

    const title = this.titleOverrides.get(session.id);
    if (!title || session.title === title) return;

    const updatedSession =
      this.sessions.find(
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          candidate.agentServer === normalizeAgentServerName(session.agentServer),
      ) ?? session;

    this.applyNavState(
      await camberAcpNavUpsertConversation({
        conversation: conversationToNav(workspacePath, { ...updatedSession, title }),
      }),
    );
  }

  private findRestoredSession(session: ACPConversationSummary): ACPConversationSummary | undefined {
    const agentServer = normalizeAgentServerName(session.agentServer);
    if (session.sessionId) {
      return this.sessions.find(
        (candidate) =>
          candidate.sessionId === session.sessionId && candidate.agentServer === agentServer,
      );
    }
    return this.sessions.find(
      (candidate) => candidate.id === session.id && candidate.agentServer === agentServer,
    );
  }
}

function supportsSessionRename(
  agents: ACPAgentCapabilitiesSource | undefined,
  agentServer = DEFAULT_AGENT_SERVER,
): boolean {
  const capabilities = agents?.capabilitiesFor(agentServer);
  const sessionCapabilities = (
    capabilities as { sessionCapabilities?: Record<string, unknown> } | null
  )?.sessionCapabilities;
  const meta = (capabilities as { _meta?: Record<string, unknown> } | null)?._meta;
  return sessionCapabilities?.rename != null || meta?.rename_session === true;
}

const [getACPConversationContext, setACPConversationRepositoryContext] =
  createContext<ACPConversationRepository>();

export { getACPConversationContext };

export function setACPConversationContext(
  agents?: ACPAgentCapabilitiesSource,
): ACPConversationRepositoryWriter {
  const repo = new ACPConversationRepositoryWriter(agents);
  setACPConversationRepositoryContext(repo.publicAPI());
  return repo;
}

export { setACPConversationRepositoryContext as _setACPConversationContextForTests };

export function getACPConversationRepo(): ACPConversationRepository {
  return getACPConversationContext();
}
