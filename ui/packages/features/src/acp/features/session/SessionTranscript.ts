import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";
import { parseCodexGoalUpdate } from "../../goals";
import { applySessionInfoUpdate } from "../../sessionInfo";
import {
  getSessionUpdateMessageId,
  isStreamingChunk,
  TurnMaterializer,
} from "../../TurnMaterializer";
import { textPromptContent } from "./content";
import { withoutHostContextBlocks } from "./hostContext";
import type { ACPSession } from "./Session.svelte";
import { ACP_USER_MESSAGE_STEER_META_KEY } from "./steering";

export class ACPSessionTranscript {
  constructor(private readonly session: ACPSession) {}

  reset({ preserveEvents = false }: { preserveEvents?: boolean } = {}): void {
    const s = this.session;
    if (!preserveEvents) {
      s.cancelTranscriptFlush();
      s.materializer = new TurnMaterializer();
      s.historicalEvents = [];
      s.historicalTurns = [];
      s.historicalPlan = null;
      s.events = [];
      s.turns = [];
      s.plan = null;
      s.metadataManager.reset();
    }
    s.extensions.camber?.reset();
    s.usageState.reset();
    s.lastRemoteMessageId = null;
    s.ignoredMessageIds = new Set();
  }

  clearReplay(): void {
    this.session.replayMaterializer = null;
    this.session.replaySessionInfo = null;
  }

  addUserMessage(
    content: ContentBlock[] | string,
    { steer = false }: { steer?: boolean } = {},
  ): void {
    const s = this.session;
    s.materializer.resetContinuation();
    const blocks =
      typeof content === "string" ? textPromptContent(content) : withoutHostContextBlocks(content);
    for (const block of blocks) {
      s.materializer.apply({
        sessionUpdate: "user_message_chunk",
        content: block,
        ...(steer ? { _meta: { [ACP_USER_MESSAGE_STEER_META_KEY]: true } } : {}),
      });
    }
    s.publishTranscript();
    s.env.publishLiveStatuses();
  }

  applyReplayUpdate(params: SessionNotification): void {
    const s = this.session;
    const replay = s.replayMaterializer;
    if (!replay) return;
    replay.apply(params.update);
    s.titles.extractFromAgentMessage(replay, params.update, { replay: true });
    switch (params.update.sessionUpdate) {
      case "available_commands_update": {
        const cached = s.env.agents.cachedConfigFor(s.agentServer);
        void s.env.agents.upsertCachedConfig(s.agentServer, {
          configOptions: cached?.configOptions ?? [],
          availableCommands: params.update.availableCommands,
          modes: cached?.modes ?? null,
          replaceAvailableCommands: true,
        });
        break;
      }
      case "session_info_update": {
        const goal = parseCodexGoalUpdate(params.update);
        if (goal !== undefined) s.setGoal(goal);
        const previousTitle = s.replaySessionInfo?.title;
        s.replaySessionInfo = applySessionInfoUpdate(
          s.replaySessionInfo,
          params.sessionId,
          params.update,
        );
        if (previousTitle !== s.replaySessionInfo?.title) {
          s.titles.emit(s.replaySessionInfo?.title);
        }
        break;
      }
      case "usage_update":
        s.usageState.apply(params.update);
        break;
    }
  }

  applySessionUpdate(params: SessionNotification): void {
    const s = this.session;
    if (s.sessionId === null) return;
    const messageId = getSessionUpdateMessageId(params.update);
    if (messageId !== null && s.ignoredMessageIds.has(messageId)) return;

    const streamingChunk = isStreamingChunk(params.update);
    if (messageId !== null && streamingChunk) {
      s.lastRemoteMessageId = messageId;
    }

    const suppressInitialModeEvent =
      params.update.sessionUpdate === "current_mode_update" && s.materializer.events.length === 0;

    if (!suppressInitialModeEvent) {
      s.materializer.apply(params.update);
      s.titles.extractFromAgentMessage(s.materializer, params.update);
      s.publishTranscript({ batched: streamingChunk });
    }

    switch (params.update.sessionUpdate) {
      case "config_option_update":
        s.config.applyOptions(params.update.configOptions);
        break;
      case "available_commands_update":
        s.availableCommands = params.update.availableCommands;
        void s.env.agents.upsertCachedConfig(s.agentServer, {
          configOptions: s.configOptions,
          availableCommands: s.availableCommands,
          modes: s.modes,
          replaceAvailableCommands: true,
        });
        s.env.applyCachedConfigToLocalSessionsForAgent(s.agentServer, s.conversationId);
        break;
      case "current_mode_update":
        s.config.applyModeUpdate(params.update.currentModeId);
        break;
      case "session_info_update": {
        const goal = parseCodexGoalUpdate(params.update);
        if (goal !== undefined) s.setGoal(goal);
        const previousTitle = s.sessionInfo?.title;
        s.sessionInfo = applySessionInfoUpdate(s.sessionInfo, params.sessionId, params.update);
        s.titles.emitIfChanged(previousTitle, s.sessionInfo?.title);
        s.metadataManager.refresh();
        break;
      }
      case "usage_update":
        s.usageState.apply(params.update);
        break;
    }

    s.env.publishLiveStatuses();
  }
}
