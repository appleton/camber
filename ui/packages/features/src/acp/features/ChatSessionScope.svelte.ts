import type { ContentBlock } from "@agentclientprotocol/sdk";
import { waiting } from "@camber/lib/async-state";
import { createContext } from "svelte";
import { DEFAULT_AGENT_SERVER } from "../agentServers";
import { SessionEventsState, type ToolActivityMode } from "../components/SessionEventsState.svelte";
import type { ACPConversationSummary } from "../navTypes";
import { buildSubagentTranscriptIndex } from "../subagents";
import type { ACPConversationRepository } from "./ConversationRepository.svelte";
import {
  textPromptContent,
  type ACPQueuedPrompt,
  type ACPSession,
  type ACPSessionCancelOptions,
} from "./Session.svelte";
import type { ACPSessionRepository } from "./SessionRepository.svelte";
import type { ACPCollaborationModeSurface } from "./session/types";

type NoSetters<T> = { readonly [K in keyof T]: T[K] };

export type ACPChatSessionScope = NoSetters<ACPChatSessionScopeWriter>;

/**
 * Pane-scoped session facade.
 *
 * The parent owns the active conversation id; the chat subtree reads a single
 * resolved ACPSession through this scope instead of reaching into repository
 * selection. The scope is the chat subtree's active-session boundary.
 */
export class ACPChatSessionScopeWriter {
  constructor(
    private readonly repo: ACPSessionRepository,
    private readonly getActiveConversationId?: () => string | null,
    private readonly setActiveConversationId?: (conversationId: string | null) => void,
    private readonly conversations?: ACPConversationRepository | null,
    private readonly getToolActivity?: () => ToolActivityMode,
    private readonly useSubagentTranscriptTabs = false,
  ) {
    const scope = this;
    this.timelineState = new SessionEventsState({
      get events() {
        return scope.timelineEvents;
      },
      get turns() {
        return scope.timelineTurns;
      },
      get isPrompting() {
        return scope.isPrompting;
      },
      get toolActivity() {
        return scope.toolActivity;
      },
    });
  }

  // Grouped transcript rows.
  private readonly timelineState: SessionEventsState;
  private readonly subagentState = $derived.by(() => {
    const codexTurnActive = this.isPrompting || this.isSending || this.isRemoteWorking;
    return buildSubagentTranscriptIndex(this.events, this.turns, {
      codexTurnActive,
      codexActiveTurnStartIndex: codexTurnActive ? this.codexActiveTurnStartIndex : undefined,
    });
  });

  private get session(): ACPSession | null {
    const activeConversationId = this.getActiveConversationId?.() ?? null;
    return this.repo.getSessionByConversationId(activeConversationId);
  }

