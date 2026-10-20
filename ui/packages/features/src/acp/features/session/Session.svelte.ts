import type {
  AvailableCommand,
  ContentBlock,
  McpServer,
  Plan,
  SessionConfigOption,
  SessionId,
  SessionModeState,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { waiting, type AsyncState } from "@camber/lib/async-state";
import { DEFAULT_AGENT_SERVER, normalizeAgentServerName } from "../../agentServers";
import type { ACPPromptSuggestion } from "../../claudePromptSuggestions";
import { normalizeACPError, type ACPRequestError } from "../../errors";
import { controlCodexGoal, type ACPGoalState } from "../../goals";
import type { ACPResolvedSessionInfo } from "../../sessionInfo";
import { TurnMaterializer, type SessionEvent, type TurnMetadata } from "../../TurnMaterializer";
import { textPromptContent } from "./content";
import { CamberSessionExtensions } from "./extensions/CamberSessionExtensions.svelte";
import { ACPSessionConfig, type ACPSetConfigOptionOptions } from "./SessionConfig";
import { ACPSessionEvents } from "./SessionEvents";
import { ACPSessionLoader } from "./SessionLoader";
import {
  ACPSessionMetadata,
  EMPTY_ACP_SESSION_METADATA,
  type ACPSessionMetadataSnapshot,
} from "./SessionMetadata";
import { ACPSessionPrompting } from "./SessionPrompting";
import { ACPSessionQueue } from "./SessionQueue";
import { ACPSessionTitles } from "./SessionTitles";
import { ACPSessionTranscript } from "./SessionTranscript";
import { ACPSessionUsage, type ACPTokenUsage } from "./SessionUsage.svelte";
import type { ACPSteerOutcome } from "./steering";
import { isAcpTranscriptBatchingEnabled } from "./transcriptBatching";
import type {
  ACPCollaborationModeSurface,
  ACPGoalAction,
  ACPPendingConfigOption,
  ACPPendingHandoff,
  ACPPendingPermissionRequest,
  ACPPromptError,
  ACPQueuedPrompt,
  ACPSessionCancelOptions,
  ACPSessionEnvironment,
  ACPSessionLoadIntent,
  ACPSessionLoadState,
  ACPSessionSendCoreArgs,
} from "./types";

export class ACPSession {
  readonly env: ACPSessionEnvironment;

  sessionId = $state<SessionId | null>(null);
  agentServer = $state<string>(DEFAULT_AGENT_SERVER);
  cwd = $state<string>("");
  conversationId = $state<string>("");
  isChat = $state(false);
  isPendingConversationPersisted = false;
  // True only when this live record was created to inspect an archived
  // conversation. A later normal open (after restore) may then safely clear
  // the transient read-only flag without overriding agent-authored metadata
  // on genuinely read-only sessions.
  readOnlyInspection = false;

  materializer: TurnMaterializer = new TurnMaterializer();
  historicalEvents: SessionEvent[] = [];
  historicalTurns: TurnMetadata[] = [];
  historicalPlan: Plan | null = null;
  events = $state<SessionEvent[]>([]);
  turns = $state<TurnMetadata[]>([]);
  metadata = $state.raw<ACPSessionMetadataSnapshot>(EMPTY_ACP_SESSION_METADATA);
  plan = $state<Plan | null>(null);
  sessionInfo = $state.raw<ACPResolvedSessionInfo | null>(null);
  lastRemoteMessageId: string | null = null;
  ignoredMessageIds: Set<string> = new Set();

  configOptions = $state<SessionConfigOption[]>([]);
  availableCommands = $state<AvailableCommand[]>([]);
  modes = $state<SessionModeState | null>(null);
  pendingConfigOptions = $state.raw<Record<string, ACPPendingConfigOption>>({});
  // Options the user explicitly chose on this session, as opposed to values
  // inherited from the agent's config cache. A background config refresh
  // preserves these and lets everything else track the cache.
  userSelectedConfigIds = $state.raw<Set<string>>(new Set());
  userSelectedMode = $state(false);

  isPrompting = $state(false);
  isSending = $state(false);
  // The agent-side session was closed while idle (its subprocess released);
  // the transcript is still warm in memory. Reattach via session/resume before
  // the next wire interaction. See SessionRepository.closeIdleSessions.
  suspended = $state(false);
  // The in-flight session/close that suspended this session, if it has not
  // settled yet. Reattach awaits it so a resume cannot be overtaken and torn
  // down by a late-arriving close. Plain field: nothing renders it.
  pendingClose: Promise<void> | null = null;
  // A resume/reload is on the wire (refreshMCPServers). The idle sweep and
  // evictor treat this as protection so they cannot suspend or close the
  // session mid-resume. Plain field: consumed only by lifecycle checks.
  refreshInFlight = false;
  // This session's agent-side state was lost (the agent process restarted
  // under it, or a prompt hit a stale session): reload it before the next
  // wire interaction. Scoped per session, never per agent server — a session
  // created *after* the restart runs on the fresh process and has nothing to
  // reload. Agents that only materialize a transcript once a turn starts
  // (Codex writes its rollout then) fail session/load outright on such a
  // session, which used to swallow the user's very first prompt. Plain field:
  // consumed only by the loader.
  restoreRequired = false;
  // A connector refresh found this conversation mid-turn (locally or on
  // another surface) and was skipped or refused by the helper. The live pane
  // is left untouched and the refresh re-runs when the helper reports the
  // turn ended. Plain field: consumed only by lifecycle code.
  connectorRefreshDeferred = false;
  private deferredConnectorRefresh: Promise<void> | null = null;
  // While a connector-refresh reload is on the wire, live updates are routed
  // to the replay materializer like any load. If the helper then refuses the
  // reload (turn running), the loader puts these back on the live transcript
  // instead of discarding them with the replay. Plain field: loader-owned.
  connectorRefreshCapture: SessionNotification[] | null = null;
  // session/load restored this conversation and the agent replayed nothing at
  // all: its history is gone agent-side even though the sidebar still lists the
  // conversation. Surfaces read it so they stop presenting the conversation as
  // a fresh draft, and prompting reads it to decide that an unresumable-session
  // error is worth recovering from — there is no transcript left to lose.
  restoredWithoutHistory = $state(false);
  lastPromptInterrupted = $state(false);
  promptFocusRequested = $state(false);
  queuedPrompts = $state.raw<ACPQueuedPrompt[]>([]);
  steeringRequestsInFlight = $state(0);
  promptError = $state.raw<ACPPromptError | null>(null);
  promptSuggestion = $state.raw<ACPPromptSuggestion | null>(null);
  goal = $state.raw<ACPGoalState | null>(null);
  pendingGoalAction = $state<ACPGoalAction | null>(null);
  goalActionError = $state.raw<ACPRequestError | null>(null);
  pendingDraftSend = $state.raw<ACPQueuedPrompt | null>(null);
  pendingPermissionRequests = $state.raw<ACPPendingPermissionRequest[]>([]);
  handoffTargetAgentServer = $state<string | null>(null);
  pendingHandoff = $state.raw<ACPPendingHandoff | null>(null);

  generation = 0;
  queue = new ACPSessionQueue(() => this.generation);
  replayMaterializer: TurnMaterializer | null = null;
  replaySessionInfo: ACPResolvedSessionInfo | null = null;

  loadIntent = $state<ACPSessionLoadIntent | null>(null);
  loadState = $state<AsyncState<ACPSessionLoadState, ACPRequestError>>(waiting);
  loadingCwd = $state<string | null>(null);
  setupStatus = $state<string | null>(null);

  private readonly camberExtension = new CamberSessionExtensions();
  readonly extensions: { readonly camber: CamberSessionExtensions | null };
  prompting = new ACPSessionPrompting(this);
  config = new ACPSessionConfig(this);

  get queuedPrompt(): ACPQueuedPrompt | null {
    return this.queuedPrompts[0] ?? null;
  }

  get activeTurnStartIndex(): number | null {
    const localStartIndex = this.materializer.currentTurnStartIndex;
    return localStartIndex === null ? null : this.historicalEvents.length + localStartIndex;
  }

  get isSteering(): boolean {
    return this.steeringRequestsInFlight > 0;
  }

  get isPromptActive(): boolean {
    return this.isPrompting || this.isSteering;
  }
  loader = new ACPSessionLoader(this);
  transcript = new ACPSessionTranscript(this);
  titles = new ACPSessionTitles(this);
  sessionEvents = new ACPSessionEvents(this);
  metadataManager = new ACPSessionMetadata(this);
  usageState = new ACPSessionUsage();

  private transcriptFlushHandle: number | null = null;
  // Holds either the visible-cadence delay, the hidden-cadence delay, or the
  // fallback paired with a requested animation frame. requestAnimationFrame is
  // suspended while the webview is hidden or occluded, so the fallback keeps a
  // pending visible flush from freezing indefinitely.
  private transcriptFlushTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly TRANSCRIPT_FLUSH_FALLBACK_MS = 250;
  // Publish a visible stream at roughly 30 fps. Immutable Markdown segments
  // and uncached live tails now bound the work per publication, so this keeps
  // token arrival feeling immediate without returning to per-chunk updates.
  private static readonly VISIBLE_TRANSCRIPT_FLUSH_MS = 32;
  // Streaming-chunk flush cadence while no surface displays this conversation.
  // Nothing on screen reads the snapshot, so per-frame array copies and
  // metadata extraction are wasted; the slow interval keeps the sidebar's
  // persisted metadata roughly fresh without the per-frame cost.
  private static readonly HIDDEN_TRANSCRIPT_FLUSH_MS = 1000;
  // Plain field, not $state: it only steers flush scheduling, and reading it
  // inside publishTranscript must never create a reactive dependency.
  private transcriptVisible = true;

  constructor(opts: {
    env: ACPSessionEnvironment;
    sessionId: SessionId | null;
    agentServer: string;
    cwd?: string;
    conversationId: string;
    isChat?: boolean;
    isPendingConversationPersisted?: boolean;
  }) {
    this.env = opts.env;
    this.sessionId = opts.sessionId;
    this.agentServer = opts.agentServer;
    this.cwd = opts.cwd ?? "";
    this.conversationId = opts.conversationId;
    this.isChat = opts.isChat ?? false;
    this.isPendingConversationPersisted = opts.isPendingConversationPersisted ?? false;

    const session = this;
    this.extensions = {
      get camber() {
        return session.isCamberAgent() ? session.camberExtension : null;
      },
    };
  }

  private isCamberAgent(): boolean {
    return normalizeAgentServerName(this.agentServer) === DEFAULT_AGENT_SERVER;
  }

  get pendingConversationId(): string | null {
    return this.sessionId === null ? this.conversationId : null;
  }
  get pendingCwd(): string | null {
    return this.sessionId === null ? this.cwd : null;
  }
  get compacting(): boolean {
    return this.extensions.camber?.compacting ?? false;
  }
  get currentModeId(): string | null {
    return this.config.currentModeId;
  }
  get availableModes(): { id: string; name: string }[] {
    return this.config.availableModes;
  }
  get isPlanModeActive(): boolean {
    return this.config.isPlanModeActive;
  }
  get canTogglePlanMode(): boolean {
    return this.config.canTogglePlanMode;
  }
  get planModeViaCollaboration(): boolean {
    return this.config.planModeViaCollaboration;
  }
  get collaborationModeSurface(): ACPCollaborationModeSurface {
    return this.config.collaborationModeSurface;
  }

  get usage(): ACPTokenUsage {
    return this.usageState.value;
  }

  serialize<T>(fn: (gen: number) => Promise<T>): Promise<T> {
    return this.queue.serialize(fn);
  }

  enqueueConfigOption<T>(configId: string, fn: () => Promise<T>): Promise<T> {
    return this.queue.enqueueConfigOption(configId, fn);
  }

  nextConfigRequestId(): number {
    return this.queue.nextConfigRequestId();
  }

  addUserMessage(content: ContentBlock[] | string, options?: { steer?: boolean }): void {
    this.transcript.addUserMessage(content, options);
  }

  seedHandoffHistory(
    events: readonly SessionEvent[],
    turns: readonly TurnMetadata[],
    plan: Plan | null,
    handoff: Extract<SessionEvent, { eventKind: "handoff" }>,
  ): void {
    this.seedHistoricalHistory([...events, handoff], turns, plan);
  }

  seedHistoricalHistory(
    events: readonly SessionEvent[],
    turns: readonly TurnMetadata[],
    plan: Plan | null,
    { persistMetadata = true }: { persistMetadata?: boolean } = {},
  ): void {
    this.historicalEvents = [...events];
    this.historicalTurns = [...turns];
    this.historicalPlan = plan;
    this.cancelTranscriptFlush();
    this.flushTranscript(persistMetadata);
  }

  applyCachedConfig(): void {
    this.config.applyCached();
  }

  applyCachedConfigPreservingSelections(): void {
    this.config.applyCachedPreservingSelections();
  }

  resetTranscript(opts?: { preserveEvents?: boolean }): void {
    this.clearPromptSuggestion();
    this.goal = null;
    this.pendingGoalAction = null;
    this.goalActionError = null;
    this.transcript.reset(opts);
  }

  invalidateGeneration(): void {
    this.generation++;
    this.pendingGoalAction = null;
    this.goalActionError = null;
  }

  setPromptSuggestion(suggestion: ACPPromptSuggestion): void {
    this.promptSuggestion = suggestion;
  }

  clearPromptSuggestion(): void {
    this.promptSuggestion = null;
  }

  setGoal(goal: ACPGoalState | null): void {
    this.goal = goal;
    this.goalActionError = null;
  }

  pauseGoal(): Promise<void> {
    return this.runGoalAction("pause", async () => {
      const goal = this.goal;
      if (goal?.source !== "codex" || goal.controlMethod === undefined) {
        throw new Error("This agent does not support pausing goals from Camber.");
      }
      const connection = await this.goalConnection();
      await controlCodexGoal(connection, {
        sessionId: this.requiredGoalSessionId(),
        action: "pause",
      });
    });
  }

  resumeGoal(): Promise<void> {
    return this.runGoalAction("resume", async () => {
      if (this.goal?.source !== "codex" || this.goal.status !== "paused") {
        throw new Error("This goal cannot be resumed.");
      }
      await this.issueGoalCommand("/goal resume");
    });
  }

  clearGoal(): Promise<void> {
    return this.runGoalAction("clear", async () => {
      const goal = this.goal;
      if (!goal) return;
      if (goal.source === "codex" && goal.controlMethod !== undefined) {
        const connection = await this.goalConnection();
        await controlCodexGoal(connection, {
          sessionId: this.requiredGoalSessionId(),
          action: "clear",
        });
        return;
      }
      if (goal.source !== "claude") {
        throw new Error("This agent does not support clearing goals from Camber.");
      }
      await this.issueGoalCommand("/goal clear");
      this.setGoal(null);
    });
  }

  private async runGoalAction(action: ACPGoalAction, perform: () => Promise<void>): Promise<void> {
    if (this.pendingGoalAction !== null) return;
    const generation = this.generation;
    const sessionId = this.sessionId;
    if (sessionId === null) return;

    this.pendingGoalAction = action;
    this.goalActionError = null;
    try {
      await perform();
    } catch (error) {
      if (generation === this.generation && sessionId === this.sessionId) {
        this.goalActionError = normalizeACPError(error);
      }
      throw error;
    } finally {
      if (generation === this.generation && sessionId === this.sessionId) {
        this.pendingGoalAction = null;
      }
    }
  }

  private requiredGoalSessionId(): SessionId {
    if (this.sessionId === null) throw new Error("Cannot control a goal without a session.");
    return this.sessionId;
  }

  private async goalConnection() {
    await this.reattachIfSuspended();
    const connection =
      this.env.agents.connectionFor(this.agentServer) ??
      (await this.env.agents.activate(this.agentServer));
    if (!connection) throw new Error("Could not connect to the agent.");
    return connection;
  }

  private async issueGoalCommand(command: string): Promise<void> {
    if (this.promptError) {
      throw new Error("Resolve the current prompt error before changing the goal.");
    }
    if (this.isPromptActive && this.env.agents.supportsSteering(this.agentServer)) {
      // Any non-null outcome delivered the command: injected into the running
      // turn, or (at a turn boundary) sent as steer's ordinary-prompt
      // fallback, whose failure surfaces as a prompt error.
      const outcome = await this.steerPrompt(command);
      if (outcome === null) throw new Error("The agent could not apply the goal command.");
      const promptError = this.currentPromptError();
      if (promptError) throw promptError.error;
      return;
    }

    await this.prompt(command);
    const promptError = this.currentPromptError();
    if (promptError) throw promptError.error;
  }

  // Reading through a method prevents TypeScript from carrying the pre-await
  // null narrowing across the prompt, which may populate this reactive field.
  private currentPromptError(): ACPPromptError | null {
    return this.promptError;
  }

  prompt(text: string, content: ContentBlock[] = textPromptContent(text)): Promise<void> {
    return this.prompting.prompt(text, content);
  }

  retryLastPrompt(): Promise<void> {
    return this.prompting.retryLastPrompt();
  }

  retryAfterError(): Promise<void> {
    return this.prompting.retryAfterError();
  }

  loadExisting(
    gen: number,
    cwd: string,
    mcpServers: McpServer[],
    seedInfo?: Partial<ACPResolvedSessionInfo>,
    fallbackCwds: string[] = [],
  ): Promise<void> {
    return this.loader.loadExisting(gen, cwd, mcpServers, seedInfo, fallbackCwds);
  }

  async refreshMCPServers(
    gen: number,
    options: { trustRemoteStatus?: boolean } = {},
  ): Promise<boolean> {
    // Every resume path must let an in-flight suspending close settle first,
    // or the resume can be answered and then torn down by the late close.
    if (this.pendingClose) {
      await this.pendingClose;
      if (gen !== this.generation) return false;
    }
    // Flag the in-flight resume so the idle sweep / evictor cannot suspend or
    // close the session mid-resume — the inverse of the pendingClose barrier
    // above: that one orders resume after close, this one stops a new close
    // from starting while a resume is on the wire.
    this.refreshInFlight = true;
    try {
      const ok = await this.loader.refreshMCPServers(gen, options);
      // A successful resume/reload means the agent side is attached again, no
      // matter which flow triggered it (reattach, MCP-server refresh sweep).
      // Leaving `suspended` set here would make future idle sweeps and evicts
      // skip closing a session that is actually live.
      if (ok && gen === this.generation) {
        this.suspended = false;
      }
      return ok;
    } finally {
      this.refreshInFlight = false;
    }
  }

  /**
   * Reattach a suspended session, serialized so a prompt sent right after
   * queues behind the reattach instead of racing it.
   */
  reattachIfSuspended(): Promise<void> {
    if (!this.suspended) return Promise.resolve();
    return this.serialize(async (gen) => {
      await this.reattachSuspendedCore(gen);
    });
  }

  /**
   * Direct-call variant for code running inside `serialize` (promptCore —
   * calling reattachIfSuspended there would deadlock the queue) or on the
   * independent per-config queues (SessionConfig). Single-flight: concurrent
   * callers (claim-triggered reattach racing a config change) share one
   * resume instead of issuing overlapping ones. Reuses the resume-preferring
   * reconnect path, which keeps the warm transcript untouched and falls back
   * to session/load for older agents.
   */
  async reattachSuspendedCore(gen: number): Promise<boolean> {
    if (!this.suspended) return true;
    if (gen !== this.generation) return false;
    // refreshMCPServers awaits any in-flight suspending close and clears the
    // suspended flag on success.
    this.reattachInFlight ??= this.refreshMCPServers(gen).finally(() => {
      this.reattachInFlight = null;
    });
    return this.reattachInFlight;
  }

  private reattachInFlight: Promise<boolean> | null = null;

  enqueuePrompt(prompt: ACPQueuedPrompt): void {
    this.prompting.enqueue(prompt);
  }

  clearQueuedPrompt(id?: string): void {
    this.prompting.clearQueued(id);
  }

  prioritizeQueuedPrompt(id?: string): void {
    this.prompting.prioritizeQueued(id);
  }

  sendQueuedPrompt(id?: string): void {
    this.prompting.sendQueued(id);
  }

  steerPrompt(
    text: string,
    content: ContentBlock[] = textPromptContent(text),
  ): Promise<ACPSteerOutcome | null> {
    return this.prompting.steer(text, content);
  }

  steerQueuedPrompt(id?: string): Promise<ACPSteerOutcome | null> {
    return this.prompting.steerQueued(id);
  }

  cancel(options?: ACPSessionCancelOptions): Promise<void> {
    return this.prompting.cancel(options);
  }

  setMode(modeId: string): Promise<void> {
    return this.config.setMode(modeId);
  }

  setConfigOption(
    configId: string,
    value: string,
    options?: ACPSetConfigOptionOptions,
  ): Promise<void> {
    return this.config.setOption(configId, value, options);
  }

  setBooleanConfigOption(
    configId: string,
    value: boolean,
    options?: ACPSetConfigOptionOptions,
  ): Promise<void> {
    return this.config.setBooleanOption(configId, value, options);
  }

  togglePlanMode(): Promise<void> {
    return this.config.togglePlanMode();
  }

  pendingConfigOption(configId: string): ACPPendingConfigOption | null {
    return this.config.pendingOption(configId);
  }

  buildLoadState(): ACPSessionLoadState {
    return this.loader.buildLoadState();
  }

  applyReplayUpdate(params: SessionNotification): void {
    this.connectorRefreshCapture?.push(params);
    this.transcript.applyReplayUpdate(params);
  }

  applySessionUpdate(params: SessionNotification): void {
    this.transcript.applySessionUpdate(params);
  }

  dispatchPendingConversationAgentChange(): void {
    this.sessionEvents.dispatchPendingConversationAgentChange();
  }

  // Materialize a not-yet-started draft into the sidebar (as a pending
  // conversation) so it can be left and returned to. Called when the user first
  // types into the prompt. Once persisted, agent/workspace changes re-emit the
  // pending event, keeping the sidebar entry in sync (e.g. moving projects).
  persistPendingConversation(): void {
    if (
      this.sessionId !== null ||
      !this.conversationId ||
      this.isPendingConversationPersisted ||
      this.pendingHandoff !== null
    ) {
      return;
    }
    this.isPendingConversationPersisted = true;
    this.dispatchPendingConversationAgentChange();
  }

  // Flows that land the user in this conversation ready to type ("New
  // conversation", "Add project") request prompt focus here; the prompt
  // component consumes the request once its editor is mounted.
  requestPromptFocus(): void {
    this.promptFocusRequested = true;
  }

  consumePromptFocusRequest(): boolean {
    if (!this.promptFocusRequested) return false;
    this.promptFocusRequested = false;
    return true;
  }

  handleCompactionUpdate(
    params: Parameters<CamberSessionExtensions["handleCompactionUpdate"]>[0],
  ): void {
    this.extensions.camber?.handleCompactionUpdate(params);
  }

  handleTurnEnded(): void {
    this.extensions.camber?.endTurn();
    this.retryDeferredConnectorRefresh();
  }

  /**
   * Re-run a connector refresh deferred while this conversation was mid-turn.
   * Serialized so it queues behind a prompt whose turnEnded arrived before its
   * own completion; single-flight. The helper remains the authority: a turn
   * that started again meanwhile is refused and defers the refresh once more.
   */
  retryDeferredConnectorRefresh(): void {
    if (!this.connectorRefreshDeferred || this.suspended || this.deferredConnectorRefresh) {
      return;
    }
    this.deferredConnectorRefresh = this.serialize(async (gen) => {
      if (!this.connectorRefreshDeferred || this.suspended) return;
      await this.refreshMCPServers(gen, { trustRemoteStatus: false });
    }).finally(() => {
      this.deferredConnectorRefresh = null;
    });
  }

  sendCore(...args: ACPSessionSendCoreArgs): Promise<string | null> {
    return this.prompting.sendCore(...args);
  }

  /**
   * Publish the materializer snapshot into reactive state. Streaming chunk
   * updates pass { batched: true } to coalesce a burst into one animation
   * frame after a short visible cadence delay — or onto the slow hidden cadence
   * while no surface displays this conversation (see setTranscriptVisible);
   * every other caller publishes synchronously. Batching is a no-op
   * (synchronous) unless enabled at boot via enableAcpTranscriptBatching(), so
   * tests stay synchronous.
   */
  publishTranscript({ batched = false }: { batched?: boolean } = {}): void {
    if (
      !batched ||
      !isAcpTranscriptBatchingEnabled() ||
      typeof requestAnimationFrame === "undefined"
    ) {
      this.cancelTranscriptFlush();
      this.flushTranscript();
      return;
    }
    if (this.transcriptFlushHandle !== null || this.transcriptFlushTimeout !== null) {
      return; // already scheduled
    }
    if (!this.transcriptVisible) {
      this.transcriptFlushTimeout = setTimeout(
        () => this.runScheduledTranscriptFlush(),
        ACPSession.HIDDEN_TRANSCRIPT_FLUSH_MS,
      );
      return;
    }
    this.transcriptFlushTimeout = setTimeout(
      () => this.requestTranscriptFlushFrame(),
      ACPSession.VISIBLE_TRANSCRIPT_FLUSH_MS,
    );
  }

  private requestTranscriptFlushFrame(): void {
    this.transcriptFlushTimeout = null;
    this.transcriptFlushHandle = requestAnimationFrame(() => this.runScheduledTranscriptFlush());
    this.transcriptFlushTimeout = setTimeout(
      () => this.runScheduledTranscriptFlush(),
      ACPSession.TRANSCRIPT_FLUSH_FALLBACK_MS,
    );
  }

  /**
   * Switch this session's streaming flush cadence between the responsive
   * visible and slow hidden schedules. Turning visible publishes any pending
   * hidden-cadence flush immediately, so the transcript is current the moment
   * the conversation appears on screen. Turning hidden reschedules a pending
   * visible update onto the slow cadence instead of letting it repaint an
   * occluded transcript.
   */
  setTranscriptVisible(visible: boolean): void {
    if (this.transcriptVisible === visible) return;
    this.transcriptVisible = visible;
    if (this.transcriptFlushHandle === null && this.transcriptFlushTimeout === null) return;
    if (visible) {
      this.runScheduledTranscriptFlush();
      return;
    }
    this.cancelTranscriptFlush();
    this.transcriptFlushTimeout = setTimeout(
      () => this.runScheduledTranscriptFlush(),
      ACPSession.HIDDEN_TRANSCRIPT_FLUSH_MS,
    );
  }

  private runScheduledTranscriptFlush(): void {
    // Whichever of the rAF / timer fired first; cancel the other, then flush.
    this.cancelTranscriptFlush();
    this.flushTranscript();
  }

  cancelTranscriptFlush(): void {
    if (this.transcriptFlushHandle !== null) {
      if (typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(this.transcriptFlushHandle);
      }
      this.transcriptFlushHandle = null;
    }
    if (this.transcriptFlushTimeout !== null) {
      clearTimeout(this.transcriptFlushTimeout);
      this.transcriptFlushTimeout = null;
    }
  }

  private flushTranscript(persistMetadata = true): void {
    const historicalEventCount = this.historicalEvents.length;
    this.events = [...this.historicalEvents, ...this.materializer.events];
    this.turns = [
      ...this.historicalTurns,
      ...this.materializer.turns
        .filter((turn) => turn.endIndex >= turn.startIndex)
        .map((turn) => ({
          ...turn,
          startIndex: turn.startIndex + historicalEventCount,
          endIndex: turn.endIndex + historicalEventCount,
        })),
    ];
    this.plan = this.materializer.plan ?? this.historicalPlan;
    this.metadataManager.refresh({ persist: persistMetadata });
  }
}
