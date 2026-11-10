import type {
  ContentBlock,
  McpServer,
  SessionConfigOption,
  SessionId,
} from "@agentclientprotocol/sdk";
import {
  camberAcpNavAbortConversationHandoff,
  camberAcpNavGetProjectSettings,
  camberAcpNavPrepareConversationHandoff,
} from "@camber/helperapi";
import { failure, loading, success, waiting } from "@camber/lib/async-state";
import { get } from "svelte/store";
import {
  withClaudeAppendSystemPrompt,
  withClaudeSessionFeatures,
} from "../../claudePromptSuggestions";
import { normalizeACPError } from "../../errors";
import { parseClaudeGoalCommand, type ACPGoalState } from "../../goals";
import { appState, appStateUpdates } from "../../hostAdapter";
import { mergeLocalInferenceModelConfigOptionDefinitionsForAgent } from "../../localInferenceModelOptions";
import { buildSessionInfo } from "../../sessionInfo";
import {
  ACP_IDE_WORKSPACE_PATH,
  acpSessionWorkspacePath,
  acpWorkingDirectories,
  acpWorkspaceFolders,
} from "../../workspaceScope";
import type { ACPSession } from "./Session.svelte";
import {
  applySessionConfigSelections,
  currentConfigSelections,
  mergeConfigSelections,
} from "./configOptions";
import { textPromptContent, titleFromPrompt } from "./content";
import { isAuthRequiredError, isStaleSessionError, isUnresumableSessionError } from "./errors";
import { hostContextBlock } from "./hostContext";
import { ACP_STEER_FALLBACK_META_KEY, steerSession, type ACPSteerOutcome } from "./steering";
import type { ACPQueuedPrompt, ACPSessionCancelOptions } from "./types";
import {
  ACP_SESSION_NEW_EVENT,
  ACP_SESSION_TURN_COMPLETED_EVENT,
  ACP_SESSION_TURN_EVENT,
} from "./types";

type AgentSessionConfigOptions = {
  configOptions: SessionConfigOption[];
  reportedConfigOptions: SessionConfigOption[];
};

export class ACPSessionPrompting {
  private queuedPromptSequence = 0;
  private queuedSendScheduled = false;

  constructor(private readonly session: ACPSession) {}

  get hasQueuedSendPending(): boolean {
    return this.queuedSendScheduled || this.session.queuedPrompts.length > 0;
  }

  async prompt(text: string, content: ContentBlock[] = textPromptContent(text)): Promise<void> {
    if (this.session.sessionId === null) return;
    await this.session.serialize((gen) => this.promptCore(gen, text, content));
  }

  async retryLastPrompt(): Promise<void> {
    if (this.session.sessionId === null) return;
    const prompt = this.session.promptError?.prompt;
    if (!prompt) return;
    const content = this.session.promptError?.content ?? textPromptContent(prompt);
    this.session.promptError = null;
    this.session.restoreRequired = true;
    await this.session.env.agents.restart(this.session.agentServer);
    await this.session.serialize((gen) =>
      this.promptCore(gen, prompt, content, { addUserMessage: false }),
    );
  }

  async retryAfterError(): Promise<void> {
    const s = this.session;
    s.env.agents.clearNonSessionError(s.agentServer);
    s.promptError = null;
    if (s.loadState.status === "failure") {
      s.loadState = waiting;
      s.loadIntent = null;
    }

    const pendingDraftSend = s.pendingDraftSend;
    await s.env.agents.restart(s.agentServer);
    return s.serialize(async (gen) => {
      if (gen !== s.generation) return;
      const conn = await s.env.agents.activate(s.agentServer);
      if (gen !== s.generation || !conn) return;
      if (s.sessionId !== null) {
        // The restart above took this session's agent-side state with it, so
        // reload it here rather than waiting for the agent's exit notification
        // to mark it — that races this retry and would make the reload a no-op.
        s.restoreRequired = true;
        await s.loader.restoreAfterReconnect(gen, conn);
        return;
      }
      if (pendingDraftSend) {
        s.pendingDraftSend = null;
        await this.sendCore(
          gen,
          pendingDraftSend.text,
          pendingDraftSend.sandboxDefinitionId,
          pendingDraftSend.newSessionMeta,
          pendingDraftSend.cwd,
          pendingDraftSend.content,
          { skipOptimisticUserMessage: true },
        );
      }
    });
  }