  get sessionId() {
    return this.session?.sessionId ?? null;
  }
  get conversationId() {
    return this.session?.conversationId ?? null;
  }
  get sessionAgentServer() {
    return this.session?.agentServer ?? null;
  }
  get activeAgentServer() {
    return this.session?.agentServer ?? this.repo.agents.defaultAgentServer ?? DEFAULT_AGENT_SERVER;
  }
  get selectedAgentServer() {
    return this.activeAgentServer;
  }
  get pendingConversationId() {
    return this.session?.pendingConversationId ?? null;
  }
  get pendingSessionCwd() {
    return this.session?.pendingCwd ?? null;
  }
  get isChat() {
    return this.session?.isChat ?? false;
  }
  get toolActivity(): ToolActivityMode | undefined {
    return this.isChat ? "compact" : this.getToolActivity?.();
  }
  get sessionInfo() {
    return this.session?.sessionInfo ?? null;
  }
  get hasSession() {
    return this.sessionId !== null;
  }
  get hasPendingHandoff() {
    return this.session?.pendingHandoff !== null && this.session?.pendingHandoff !== undefined;
  }
  get isPreparingSessionOptions() {
    const session = this.session;
    return session?.loadState.status === "loading" && session.events.length === 0;
  }
  get canChangeAgent() {
    const session = this.session;
    return (session?.sessionId ?? null) === null && !session?.isSending;
  }
  get canHandoff() {
    const session = this.session;
    return Boolean(
      session?.sessionId &&
        !session.isPromptActive &&
        !session.isSending &&
        !this.isRemoteWorking &&
        session.handoffTargetAgentServer === null &&
        session.queuedPrompts.length === 0 &&
        session.pendingPermissionRequests.length === 0 &&
        !this.activeConversationSummary?.liveStatus?.waitingForUser &&
        !session.sessionInfo?.readOnly,
    );
  }
  get handoffTargetAgentServer() {
    return this.session?.handoffTargetAgentServer ?? null;
  }
  get isConfigCacheLoading() {
    return this.repo.agents.isConfigCacheLoadingFor(this.activeAgentServer);
  }
  get sessionLoadState() {
    return this.session?.loadState ?? waiting;
  }
  get setupStatus() {
    return this.session?.setupStatus ?? null;
  }
  get activeWorkspaceCwd() {
    const session = this.session;
    if (session) return session.sessionInfo?.cwd ?? session.pendingCwd;
    return null;
  }
  get isSessionSetupPending() {
    return (
      this.sessionLoadState.status === "loading" ||
      this.isConfigCacheLoading ||
      this.repo.agents.authInProgressForAgent(this.activeAgentServer)
    );
  }
  get isPrompting() {
    return this.session?.isPromptActive ?? false;
  }
  get isSending() {
    return this.session?.isSending ?? false;
  }
  // A turn started on ANOTHER connected surface (phone prompting while the
  // desktop watches, or vice versa) is invisible to the local prompt
  // lifecycle: isPrompting only tracks prompts sent from this surface. The
  // helper marks the conversation working for the whole turn and broadcasts
  // it to every surface via camber/acpNav/didChange, so that pushed live
  // status is the only signal that a remote-origin turn is in flight.
  get isRemoteWorking() {
    if (this.isPrompting || this.isSending) return false;
    return Boolean(this.activeConversationSummary?.liveStatus?.working);
  }
  private get codexActiveTurnStartIndex(): number {
    if (this.isPrompting) {
      const sessionStartIndex = this.session?.activeTurnStartIndex;
      return sessionStartIndex ?? this.events.length;
    }
    if (this.isSending) return this.events.length;

    // A turn started from another surface does not pass through the local
    // prompt lifecycle. Its replayed user message is the best available
    // boundary, and normally arrives before the first subagent activity.
    const settledEndIndex = this.turns.reduce(
      (latest, turn) => Math.max(latest, turn.endIndex),
      -1,
    );
    for (let index = this.events.length - 1; index > settledEndIndex; index -= 1) {
      const event = this.events[index];
      if (event?.eventKind === "user_message" && !event.steer) return index;
    }
    return this.events.length;
  }
  private get activeConversationSummary(): ACPConversationSummary | null {
    const summaries = this.conversations?.sessions ?? [];
    const conversationId = this.getActiveConversationId?.() ?? this.session?.conversationId ?? null;
    if (conversationId) {
      const byId = summaries.find((summary) => summary.id === conversationId);
      if (byId) return byId;
    }
    const session = this.session;
    if (!session?.sessionId) return null;
    return (
      summaries.find(
        (summary) =>
          summary.sessionId === session.sessionId && summary.agentServer === session.agentServer,
      ) ?? null
    );
  }
  get isReadOnly() {
    return this.session?.sessionInfo?.readOnly ?? false;
  }
  get canEnqueuePrompt() {
    const session = this.session;
    return Boolean(session?.isPromptActive && !this.isReadOnly);
  }
  get canSteerPrompt() {
    const session = this.session;
    return Boolean(
      session?.isPromptActive &&
        !this.isReadOnly &&
        this.repo.agents.supportsSteering(session.agentServer),
    );
  }
  get events() {
    return this.session?.events ?? [];
  }
  get turns() {
    return this.session?.turns ?? [];
  }
  get subagents() {
    return this.subagentState;
  }
  get timelineEvents() {
    return this.useSubagentTranscriptTabs ? this.subagents.topLevelEvents : this.events;
  }
  get timelineTurns() {
    return this.useSubagentTranscriptTabs ? this.subagents.topLevelTurns : this.turns;
  }
  get timelineItems() {
    return this.timelineState.grouped;
  }
  // Tool expand/collapse choices; must reach the renderer alongside
  // timelineItems so pins feed the fold logic that produced them.
  get timelineExpansion() {
    return this.timelineState.expansion;
  }
  get plan() {
    return this.session?.plan ?? null;
  }
  get compacting() {
    return this.session?.compacting ?? false;
  }
  get queuedPrompt() {
    return this.session?.queuedPrompt ?? null;
  }
  get queuedPrompts() {
    return this.session?.queuedPrompts ?? [];
  }
  get promptError() {
    return this.session?.promptError ?? null;
  }
  get promptSuggestion() {
    return this.session?.promptSuggestion ?? null;
  }
  get goal() {
    return this.session?.goal ?? null;
  }
  get pendingGoalAction() {
    return this.session?.pendingGoalAction ?? null;
  }
  get goalActionError() {
    return this.session?.goalActionError ?? null;
  }
  // The agent accepted session/load for this conversation but replayed no
  // transcript, so it could not restore any history. Without this the pane
  // would render the conversation as a brand-new chat while the sidebar still
  // lists it with its title — the mismatch users report as "the chat is
  // empty".
  get historyUnavailable() {
    const session = this.session;
    if (!session?.restoredWithoutHistory) return false;
    return this.events.length === 0 && !this.isPrompting && !this.isSending;
  }
  get error() {
    const loadState = this.session?.loadState;
    return loadState?.status === "failure"
      ? loadState.error
      : this.repo.agents.nonSessionErrorFor(this.activeAgentServer);
  }
  get pendingPermissionRequests() {
    const session = this.session;
    if (!session) return [];
    // Include requests that arrived while this conversation had no live
    // session on this surface (broadcast prompts held unbound); opening the
    // conversation must surface them inline like any other approval.
    const unbound = session.sessionId
      ? this.repo.unboundPermissionRequestsFor(session.sessionId, session.agentServer)
      : [];
    return unbound.length
      ? [...session.pendingPermissionRequests, ...unbound]
      : session.pendingPermissionRequests;
  }
  get configOptions() {
    return this.session?.configOptions ?? [];
  }
  get availableCommands() {
    return this.session?.availableCommands ?? [];
  }
  get modeNameById(): Map<string, string> {
    return new Map(this.session?.availableModes.map((m) => [m.id, m.name]));
  }
  get isPlanModeActive() {
    return this.session?.isPlanModeActive ?? false;
  }
  get canTogglePlanMode() {
    return this.session?.canTogglePlanMode ?? false;
  }
  get planModeViaCollaboration() {
    return this.session?.planModeViaCollaboration ?? false;
  }
  get collaborationModeSurface(): ACPCollaborationModeSurface {
    return this.session?.collaborationModeSurface ?? "none";
  }
  get promptContentOptions() {
    // Resolve from the live connection when present, else the persisted config
    // cache — so capabilities are known even for a new conversation whose agent
    // has not connected yet (and pasted images aren't dropped at compose time).
    const capabilities = this.repo.agents.promptCapabilitiesFor(
      this.hasSession && this.sessionAgentServer ? this.sessionAgentServer : this.activeAgentServer,
    );
    return {
      supportsEmbeddedContext: capabilities?.embeddedContext === true,
      supportsImages: capabilities?.image === true,
    };
  }

