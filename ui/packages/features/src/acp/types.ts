import type {
  ToolCall as ACPToolCall,
  ContentBlock,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { ExtractUnionMember } from "@camber/lib/types";

export type UserMessage = {
  eventKind: "user_message";
  messageId: string | null;
  content: ContentBlock[];
  _meta?: Record<string, unknown> | null;
  /** This message steered the active turn rather than starting a new one. */
  steer?: true;
};
export type AgentMessage = {
  eventKind: "agent_message";
  messageId: string | null;
  content: ContentBlock[];
  _meta?: Record<string, unknown> | null;
};
export type AgentThought = {
  eventKind: "agent_thought";
  messageId: string | null;
  content: ContentBlock[];
  _meta?: Record<string, unknown> | null;
  /** Older content was discarded from this in-memory thought to bound its size. */
  truncated?: boolean;
};
export type ToolCallStatus = ACPToolCall["status"] | "cancelled";
export type ToolCall = { eventKind: "tool_call" } & Omit<ACPToolCall, "status"> & {
    status?: ToolCallStatus;
  };

export type ToolCallDiffContent = ExtractUnionMember<ToolCallContent, "diff">;

export type ModeChange = {
  eventKind: "mode_change";
  currentModeId: string;
};

export type SessionHandoff = {
  eventKind: "handoff";
  sourceAgentServer: string;
  sourceSessionId: string;
  targetAgentServer: string;
  createdAt: string;
};

export type SessionEvent =
  | UserMessage
  | AgentMessage
  | AgentThought
  | ToolCall
  | ModeChange
  | SessionHandoff;

export function isToolCall(e: SessionEvent): e is ToolCall {
  return e.eventKind === "tool_call";
}