  async send(
    text: string,
    sandboxDefinitionId: string | undefined,
    newSessionMeta?: Record<string, unknown>,
    cwd = "",
    content: ContentBlock[] = textPromptContent(text),
  ): Promise<string | null> {
    return this.session.serialize((gen) =>
      this.sendCore(gen, text, sandboxDefinitionId, newSessionMeta, cwd, content),
    );
  }

  enqueue(prompt: ACPQueuedPrompt): void {
    if (this.session.isPromptActive && !this.session.sessionInfo?.readOnly) {
      this.session.clearPromptSuggestion();
      this.session.queuedPrompts = [
        ...this.session.queuedPrompts,
        {
          ...prompt,
          id: prompt.id ?? `queued-prompt-${++this.queuedPromptSequence}`,
        },
      ];
      return;
    }
    throw new Error("Cannot enqueue prompt");
  }

  clearQueued(id?: string): void {
    if (id === undefined) {
      this.session.queuedPrompts = this.session.queuedPrompts.slice(1);
      return;
    }
    this.session.queuedPrompts = this.session.queuedPrompts.filter((prompt) => prompt.id !== id);
  }

  prioritizeQueued(id?: string): void {
    if (id === undefined) return;
    const index = this.session.queuedPrompts.findIndex((prompt) => prompt.id === id);
    if (index <= 0) return;
    const queued = this.session.queuedPrompts[index];
    this.session.queuedPrompts = [
      queued,
      ...this.session.queuedPrompts.filter((_, i) => i !== index),
    ];
  }

  sendQueued(id?: string): void {
    const s = this.session;
    if (s.isPromptActive || s.isSending || s.sessionInfo?.readOnly) {
      throw new Error("Cannot send queued prompt while the session is busy");
    }
    this.prioritizeQueued(id);
    this.sendQueuedPromptAfterCurrentTurn();
  }

  async steer(
    text: string,
    content: ContentBlock[] = textPromptContent(text),
  ): Promise<ACPSteerOutcome | null> {
    const s = this.session;
    if (s.sessionId === null || !s.isPromptActive || s.sessionInfo?.readOnly) return null;
    const generation = s.generation;
    const sessionId = s.sessionId;
    const agentServer = s.agentServer;
    const conn =
      s.env.agents.connectionFor(agentServer) ?? (await s.env.agents.activate(agentServer));
    if (!conn || s.generation !== generation || s.sessionId !== sessionId) return null;
    const transport = s.env.agents.steeringTransport(agentServer);
    if (!transport) return null;

    s.promptError = null;
    s.env.agents.clearNonSessionError(agentServer);
    s.addUserMessage(content, { steer: true });
    s.steeringRequestsInFlight += 1;
    s.env.publishLiveStatuses();
    let outcome: ACPSteerOutcome | null = null;
    try {
      const response = await steerSession(conn, { sessionId, prompt: content });
      if (s.generation !== generation || s.sessionId !== sessionId) return null;
      if (response.outcome === "failed") {
        throw new Error("The agent could not apply the steering prompt.");
      }
      if (
        response.outcome === "injected" ||
        response.outcome === "promptRequired" ||
        response.outcome === "startedNewTurn"
      ) {
        outcome = response.outcome;
      } else {
        throw new Error(`The agent returned an unknown steering result (${response.outcome}).`);
      }
    } catch (e) {
      if (s.generation !== generation || s.sessionId !== sessionId) return null;
      s.promptError = {
        error: normalizeACPError(e),
        prompt: text,
        content,
      };
      return null;
    } finally {
      if (s.generation === generation && s.sessionId === sessionId) {
        s.steeringRequestsInFlight = Math.max(0, s.steeringRequestsInFlight - 1);
        s.env.publishLiveStatuses();
        // A steer acknowledgement only confirms injection, but it can be the
        // last busy operation to settle if the prompt response raced it.
        // Whichever of promptCore or this request makes the session idle owns
        // advancing the ordinary queue; the active-state guard makes this safe
        // in either order. A promptRequired fallback owns the queue itself —
        // advancing here would let a queued prompt jump ahead of the steered
        // message.
        if (outcome !== "promptRequired") {
          this.sendQueuedPromptAfterCurrentTurn();
        }
      }
    }
    if (outcome === "promptRequired") {
      // The turn had already ended when the steer landed, and the agent left
      // the message undelivered. Send it as an ordinary prompt: the transcript
      // already shows it (addUserMessage above), and steerFallback tells the
      // helper it was already mirrored to the other surfaces at steer time.
      const delivered = await s.serialize((gen) =>
        this.promptCore(gen, text, content, { addUserMessage: false, steerFallback: true }),
      );
      // The fallback bails without a trace when the agent exits or cannot be
      // reactivated before it runs, yet the transcript already shows the
      // message as sent. Leave a retryable prompt error behind so the message
      // is not silently lost — unless the session was rebound meanwhile or
      // the bail recorded an error of its own.
      if (!delivered && s.sessionId === sessionId && s.promptError === null) {
        s.promptError = {
          error: normalizeACPError(
            new Error("The agent stopped before the message could be sent. Try again."),
          ),
          prompt: text,
          content,
        };
      }
    }
    return outcome;
  }

