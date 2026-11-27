import type {
  ToolCall as ACPToolCall,
  ContentBlock,
  SessionNotification,
  SessionUpdate,
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

export type CompactionStatus = "in_progress" | "completed" | "failed" | "cancelled";

export const STANDARD_COMPACTION_NOTIFICATION = "camber/acp/standard_compaction";

export type CompactionUpdate = {
  compactionId: string;
  _meta?: Record<string, unknown> | null;
} & (
  | {
      sessionUpdate: "compaction_update";
      status: CompactionStatus;
      summary?: ContentBlock[] | null;
      error?: string | null;
    }
  | { sessionUpdate: "compaction_summary_chunk"; content: ContentBlock }
);

export type TranscriptUpdate = SessionUpdate | CompactionUpdate;
export type TranscriptNotification = Omit<SessionNotification, "update"> & {
  update: TranscriptUpdate;
};

export function isCompactionUpdate(
  update: { sessionUpdate?: unknown } | undefined,
): update is CompactionUpdate {
  return (
    update?.sessionUpdate === "compaction_update" ||
    update?.sessionUpdate === "compaction_summary_chunk"
  );
}

export type SessionCompaction = {
  eventKind: "compaction";
  compactionId: string;
  status: CompactionStatus;
  summary: ContentBlock[];
  error?: string | null;
};

export type SessionEvent =
  | UserMessage
  | AgentMessage
  | AgentThought
  | ToolCall
  | ModeChange
  | SessionHandoff
  | SessionCompaction;

export function isToolCall(e: SessionEvent): e is ToolCall {
  return e.eventKind === "tool_call";
}
