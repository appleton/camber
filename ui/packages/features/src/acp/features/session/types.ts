import type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  Plan,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionId,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import type { ACPNavPrepareConversationHandoffParams } from "@camber/helperapi/schemas";
import type { ACPRequestError } from "../../errors";
import type { ACPResolvedSessionInfo } from "../../sessionInfo";
import type { SessionEvent } from "../../TurnMaterializer";
import type { ACPAgentRepository } from "../AgentRepository.svelte";
import type { ACPSession } from "./Session.svelte";

export const ACP_SESSION_NEW_EVENT = "session:new";
export const ACP_SESSION_TURN_EVENT = "session:turn";
export const ACP_SESSION_TURN_COMPLETED_EVENT = "session:turn-completed";
export const ACP_SESSION_TITLE_EVENT = "session:title";
export const ACP_PENDING_CONVERSATION_AGENT_EVENT = "pending-conversation:agent";

export const ACP_PLAN_MODE_ID = "plan";
export const ACP_DEFAULT_MODE_ID = "default";

/**
 * Category agents use for the option that says how the agent works
 * (build vs plan) as opposed to what it is allowed to do without asking —
 * Codex publishes it as `collaboration_mode`, Camber as `agent_mode`. It is
 * not part of the SDK's category union yet, so it travels as a plain string
 * and is matched by category rather than by id.
 */
export const ACP_COLLABORATION_MODE_CATEGORY = "collaboration_mode";

/**
 * How a collaboration option should be surfaced.
 *
 * - `plan-toggle`: two values, one of them plan (Camber's build/plan, Codex's
 *   default/plan). It reduces to on/off, so it rides on `/plan` and the plan
 *   chip rather than costing a picker in the promptbox footer.
 * - `picker`: an agent offering modes a two-way toggle could not reach, so the
 *   option gets its own dropdown beside the permission mode.
 * - `none`: the agent publishes no collaboration option.
 */
export type ACPCollaborationModeSurface = "none" | "plan-toggle" | "picker";

export type ACPSessionLoadIntent = "load" | "new";

export type StringSelectSessionConfigOption = SessionConfigOption & {
  type: "select";
  currentValue: string;
};

export interface ACPPendingPermissionRequest {
  id: string;
  agentServer: string;
  sessionId: SessionId;
  toolCall: RequestPermissionRequest["toolCall"];
  options: PermissionOption[];
  /**
   * Set for requests reconciled from the helper's approval store: answering
   * goes through camber/acp/approvals/respond with this identity instead of
   * resolving a local promise, and removal arrives via the next didChange
   * push. Absent on legacy (SDK-delivered) and debug-dump requests.
   */
  approval?: {
    agentServer: string;
    sessionId: string;
    kind: "permission";
    id: string;
  };
}

export interface ACPPendingConfigOption {
  configId: string;
  value: string;
  requestId: number;
  error: ACPRequestError | null;
}

export type ACPGoalAction = "pause" | "resume" | "clear";

export interface ACPConversationLiveStatus {
  working: boolean;
  waitingForUser: boolean;
  unread: boolean;
}

export interface ACPPromptError {
  error: ACPRequestError;
  prompt: string;
  content?: ContentBlock[];
}

export interface ACPQueuedPrompt {
  /** Stable only for the lifetime of the local queue. */
  id?: string;
  text: string;
  content: ContentBlock[];
  sandboxDefinitionId?: string;
  newSessionMeta?: Record<string, unknown>;
  cwd: string;
}

export interface ACPSessionCancelOptions {
  sendQueuedPrompt?: boolean;
}

export interface ACPPendingHandoff {
  handoffId: string;
  sourceAgentServer: string;
  sourceSessionId: string;
  targetAgentServer: string;
  context: ContentBlock;
  /** Undefined when the source was untitled, so the target falls back to normal title generation. */
  initialTitle: string | undefined;
  /**
   * The still-live source leg. It remains agent-owned while the target is only
   * staged, so the user can redirect the handoff or return to the source.
   */
  sourceSession: ACPSession;
  prepareParams: ACPNavPrepareConversationHandoffParams;
}

export type ACPSessionSendCoreArgs = [
  gen: number,
  text: string,
  sandboxDefinitionId: string | undefined,
  newSessionMeta?: Record<string, unknown>,
  cwd?: string,
  content?: ContentBlock[],
  options?: {
    skipOptimisticUserMessage?: boolean;
    initialTitle?: string | null;
    preserveAgentToolDefaults?: boolean;
  },
];

export interface ACPSessionLoadState {
  sessionId: SessionId;
  agentServer: string;
  sessionInfo: ACPResolvedSessionInfo | null;
  events: SessionEvent[];
  plan: Plan | null;
  configOptions: SessionConfigOption[];
  availableCommands: AvailableCommand[];
  modes: SessionModeState | null;
}

export interface ACPSessionEnvironment {
  agents: ACPAgentRepository;
  emitter: EventTarget;
  isClaudeAgent(agentServer: string): boolean;
  applyCachedConfigToLocalSessionsForAgent(
    agentServer: string,
    exceptConversationId?: string,
  ): void;
  cancelPendingPermissionRequestsForSession(sessionId: SessionId, agentServer?: string): void;
  markUnread(sessionId: SessionId, agentServer: string): void;
  publishLiveStatuses(): void;
}