  async steerQueued(id?: string): Promise<ACPSteerOutcome | null> {
    const index =
      id === undefined ? 0 : this.session.queuedPrompts.findIndex((prompt) => prompt.id === id);
    const queued = index >= 0 ? this.session.queuedPrompts[index] : undefined;
    if (!queued) return null;
    // Clear first so the current turn's completion cannot race the extension
    // response and send the same queued prompt as a second, ordinary turn.
    this.session.queuedPrompts = this.session.queuedPrompts.filter((_, i) => i !== index);
    return this.steer(queued.text, queued.content);
  }

  async cancel({ sendQueuedPrompt = false }: ACPSessionCancelOptions = {}): Promise<void> {
    const s = this.session;
    if (s.sessionId === null) return;
    const sessionId = s.sessionId;
    const agentServer = s.agentServer;
    if (!sendQueuedPrompt) s.queuedPrompts = [];
    s.titles.finalizeInlineTitle(s.materializer);
    s.materializer.resetContinuation();
    s.materializer.cancelOpenToolCalls(new Date());
    s.publishTranscript();
    s.env.cancelPendingPermissionRequestsForSession(sessionId, agentServer);
    s.isPrompting = false;
    s.isSending = false;
    s.lastPromptInterrupted = true;
    s.env.publishLiveStatuses();
    try {
      const conn =
        s.env.agents.connectionFor(agentServer) ?? (await s.env.agents.activate(agentServer));
      if (!conn) return;
      await conn.cancel({ sessionId });
    } finally {
      if (sendQueuedPrompt) this.sendQueuedPromptAfterCurrentTurn();
    }
  }

