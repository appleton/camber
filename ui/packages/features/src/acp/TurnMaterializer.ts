import type { ContentBlock, Plan, SessionUpdate } from "@agentclientprotocol/sdk";
import { isHandoffContextBlock } from "./features/session/handoffContext";
import { isHostContextBlock, stripInjectedContextBlock } from "./features/session/hostContext";
import { ACP_USER_MESSAGE_STEER_META_KEY } from "./features/session/steering";
import { unwrapUserMessageBlock } from "./features/session/userMessageBoundary";
import { applyShellToolOverride } from "./shellToolOverride";
import type { AgentMessage, AgentThought, SessionEvent, ToolCall, UserMessage } from "./types";

export type { SessionEvent } from "./types";

type MessageKind = "user_message" | "agent_message" | "agent_thought";
const STEP_ID_META_KEY = "camber/step_id";
const CLAUDE_PARENT_TOOL_USE_ID_META_KEY = "parentToolUseId";

// Reasoning can stream indefinitely. Keep enough recent context to remain
// useful while bounding both the canonical event and its rendered snapshots.
export const MAX_AGENT_THOUGHT_TEXT_CHARS = 64 * 1024;
export const MAX_AGENT_THOUGHT_CONTENT_BYTES = 256 * 1024;
const ESTIMATED_CONTENT_BLOCK_OVERHEAD_BYTES = 256;

export type TurnMetadata = {
  startedAt: string;
  endedAt: string;
  startIndex: number;
  endIndex: number;
  interrupted?: boolean;
};

type CurrentTurnMetadata = {
  startedAt: string;
  startIndex: number;
};

const chunkKindMap: Record<string, MessageKind> = {
  user_message_chunk: "user_message",
  agent_message_chunk: "agent_message",
  agent_thought_chunk: "agent_thought",
};

/**
 * Incrementally materializes a stream of SessionUpdates into SessionEvents.
 * Call `apply()` for each new update; read `events` for the current snapshot.
 * The plan is tracked separately since it's a single evolving entity, not a sequential event.
 */
export class TurnMaterializer {
  private _events: SessionEvent[] = [];
  private _turns: TurnMetadata[] = [];
  private _plan: Plan | null = null;
  private messageIndex = new Map<string, number>();
  private explicitMessageRelationships = new Map<string, string>();
  private toolCallIndex = new Map<string, number>();
  private lastMessageKey: string | null = null;
  private currentTurn: CurrentTurnMetadata | null = null;

  get events(): readonly SessionEvent[] {
    return this._events;
  }

  get plan(): Plan | null {
    return this._plan;
  }

  get turns(): readonly TurnMetadata[] {
    return this._turns;
  }

  get currentTurnStartIndex(): number | null {
    return this.currentTurn?.startIndex ?? null;
  }

  apply(update: SessionUpdate): void {
    const eventKind = chunkKindMap[update.sessionUpdate];
    if (eventKind) {
      this.applyMessageChunk(
        eventKind,
        update as SessionUpdate & { content: ContentBlock; messageId?: string | null },
      );
      return;
    }

    switch (update.sessionUpdate) {
      case "tool_call":
        this.applyToolCall(update);
        break;
      case "tool_call_update":
        this.applyToolCallUpdate(update);
        break;
      case "plan":
        this.applyPlan(update);
        break;
      case "current_mode_update":
        this.applyModeChange(update);
        break;
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
      case "available_commands_update":
        break;
    }
  }

  reset(): void {
    this._events = [];
    this._plan = null;
    this.messageIndex.clear();
    this.explicitMessageRelationships.clear();
    this.toolCallIndex.clear();
    this.lastMessageKey = null;
    this._turns = [];
    this.currentTurn = null;
  }

  resetContinuation(): void {
    this.lastMessageKey = null;
  }

  startTurn(startedAt: Date | string = new Date()): void {
    this.currentTurn = {
      startedAt: isoTimestamp(startedAt),
      startIndex: this._events.length,
    };
  }

  completeOpenToolCalls(endedAt?: Date | string): void {
    for (const event of this._events) {
      if (
        event.eventKind === "tool_call" &&
        event.status !== "completed" &&
        event.status !== "failed"
      ) {
        event.status = "completed";
      }
    }
    if (endedAt !== undefined) {
      this.finishCurrentTurn(endedAt);
    }
  }

  cancelOpenToolCalls(endedAt?: Date | string): void {
    for (const event of this._events) {
      if (
        event.eventKind === "tool_call" &&
        event.status !== "completed" &&
        event.status !== "failed"
      ) {
        event.status = "cancelled";
      }
    }
    if (endedAt !== undefined) {
      this.finishCurrentTurn(endedAt, { interrupted: true });
    }
  }

