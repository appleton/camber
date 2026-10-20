import {
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  ACPCompactionNotification,
  ACPTurnEndedNotification,
} from "@camber/helperapi/schemas";
import { DEFAULT_AGENT_SERVER, normalizeAgentServerName } from "./agentServers";
import { CLAUDE_SDK_MESSAGE_METHOD, parseClaudePromptSuggestion } from "./claudePromptSuggestions";
import type { ACPSessionRepositoryWriter } from "./features/SessionRepository.svelte";
import { parseClaudeGoalUpdate } from "./goals";

export class ACPClient implements Client {
  private agentServer: string;

  constructor(
    private repo: ACPSessionRepositoryWriter,
    agentServer = DEFAULT_AGENT_SERVER,
  ) {
    this.agentServer = normalizeAgentServerName(agentServer);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.repo.handleRequestPermission(this.agentServer, params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.repo.handleSessionUpdate(this.agentServer, params);
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    switch (method) {
      case "authenticate/update": {
        return this.repo.agents.handleAuthenticateUpdate(params, this.agentServer);
      }
      case "camber/acp/compaction_update":
        return this.repo.handleCompactionUpdate(
          this.agentServer,
          params as unknown as ACPCompactionNotification,
        );
      case "camber/acp/turn_ended":
        return this.repo.handleTurnEnded(
          this.agentServer,
          params as unknown as ACPTurnEndedNotification,
        );
      case "camber/acp/session_replay_started":
        if (typeof params.sessionId === "string") {
          this.repo.handleSessionReplayStarted(this.agentServer, params.sessionId);
        }
        return;
      case CLAUDE_SDK_MESSAGE_METHOD: {
        const suggestion = parseClaudePromptSuggestion(params);
        if (suggestion) {
          this.repo.handlePromptSuggestion(this.agentServer, suggestion);
        }
        const goal = parseClaudeGoalUpdate(params);
        if (goal) {
          this.repo.handleGoalUpdate(this.agentServer, goal);
        }
        return;
      }
    }
  }
}