  // Resolves true when the message reached the agent or was recorded for
  // retry (promptError, or a restarted session's draft), false when it was
  // abandoned because the session state moved on first — an agent exit or
  // rebind between enqueueing this call and running it. Callers that own a
  // message with no other trace (steer's promptRequired fallback) use false
  // to leave their own retryable error instead of losing it silently.
  async promptCore(
    gen: number,
    text: string,
    content: ContentBlock[],
    {
      addUserMessage = true,
      retryStaleSession = true,
      steerFallback = false,
    }: { addUserMessage?: boolean; retryStaleSession?: boolean; steerFallback?: boolean } = {},
  ): Promise<boolean> {
    const s = this.session;
    if (gen !== s.generation || s.sessionId === null) return false;
    s.clearPromptSuggestion();
    const sessionId = s.sessionId;
    const agentServer = s.agentServer;
    // A failed prompt's content never reached the agent (retryLastPrompt
    // resends it on the same assumption), and it already shows as a user
    // message in the transcript. Fold it into this prompt so typing a new
    // message after the error — instead of pressing retry — does not silently
    // drop the original message.
    const failedPrompt = s.promptError;
    const outgoingText = failedPrompt ? `${failedPrompt.prompt}\n\n${text}` : text;
    const outgoingContent = failedPrompt
      ? [...(failedPrompt.content ?? textPromptContent(failedPrompt.prompt)), ...content]
      : content;
    const standaloneClaudeSlashCommand =
      s.env.isClaudeAgent(agentServer) && isStandaloneSlashCommand(outgoingText, outgoingContent);
    const claudeGoalCommand = standaloneClaudeSlashCommand
      ? parseClaudeGoalCommand(outgoingText)
      : null;
    const hadClaudeGoal = s.goal?.source === "claude";
    let fallbackGoal: ACPGoalState | null = null;

    const conn = await s.env.agents.activate(agentServer);
    if (gen !== s.generation || !conn) return false;
    if (!(await s.loader.restoreAfterReconnect(gen, conn))) return false;
    // A suspended session's agent-side resources were closed while idle;
    // reattach before prompting. On failure surface a retryable prompt error —
    // returning silently would drop the user's typed message.
    if (!(await s.reattachSuspendedCore(gen))) {
      if (gen === s.generation) {
        s.promptError = {
          error: normalizeACPError(new Error("Could not reconnect the session. Try again.")),
          prompt: outgoingText,
          content: outgoingContent,
        };
        return true;
      }
      return false;
    }
    if (gen !== s.generation) return false;

    // Transcript size before this turn adds anything: an unresumable-session
    // failure is only recoverable by starting over when there is nothing to
    // start over from, and an agent may deliver a late replay after its load
    // settled — which would make restoredWithoutHistory alone stale.
    const eventsBeforeTurn = s.events.length;
    const turnStartedAt = new Date();
    s.isPrompting = true;
    s.promptError = null;
    s.lastPromptInterrupted = false;
    s.env.agents.clearNonSessionError(agentServer);
    s.env.publishLiveStatuses();
    this.emitSessionTurn();
    let delivered = true;
    try {
      s.materializer.startTurn(turnStartedAt);
      if (addUserMessage) {
        s.addUserMessage(content);
      } else {
        s.materializer.resetContinuation();
      }
      if (claudeGoalCommand?.action === "set") {
        fallbackGoal = {
          source: "claude",
          objective: claudeGoalCommand.objective,
          status: "active",
        };
        s.setGoal(fallbackGoal);
      }
      const res = await conn.prompt({
        sessionId,
        prompt: outgoingContent,
        ...(steerFallback ? { _meta: { [ACP_STEER_FALLBACK_META_KEY]: true } } : {}),
      });
      if (gen !== s.generation) return true;
      s.titles.finalizeInlineTitle(s.materializer);
      if (res?.stopReason === "cancelled") {
        s.lastPromptInterrupted = true;
        s.materializer.cancelOpenToolCalls(new Date());
        s.publishTranscript();
      } else {
        s.materializer.completeOpenToolCalls(new Date());
        s.publishTranscript();
        s.restoredWithoutHistory = false;
        if (s.queuedPrompts.length === 0) {
          s.env.markUnread(sessionId, agentServer);
          this.emitSessionTurnCompleted(sessionId, agentServer);
        }
        if (
          claudeGoalCommand?.action === "clear" ||
          claudeGoalCommand?.action === "set" ||
          (hadClaudeGoal && !standaloneClaudeSlashCommand)
        ) {
          s.setGoal(null);
        }
      }
    } catch (e) {
      const err = normalizeACPError(e);
      if (gen !== s.generation) return true;
      if (isAuthRequiredError(err)) {
        s.env.agents.markAuthRequired(agentServer);
        s.env.agents.clearNonSessionError(agentServer);
      } else if (
        s.restoredWithoutHistory &&
        eventsBeforeTurn === 0 &&
        isUnresumableSessionError(err)
      ) {
        await this.restartOnUnresumableSession(gen, outgoingText, outgoingContent);
      } else if (retryStaleSession && isStaleSessionError(err)) {
        s.restoreRequired = true;
        if (await s.loader.restoreAfterReconnect(gen, conn)) {
          delivered = await this.promptCore(gen, outgoingText, outgoingContent, {
            addUserMessage: false,
            retryStaleSession: false,
            steerFallback,
          });
        } else {
          if (gen !== s.generation) return false;
          s.promptError = { error: err, prompt: outgoingText, content: outgoingContent };
        }
      } else {
        s.promptError = { error: err, prompt: outgoingText, content: outgoingContent };
      }
      if (fallbackGoal !== null && s.promptError !== null && s.goal === fallbackGoal) {
        s.setGoal(null);
      }
    } finally {
      if (gen === s.generation) {
        // Agents do not currently emit a terminal compaction phase when the
        // summarizer fails or the turn is cancelled. Never let that transient
        // state survive the turn and keep the conversation permanently active.
        s.extensions.camber?.endTurn();
        // Flush any batched streaming events synchronously so the transcript is
        // current the instant isPrompting flips. The success/cancel branches
        // already do this; without it the error path would show idle/error one
        // frame before the last streamed events land.
        s.titles.finalizeInlineTitle(s.materializer);
        s.publishTranscript();
      }
      s.isPrompting = false;
      s.isSending = false;
      s.env.publishLiveStatuses();
      if (gen === s.generation) {
        this.sendQueuedPromptAfterCurrentTurn();
      }
    }
    return delivered;
  }