  private applyMessageChunk(
    eventKind: MessageKind,
    chunk: {
      content: ContentBlock;
      messageId?: string | null;
      _meta?: Record<string, unknown> | null;
    },
  ): void {
    const isSteer =
      eventKind === "user_message" && chunk._meta?.[ACP_USER_MESSAGE_STEER_META_KEY] === true;
    if (
      eventKind === "user_message" &&
      (isHostContextBlock(chunk.content) || isHandoffContextBlock(chunk.content))
    ) {
      return;
    }
    const content =
      eventKind === "user_message"
        ? stripInjectedContextBlock(unwrapUserMessageBlock(chunk.content))
        : chunk.content;
    if (eventKind === "user_message" && content.type === "text" && content.text.length === 0) {
      return;
    }

    const messageId = getSessionUpdateMessageId(chunk);
    const parentToolUseId = getClaudeParentToolUseId(chunk._meta);
    const explicitMessageKey = messageId !== null ? `${eventKind}|${messageId}` : null;
    const relationshipKey =
      parentToolUseId ??
      (explicitMessageKey ? this.explicitMessageRelationships.get(explicitMessageKey) : null) ??
      "__root__";
    if (explicitMessageKey && parentToolUseId) {
      this.explicitMessageRelationships.set(explicitMessageKey, parentToolUseId);
    }
    const key =
      messageId !== null
        ? `${eventKind}|${relationshipKey}|${messageId}`
        : `${eventKind}|${relationshipKey}|__null__`;

    let idx: number | undefined;
    if (messageId !== null) {
      idx = this.messageIndex.get(key);
    } else {
      idx = this.lastMessageKey === key ? this.messageIndex.get(key) : undefined;
    }

    if (idx !== undefined) {
      const msg = this._events[idx] as UserMessage | AgentMessage | AgentThought;
      if (isSteer && msg.eventKind === "user_message") msg.steer = true;
      if (chunk._meta) {
        msg._meta = isRecord(msg._meta) ? mergeRecordFields(msg._meta, chunk._meta) : chunk._meta;
      }
      const block = content;
      const lastBlock = msg.content[msg.content.length - 1];
      if (block.type === "text" && lastBlock?.type === "text") {
        if (msg.eventKind === "agent_thought") {
          const keepFromPrevious = Math.max(MAX_AGENT_THOUGHT_TEXT_CHARS - block.text.length, 0);
          const nextText =
            block.text.length >= MAX_AGENT_THOUGHT_TEXT_CHARS
              ? block.text.slice(-MAX_AGENT_THOUGHT_TEXT_CHARS)
              : lastBlock.text.slice(-keepFromPrevious) + block.text;
          if (lastBlock.text.length + block.text.length > MAX_AGENT_THOUGHT_TEXT_CHARS) {
            msg.truncated = true;
          }
          msg.content[msg.content.length - 1] = { ...lastBlock, text: nextText };
        } else {
          msg.content[msg.content.length - 1] = { ...lastBlock, text: lastBlock.text + block.text };
        }
      } else {
        msg.content.push(block);
      }
      if (msg.eventKind === "agent_thought") capAgentThoughtContent(msg);
    } else {
      idx = this._events.length;
      this.messageIndex.set(key, idx);
      const message = {
        eventKind,
        messageId,
        content: [content],
        ...(chunk._meta ? { _meta: chunk._meta } : {}),
        ...(isSteer ? { steer: true as const } : {}),
      } as UserMessage | AgentMessage | AgentThought;
      if (message.eventKind === "agent_thought") capAgentThoughtContent(message);
      this._events.push(message);
    }
    this.lastMessageKey = key;
  }

  private applyToolCall(update: SessionUpdate & { sessionUpdate: "tool_call" }): void {
    const normalizedUpdate = applyShellToolOverride(update);
    const { sessionUpdate: _, ...rest } = normalizedUpdate;
    const idx = this._events.length;
    this.toolCallIndex.set(normalizedUpdate.toolCallId, idx);
    this._events.push({
      eventKind: "tool_call",
      ...rest,
    } as ToolCall);
    this.lastMessageKey = null;
  }

  private applyToolCallUpdate(update: SessionUpdate & { sessionUpdate: "tool_call_update" }): void {
    const idx = this.toolCallIndex.get(update.toolCallId);
    if (idx === undefined) return;
    const existing = this._events[idx] as ToolCall;
    const { sessionUpdate: _, toolCallId: __, ...fields } = update;
    for (const [k, v] of Object.entries(fields)) {
      if (v == null) continue;
      // Status updates can carry partial metadata, so preserve keys set on the
      // initial frame, including nested agent metadata such as
      // `claudeCode.toolName`.
      if (k === "_meta" && isRecord(existing._meta) && isRecord(v)) {
        existing._meta = mergeRecordFields(existing._meta, v);
      } else {
        (existing as Record<string, unknown>)[k] = v;
      }
    }
  }