  getInitializeResponse(agentServer: string) {
    return this.repo.agents.getInitializeResponse(agentServer);
  }

  pendingConfigOption(configId: string) {
    return this.session?.pendingConfigOption(configId) ?? null;
  }

  // Materialize the active draft into the sidebar once the user starts typing.
  ensureDraftPersisted(): void {
    this.session?.persistPendingConversation();
  }

  get promptFocusRequested() {
    return this.session?.promptFocusRequested ?? false;
  }

  consumePromptFocusRequest(): boolean {
    return this.session?.consumePromptFocusRequest() ?? false;
  }

  createSession(
    cwd: string,
    agentServer = this.activeAgentServer,
    conversationId: string | null = null,
    options: { isChat?: boolean } = {},
  ): string {
    const created = this.repo.createSession(
      cwd,
      agentServer,
      conversationId,
      options,
    ).conversationId;
    this.setActiveConversationId?.(created);
    return created;
  }

  enqueuePrompt(prompt: ACPQueuedPrompt): void {
    const session = this.session;
    if (!session) throw new Error("Cannot enqueue prompt");
    session.enqueuePrompt(prompt);
  }

  clearQueuedPrompt(id?: string): void {
    this.session?.clearQueuedPrompt(id);
  }

  prioritizeQueuedPrompt(id?: string): void {
    this.session?.prioritizeQueuedPrompt(id);
  }