  // Recovers a conversation whose agent-side session cannot be prompted again
  // (see isUnresumableSessionError). Only reached when the restore replayed no
  // transcript, so nothing is thrown away: the dead session id is dropped and
  // the same nav conversation is rebound to a fresh session — the helper
  // rebinds it from the `camber/conversation_id` meta that sendCore sends —
  // keeping the sidebar entry and this conversation's config selections, and
  // letting the user's message land instead of dead-ending on an error that
  // would fail identically forever.
  private async restartOnUnresumableSession(
    gen: number,
    text: string,
    content: ContentBlock[],
  ): Promise<void> {
    const s = this.session;
    if (gen !== s.generation) return;
    console.warn("acp: agent could not resume this session; starting a fresh one", {
      agentServer: s.agentServer,
      sessionId: s.sessionId,
      conversationId: s.conversationId,
    });
    const cwd = s.sessionInfo?.cwd || s.cwd || "";
    // The conversation's title was derived from the prompt whose history is
    // gone, so it is the only trace of it the user has left. Carry it over
    // instead of letting the new session retitle the conversation (an absent
    // title would be stored as "Untitled Conversation").
    const existingTitle = s.sessionInfo?.title?.trim() || undefined;
    s.sessionId = null;
    s.sessionInfo = null;
    s.restoreRequired = false;
    s.restoredWithoutHistory = false;
    s.promptError = null;
    // The transcript already shows this prompt as a user message; the new
    // session must not add a second copy.
    await this.sendCore(gen, text, undefined, undefined, cwd, content, {
      skipOptimisticUserMessage: true,
      initialTitle: existingTitle,
    });
  }