  private applyPlan(update: SessionUpdate & { sessionUpdate: "plan" }): void {
    const { sessionUpdate: _, ...rest } = update;
    this._plan = reconcilePlan(this._plan, rest as Plan);
    this.lastMessageKey = null;
  }

  private applyModeChange(update: SessionUpdate & { sessionUpdate: "current_mode_update" }): void {
    this._events.push({
      eventKind: "mode_change",
      currentModeId: update.currentModeId,
    });
    this.lastMessageKey = null;
  }

  private finishCurrentTurn(
    endedAt: Date | string,
    { interrupted = false }: { interrupted?: boolean } = {},
  ): void {
    if (!this.currentTurn) return;
    this._turns.push({
      startedAt: this.currentTurn.startedAt,
      endedAt: isoTimestamp(endedAt),
      startIndex: this.currentTurn.startIndex,
      endIndex: this._events.length - 1,
      ...(interrupted ? { interrupted } : {}),
    });
    this.currentTurn = null;
  }
}

function getClaudeParentToolUseId(meta: Record<string, unknown> | null | undefined): string | null {
  if (!isRecord(meta?.claudeCode)) return null;
  const parentToolUseId = meta.claudeCode[CLAUDE_PARENT_TOOL_USE_ID_META_KEY];
  return typeof parentToolUseId === "string" && parentToolUseId !== "" ? parentToolUseId : null;
}

/** Keep the newest bounded tail across every kind of thought content. */
function capAgentThoughtContent(thought: AgentThought): void {
  let remaining = MAX_AGENT_THOUGHT_TEXT_CHARS;

  for (let index = thought.content.length - 1; index >= 0; index--) {
    const block = thought.content[index];
    if (block?.type !== "text" || block.text.length === 0) continue;

    if (remaining === 0) {
      thought.content.splice(index, 1);
      thought.truncated = true;
    } else if (block.text.length > remaining) {
      thought.content[index] = { ...block, text: block.text.slice(-remaining) };
      remaining = 0;
      thought.truncated = true;
    } else {
      remaining -= block.text.length;
    }
  }

  let remainingBytes = MAX_AGENT_THOUGHT_CONTENT_BYTES;
  for (let index = thought.content.length - 1; index >= 0; index--) {
    const block = thought.content[index];
    if (!block) continue;
    const blockBytes = estimatedContentBlockBytes(block);
    if (blockBytes > remainingBytes) {
      thought.content.splice(index, 1);
      thought.truncated = true;
    } else {
      remainingBytes -= blockBytes;
    }
  }
}

function estimatedContentBlockBytes(block: ContentBlock): number {
  try {
    return JSON.stringify(block).length * 2 + ESTIMATED_CONTENT_BLOCK_OVERHEAD_BYTES;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function getSessionUpdateMessageId(update: {
  messageId?: string | null;
  _meta?: Record<string, unknown> | null;
}): string | null {
  if (typeof update.messageId === "string") {
    return update.messageId;
  }

  const stepId = update._meta?.[STEP_ID_META_KEY];
  return typeof stepId === "string" ? stepId : null;
}

/**
 * The updates that stream incrementally from the remote agent during a turn.
 * Drives both the "last remote message id" bookkeeping and the coalesced
 * (cadence- and frame-batched) transcript publish — keep the two in step by
 * asking here rather than re-listing the kinds.
 */
export function isStreamingChunk(update: SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
      return true;
    default:
      return false;
  }
}

function isoTimestamp(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

// Agents may reorder plan entries between updates (e.g. moving completed items
// around). Keep entries at their first-seen position so the rendered todo list
// stays stable; a zero-overlap update means a new plan, taken as-is.
function reconcilePlan(previous: Plan | null, next: Plan): Plan {
  if (!previous) return next;
  const previousOrder = new Map(previous.entries.map((e, i) => [e.content, i]));
  const hasOverlap = next.entries.some((e) => previousOrder.has(e.content));
  if (!hasOverlap) return next;

  const entries = [...next.entries].sort((a, b) => {
    const ai = previousOrder.get(a.content) ?? Number.POSITIVE_INFINITY;
    const bi = previousOrder.get(b.content) ?? Number.POSITIVE_INFINITY;
    return ai - bi;
  });
  return { ...next, entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function mergeRecordFields(
  existing: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(update)) {
    merged[key] = isRecord(merged[key]) && isRecord(value) ? { ...merged[key], ...value } : value;
  }
  return merged;
}