  sendQueuedPrompt(id?: string): void {
    this.session?.sendQueuedPrompt(id);
  }

  async steerPrompt(
    text: string,
    content: ContentBlock[] = textPromptContent(text),
  ): Promise<void> {
    await this.session?.steerPrompt(text, content);
  }

  async steerQueuedPrompt(id?: string): Promise<void> {
    await this.session?.steerQueuedPrompt(id);
  }

  clearPromptSuggestion(): void {
    this.session?.clearPromptSuggestion();
  }

  async send(
    text: string,
    sandboxDefinitionId: string | undefined,
    newSessionMeta?: Record<string, unknown>,
    cwd = "",
    content: ContentBlock[] = textPromptContent(text),
  ): Promise<string | null> {
    const session = this.session;
    if (!session) throw new Error("Cannot send prompt without an active ACP session");
    const createdSessionId = await session.serialize((gen) =>
      session.sendCore(gen, text, sandboxDefinitionId, newSessionMeta, cwd, content),
    );
    return createdSessionId;
  }

  async cancel(options?: ACPSessionCancelOptions): Promise<void> {
    return this.session?.cancel(options);
  }

  async handoff(targetAgentServer: string): Promise<void> {
    const conversationId = this.conversationId;
    if (!conversationId) throw new Error("Cannot hand off without an active conversation");
    await this.repo.handoffSession(conversationId, targetAgentServer);
  }

  async retryLastPrompt(): Promise<void> {
    return this.session?.retryLastPrompt();
  }

  async retryAfterError(): Promise<void> {
    const session = this.session;
    if (!session) return;
    return session.retryAfterError();
  }

  async retryHistoryUnavailable(): Promise<void> {
    const session = this.session;
    if (!session?.sessionId) return;
    // An empty replay is session-specific. Reload only this live record so a
    // retry consumes the new replay without interrupting every conversation
    // that shares the agent server.
    await this.repo.reloadLiveSession(session.sessionId, session.agentServer);
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    return this.session?.setConfigOption(configId, value);
  }

  async setBooleanConfigOption(configId: string, value: boolean): Promise<void> {
    return this.session?.setBooleanConfigOption(configId, value);
  }

  async togglePlanMode(): Promise<void> {
    return this.session?.togglePlanMode();
  }

  async pauseGoal(): Promise<void> {
    return this.session?.pauseGoal();
  }

  async resumeGoal(): Promise<void> {
    return this.session?.resumeGoal();
  }

  async clearGoal(): Promise<void> {
    return this.session?.clearGoal();
  }
}

const [getACPChatSessionScope, setACPChatSessionScopeContext] =
  createContext<ACPChatSessionScope>();

export function getOptionalACPChatSessionScope(): ACPChatSessionScope | undefined {
  try {
    return getACPChatSessionScope();
  } catch {
    return undefined;
  }
}

export { getACPChatSessionScope };

export function setACPChatSessionScope(
  repo: ACPSessionRepository,
  getActiveConversationId?: () => string | null,
  setActiveConversationId?: (conversationId: string | null) => void,
  conversations?: ACPConversationRepository | null,
  getToolActivity?: () => ToolActivityMode,
  useSubagentTranscriptTabs = false,
): ACPChatSessionScopeWriter {
  const scope = new ACPChatSessionScopeWriter(
    repo,
    getActiveConversationId,
    setActiveConversationId,
    conversations,
    getToolActivity,
    useSubagentTranscriptTabs,
  );
  setACPChatSessionScopeContext(scope);
  return scope;
}