  async sendCore(
    gen: number,
    text: string,
    sandboxDefinitionId: string | undefined,
    newSessionMeta?: Record<string, unknown>,
    cwd = "",
    content: ContentBlock[] = textPromptContent(text),
    options: {
      skipOptimisticUserMessage?: boolean;
      initialTitle?: string | null;
      preserveAgentToolDefaults?: boolean;
    } = {},
  ): Promise<string | null> {
    const s = this.session;
    if (gen !== s.generation) return null;

    s.clearPromptSuggestion();
    s.isSending = true;
    s.env.publishLiveStatuses();
    let preparedHandoffId: string | null = null;
    let handoffCommitted = false;
    try {
      const startedWithoutSessionId = s.sessionId === null;
      const pendingHandoff = startedWithoutSessionId ? s.pendingHandoff : null;
      // A draft whose earlier send failed before a session existed already
      // shows as a user message in the transcript. Fold it into this send so
      // prompting again after a first-turn error does not silently drop the
      // original message (retryAfterError consumes the draft itself and passes
      // skipOptimisticUserMessage, so it never merges here).
      const failedDraft =
        startedWithoutSessionId && !options.skipOptimisticUserMessage ? s.pendingDraftSend : null;
      const sendText = failedDraft ? `${failedDraft.text}\n\n${text}` : text;
      const sendContent = failedDraft ? [...failedDraft.content, ...content] : content;
      const initialPromptContent = pendingHandoff
        ? [...sendContent, pendingHandoff.context]
        : sendContent;
      const initialTitle =
        options.initialTitle === undefined ? pendingHandoff?.initialTitle : options.initialTitle;
      const preserveAgentToolDefaults = options.preserveAgentToolDefaults === true;
      const hadEvents = s.events.length > 0;
      const sessionCwd = cwd || s.cwd || "";
      const standaloneClaudeCommand =
        startedWithoutSessionId &&
        s.env.isClaudeAgent(s.agentServer) &&
        isStandaloneSlashCommand(sendText, initialPromptContent);
      const commandHostContext = standaloneClaudeCommand
        ? await this.initialHostContextBlock(sessionCwd)
        : null;
      let addedOptimisticUserMessage = false;
      if (startedWithoutSessionId) {
        if (options.skipOptimisticUserMessage) {
          addedOptimisticUserMessage = true;
        } else {
          s.addUserMessage(content);
          addedOptimisticUserMessage = true;
        }
        const pendingConfigOptions = currentConfigSelections(s.configOptions);
        if (pendingHandoff) {
          try {
            await camberAcpNavPrepareConversationHandoff(pendingHandoff.prepareParams);
            preparedHandoffId = pendingHandoff.handoffId;
          } catch (error) {
            if (gen !== s.generation) return null;
            s.loadIntent = "new";
            s.loadState = failure(normalizeACPError(error));
            s.pendingDraftSend = {
              text: sendText,
              content: sendContent,
              sandboxDefinitionId,
              newSessionMeta,
              cwd: sessionCwd,
            };
            return null;
          }
        }
        const agentConfig = await this.createAgentSession(
          gen,
          sessionCwd,
          [],
          withClaudeSessionFeatures(
            s.agentServer,
            withClaudeAppendSystemPrompt(
              {
                ...newSessionMeta,
                ...(pendingHandoff
                  ? {
                      "camber/handoff": {
                        sourceAgentServer: pendingHandoff.sourceAgentServer,
                        sourceSessionId: pendingHandoff.sourceSessionId,
                      },
                      "camber/handoff_id": pendingHandoff.handoffId,
                    }
                  : {}),
                // The helper binds the nav conversation row to the new session id
                // synchronously at session/new (live status is keyed by session id
                // and silently unattachable until the binding lands); the client's
                // later history upsert only enriches metadata.
                "camber/conversation_id": s.conversationId,
                ...(sandboxDefinitionId
                  ? { sandbox_definition_id: sandboxDefinitionId }
                  : preserveAgentToolDefaults
                    ? {}
                    : { enabled_tools: [] }),
              },
              commandHostContext?.resource.text ?? "",
            ),
            s.env.isClaudeAgent(s.agentServer),
          ),
          pendingConfigOptions,
        );
        if (gen !== s.generation) return null;
        if (s.sessionId === null) {
          s.pendingDraftSend = {
            text: sendText,
            content: sendContent,
            sandboxDefinitionId,
            newSessionMeta,
            cwd: sessionCwd,
          };
          return null;
        }
        if (pendingHandoff) {
          handoffCommitted = true;
          if (s.pendingHandoff === pendingHandoff) {
            s.pendingHandoff = null;
          }
        }
        s.pendingDraftSend = null;
        // Announce the new session as soon as the agent creates it — before
        // applying config options. For the local agent, applying the model
        // option can trigger a slow sidecar model load or an agent restart;
        // emitting here guarantees the conversation reaches the sidebar and the
        // setup UI renders even if the config step then stalls or fails.
        const newSessionTitle =
          initialTitle === undefined ? titleFromPrompt(sendText) : initialTitle;
        if (newSessionTitle) {
          s.titles.set(newSessionTitle);
        }
        this.emitNewSession(s.sessionId, s.agentServer, s.sessionInfo?.cwd || cwd || "/", {
          title: newSessionTitle ?? undefined,
          conversationId: s.conversationId,
        });
        if (pendingConfigOptions.size > 0) {
          s.setupStatus = "Applying configuration...";
        }
        try {
          await this.applyPendingConfigOptions(
            gen,
            pendingConfigOptions,
            agentConfig?.configOptions ?? s.configOptions,
            agentConfig?.reportedConfigOptions,
          );
        } catch (e) {
          if (gen !== s.generation) return null;
          // Surface config-apply failures (e.g. a local model the agent cannot
          // load) as a prompt error instead of letting the rejection escape
          // unhandled and showing the user nothing.
          s.promptError = {
            error: normalizeACPError(e),
            prompt: sendText,
            content: initialPromptContent,
          };
          return null;
        } finally {
          s.setupStatus = null;
        }
      }
      const createdSessionId = startedWithoutSessionId ? s.sessionId : null;
      const sentSessionId = s.sessionId;
      const existingSessionFirstPromptId =
        !startedWithoutSessionId && !hadEvents && sentSessionId ? sentSessionId : null;
      if (existingSessionFirstPromptId) {
        const initialTitle = titleFromPrompt(sendText);
        if (initialTitle) {
          s.titles.set(initialTitle);
        }
      }
      const titleSessionId = createdSessionId ?? existingSessionFirstPromptId;
      const promptContent =
        startedWithoutSessionId && !standaloneClaudeCommand
          ? await this.contentWithInitialHostContext(initialPromptContent, sessionCwd)
          : initialPromptContent;
      if (gen !== s.generation) return null;
      await this.promptCore(gen, sendText, promptContent, {
        addUserMessage: !addedOptimisticUserMessage,
      });
      if (titleSessionId && initialTitle === undefined) {
        void s.titles.fetch(sendText);
      }

      return gen === s.generation ? createdSessionId : null;
    } finally {
      if (preparedHandoffId !== null && !handoffCommitted) {
        try {
          await camberAcpNavAbortConversationHandoff({ handoffId: preparedHandoffId });
        } catch (error) {
          console.warn("Unable to abort prepared ACP conversation handoff", error);
        }
      }
      if (gen === s.generation) {
        s.isSending = false;
        s.setupStatus = null;
        s.env.publishLiveStatuses();
      }
    }
  }

  private sendQueuedPromptAfterCurrentTurn(): void {
    const s = this.session;
    if (this.queuedSendScheduled || s.isPromptActive) return;
    const queued = s.queuedPrompts[0];
    if (!queued) return;
    this.queuedSendScheduled = true;
    s.queuedPrompts = s.queuedPrompts.slice(1);
    void s.serialize(async (gen) => {
      this.queuedSendScheduled = false;
      return this.sendCore(
        gen,
        queued.text,
        queued.sandboxDefinitionId,
        queued.newSessionMeta,
        queued.cwd,
        queued.content,
      );
    });
  }

  private async contentWithInitialHostContext(
    content: ContentBlock[],
    cwd: string,
  ): Promise<ContentBlock[]> {
    const context = await this.initialHostContextBlock(cwd);
    return context ? [...content, context] : content;
  }

  private async initialHostContextBlock(
    cwd: string,
  ): Promise<ReturnType<typeof hostContextBlock> | null> {
    const supportsEmbeddedContext =
      this.session.env.agents.promptCapabilitiesFor(this.session.agentServer)?.embeddedContext ===
      true;
    if (!supportsEmbeddedContext) return null;

    const state = get(appState);
    const userPrompt = await this.projectUserPrompt(cwd, state);
    return hostContextBlock({
      assistantVersion: state.environment.assistantVersion,
      userPrompt,
    });
  }

  private async projectUserPrompt(cwd: string, state = get(appState)): Promise<string | undefined> {
    if (state.environment.assistantHost !== "desktop" || this.session.isChat) return undefined;
    const workspaceFolders = acpWorkspaceFolders(state, cwd);
    const projectPath = acpSessionWorkspacePath(state, workspaceFolders, cwd, this.session.isChat);
    if (!projectPath || projectPath === ACP_IDE_WORKSPACE_PATH) return undefined;

    try {
      const response = await camberAcpNavGetProjectSettings({ path: projectPath });
      return response.settings.userPrompt?.trim() || undefined;
    } catch (e) {
      console.debug("Unable to load ACP project guidelines for agent", e);
      return undefined;
    }
  }

  private async createAgentSession(
    gen: number,
    cwd: string,
    mcpServers: McpServer[],
    _meta: Record<string, unknown> | undefined,
    pendingSelections: Map<string, string | boolean>,
  ): Promise<AgentSessionConfigOptions | null> {
    const s = this.session;
    if (gen !== s.generation) return null;
    const agentServer = s.agentServer;

    s.loadIntent = "new";
    s.loadState = loading;
    s.promptError = null;
    s.env.agents.clearNonSessionError(agentServer);
    s.setupStatus = "Starting ACP agent...";

    // The helper catalog is the source of truth for local models. Capture the
    // draft's catalog-backed option before session/new: the local agent may
    // return only the model it bootstrapped with, which is not enough to
    // validate and apply another downloaded model selected in the draft.
    const draftConfigOptions = s.configOptions;

    const conn = await s.env.agents.useAgentServer(agentServer);
    if (gen !== s.generation) return null;
    if (!conn) {
      s.loadState = waiting;
      s.setupStatus = null;
      return null;
    }

    try {
      s.setupStatus = "Creating session...";
      const res = await conn.newSession({ cwd, mcpServers, _meta: _meta ?? null });
      if (gen !== s.generation) return null;

      s.sessionId = res.sessionId;
      s.sessionInfo = buildSessionInfo(res.sessionId, cwd || "/", "native_session");
      appState.update(appStateUpdates.ensureWorkspaceForCwd(s.sessionInfo.cwd));
      // The response carries the agent's defaults; show the draft's selections
      // immediately so the picker never flashes those defaults while sendCore
      // re-applies the selections over the wire. For the local agent, retain
      // the catalog's full model definitions while preserving the response's
      // actual current value. That enriched response is returned for
      // reconciliation.
      const reportedConfigOptions = res.configOptions ?? [];
      const agentConfigOptions = mergeLocalInferenceModelConfigOptionDefinitionsForAgent(
        agentServer,
        reportedConfigOptions,
        draftConfigOptions,
      );
      s.configOptions = mergeConfigSelections(agentConfigOptions, pendingSelections);
      s.availableCommands = s.env.agents.cachedAvailableCommands(agentServer);
      s.modes = res.modes ?? null;
      s.pendingConfigOptions = {};
      // A real session/new is as authoritative as a config probe; recording
      // it defers the next TTL-gated probe.
      s.env.agents.markAgentConfigFresh(agentServer);
      void s.env.agents.upsertCachedConfig(agentServer, {
        configOptions: s.configOptions,
        availableCommands: s.availableCommands,
        modes: s.modes,
      });
      s.loadState = success(s.loader.buildLoadState());
      s.setupStatus = null;
      s.env.agents.clearAuthRequired(agentServer);
      s.env.publishLiveStatuses();
      return { configOptions: agentConfigOptions, reportedConfigOptions };
    } catch (e) {
      if (gen !== s.generation) return null;
      const err = normalizeACPError(e);
      if (isAuthRequiredError(err)) {
        s.env.agents.markAuthRequired(agentServer);
        s.loadState = waiting;
        s.env.agents.clearNonSessionError(agentServer);
      } else {
        s.loadState = failure(err);
      }
      s.setupStatus = null;
      return null;
    }
  }

  private emitNewSession(
    sessionId: SessionId,
    agentServer: string,
    cwd: string,
    options: { title?: string; conversationId?: string | null } = {},
  ): void {
    const state = get(appState);
    const workspaceFolders = acpWorkspaceFolders(state, cwd);
    this.session.env.emitter.dispatchEvent(
      new CustomEvent(ACP_SESSION_NEW_EVENT, {
        detail: {
          sessionId,
          agentServer,
          cwd,
          workspacePath: acpSessionWorkspacePath(state, workspaceFolders, cwd, this.session.isChat),
          workingDirectories: acpWorkingDirectories(workspaceFolders, cwd),
          conversationId: options.conversationId,
          title: options.title,
        },
      }),
    );
  }

  // Bumps the conversation's updatedAt to "now" whenever the user starts a
  // turn, so the sidebar reflects the time of the last user prompt rather than
  // when the conversation was created. Agent activity does not go through here,
  // so streaming output never advances updatedAt.
  private emitSessionTurn(): void {
    const conversationId = this.session.conversationId;
    if (!conversationId) return;
    this.session.env.emitter.dispatchEvent(
      new CustomEvent(ACP_SESSION_TURN_EVENT, {
        detail: { conversationId },
      }),
    );
  }

  private emitSessionTurnCompleted(sessionId: SessionId, agentServer: string): void {
    this.session.env.emitter.dispatchEvent(
      new CustomEvent(ACP_SESSION_TURN_COMPLETED_EVENT, {
        detail: { sessionId, agentServer },
      }),
    );
  }

  private async applyPendingConfigOptions(
    gen: number,
    pendingConfigOptions: Map<string, string | boolean>,
    agentConfigOptions: SessionConfigOption[],
    reportedConfigOptions = agentConfigOptions,
  ): Promise<void> {
    const s = this.session;
    if (gen !== s.generation || s.sessionId === null) return;

    if (pendingConfigOptions.size > 0) {
      const conn = await s.env.agents.activate(s.agentServer);
      if (gen !== s.generation || !conn || s.sessionId === null) return;

      // s.configOptions already shows the draft's selections optimistically
      // (createAgentSession merged them); reconcile against the agent's raw
      // session/new config so the wire calls are not skipped as already
      // current. On failure, put the agent's real config back so the picker
      // does not keep showing a selection the agent rejected.
      let applied = agentConfigOptions;
      let configOptions: SessionConfigOption[] | null;
      try {
        configOptions = await applySessionConfigSelections({
          conn,
          sessionId: s.sessionId,
          configOptions: agentConfigOptions,
          reportedConfigOptions,
          selections: pendingConfigOptions,
          isCurrent: () => gen === s.generation && s.sessionId !== null,
          reconcileConfigOptions: (reported, fallback) =>
            mergeLocalInferenceModelConfigOptionDefinitionsForAgent(
              s.agentServer,
              reported,
              fallback,
            ),
          onApplied: (options) => {
            applied = options;
            s.configOptions = mergeConfigSelections(applied, pendingConfigOptions);
          },
        });
      } catch (e) {
        if (gen === s.generation) s.configOptions = applied;
        throw e;
      }
      if (!configOptions) return;
      s.configOptions = configOptions;

      void s.env.agents.upsertCachedConfig(s.agentServer, {
        configOptions: s.configOptions,
        availableCommands: s.availableCommands,
        modes: s.modes,
      });
    }

    // Persist the session config snapshot now rather than waiting for the
    // first transcript flush — if the first prompt errors or the app exits
    // mid-turn, the draft selections would otherwise never reach storage.
    s.metadataManager.refresh();
  }
}

function isStandaloneSlashCommand(text: string, content: ContentBlock[]): boolean {
  return (
    /^\/[A-Za-z0-9][A-Za-z0-9:_-]*(?:\s|$)/.test(text) &&
    content.length === 1 &&
    content[0]?.type === "text" &&
    content[0].text === text
  );
}
