import type { TurnMetadata } from "./TurnMaterializer";
import type { SessionEvent, ToolCall, ToolCallStatus } from "./types";

export type SubagentProvider = "claude" | "codex" | "pool";

export type SubagentReference = {
  key: string;
  provider: SubagentProvider;
  id: string;
  title: string;
  status?: ToolCallStatus | string;
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  sourceToolCallId: string;
};

export type CodexSubagentEntry = {
  event: ToolCall;
  index: number;
  action?: string;
  activity?: string;
  status?: string;
  message?: string;
  prompt?: string;
};

export type SubagentTranscriptIndex = {
  references: ReadonlyMap<string, SubagentReference>;
  topLevelEvents: SessionEvent[];
  topLevelTurns: TurnMetadata[];
  topLevelActiveTurnStartIndex: number | null;
  referenceForKey(key: string): SubagentReference | undefined;
  referencesForTool(tool: ToolCall): SubagentReference[];
  claudeEvents(key: string): SessionEvent[];
  codexEntries(key: string): CodexSubagentEntry[];
};

export type SubagentTranscriptIndexOptions = {
  activeTurnStartIndex?: number | null;
  codexTurnActive?: boolean;
  codexActiveTurnStartIndex?: number;
};

type IndexedReference = SubagentReference & {
  pathTitle?: string;
  statusSource?: "reported" | "activity" | "action" | "tool" | "settled";
  statusIndex?: number;
};

const CLAUDE_PREFIX = "claude:";
const CODEX_PREFIX = "codex:";
const POOL_PREFIX = "pool:";

// Pool tags every tool call with its tool name; "subagent" marks a delegated
// task. Pool runs the child in a separate `pool acp` process and only reports
// its final message, so a pool subagent has a status and a result but no
// child transcript.
const POOL_SUBAGENT_TOOL_NAME = "subagent";

// Pool sends the whole standalone task as the tool's only argument. Cap it so
// row titles and the accessible names built from them stay readable; the full
// text stays on the reference as `prompt`.
const POOL_TITLE_LIMIT = 120;

export function buildSubagentTranscriptIndex(
  events: readonly SessionEvent[],
  turns: readonly TurnMetadata[] = [],
  options: SubagentTranscriptIndexOptions = {},
): SubagentTranscriptIndex {
  const references = new Map<string, IndexedReference>();
  const claudeChildren = new Map<string, SessionEvent[]>();
  const codexActivity = new Map<string, CodexSubagentEntry[]>();
  const claudeRootIds = new Set<string>();
  const claudeRootParents = new Map<string, string>();

  for (const event of events) {
    if (event.eventKind !== "tool_call") continue;
    if (isPoolSubagentTool(event)) {
      const reference = poolReference(event);
      references.set(reference.key, reference);
      continue;
    }
    if (!isClaudeSubagentTool(event)) continue;
    claudeRootIds.add(event.toolCallId);
    const parentToolUseId = claudeParentToolUseId(event);
    if (parentToolUseId) claudeRootParents.set(event.toolCallId, parentToolUseId);
    const reference = claudeReference(event);
    references.set(reference.key, reference);
  }

  const topLevelEvents: SessionEvent[] = [];
  const visibleOriginalIndices: number[] = [];
  const cyclicClaudeRootIds = cyclicRootIds(claudeRootParents);

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const parentToolUseId = claudeParentToolUseId(event);
    const cyclicRoot = event.eventKind === "tool_call" && cyclicClaudeRootIds.has(event.toolCallId);
    if (parentToolUseId && claudeRootIds.has(parentToolUseId) && !cyclicRoot) {
      const key = `${CLAUDE_PREFIX}${parentToolUseId}`;
      const children = claudeChildren.get(key) ?? [];
      children.push(event);
      claudeChildren.set(key, children);
    } else {
      topLevelEvents.push(event);
      visibleOriginalIndices.push(index);
    }

    if (event.eventKind !== "tool_call") continue;
    for (const candidate of codexCandidates(event, index)) {
      const existing = references.get(candidate.reference.key);
      references.set(candidate.reference.key, mergeReference(existing, candidate.reference));
      const entries = codexActivity.get(candidate.reference.key) ?? [];
      entries.push(candidate.entry);
      codexActivity.set(candidate.reference.key, entries);
    }
  }

  settleCodexReferences(references, turns, options);

  // The start is a boundary before the first active event. Child events
  // removed from the main transcript must not shift it past a visible row.
  const { activeTurnStartIndex } = options;
  const topLevelActiveTurnStartIndex =
    activeTurnStartIndex == null
      ? null
      : visibleOriginalIndices.filter((index) => index < activeTurnStartIndex).length;
  const publicReferences = references as ReadonlyMap<string, SubagentReference>;
  return {
    references: publicReferences,
    topLevelEvents,
    topLevelTurns: remapTurns(turns, visibleOriginalIndices),
    topLevelActiveTurnStartIndex,
    referenceForKey(key) {
      return publicReferences.get(key);
    },
    referencesForTool(tool) {
      if (isClaudeSubagentTool(tool)) {
        const reference = publicReferences.get(`${CLAUDE_PREFIX}${tool.toolCallId}`);
        return reference ? [reference] : [];
      }
      if (isPoolSubagentTool(tool)) {
        const reference = publicReferences.get(`${POOL_PREFIX}${tool.toolCallId}`);
        return reference ? [reference] : [];
      }
      const keys = codexCandidates(tool, -1).map((candidate) => candidate.reference.key);
      return [...new Set(keys)]
        .map((key) => publicReferences.get(key))
        .filter((reference): reference is SubagentReference => reference !== undefined);
    },
    claudeEvents(key) {
      return claudeChildren.get(key) ?? [];
    },
    codexEntries(key) {
      return codexActivity.get(key) ?? [];
    },
  };
}

export function isSubagentTool(tool: ToolCall): boolean {
  return (
    isClaudeSubagentTool(tool) || isPoolSubagentTool(tool) || codexCandidates(tool, -1).length > 0
  );
}

export function isClaudeSubagentTool(tool: ToolCall): boolean {
  return asRecord(asRecord(tool._meta)?.claudeCode)?.subagent === true;
}

export function isPoolSubagentTool(tool: ToolCall): boolean {
  return asString(asRecord(tool._meta)?.tool_name) === POOL_SUBAGENT_TOOL_NAME;
}

export function subagentStatusIsRunning(status: string | undefined): boolean {
  return status === "in_progress" || status === "pendingInit" || status === "running";
}

export function subagentStatusLabel(status: string | undefined): string {
  if (!status) return "Status unavailable";
  if (status === "pendingInit") return "Starting";
  if (status === "in_progress" || status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed" || status === "errored") return "Failed";
  if (status === "cancelled" || status === "interrupted") return "Interrupted";
  if (status === "shutdown") return "Closed";
  return status;
}

export function subagentProvidesTranscript(
  reference: Pick<SubagentReference, "key" | "provider">,
): boolean {
  return reference.provider === "claude" && subagentKeyProvidesTranscript(reference.key);
}

export function subagentKeyProvidesTranscript(key: string): boolean {
  return key.startsWith(CLAUDE_PREFIX);
}

export function subagentTranscriptRevision(index: SubagentTranscriptIndex, key: string): string {
  const reference = index.referenceForKey(key);
  const claudeEvents = index.claudeEvents(key);
  const codexEntries = index.codexEntries(key);
  return JSON.stringify({
    status: reference?.status,
    claudeEvents,
    codexEntries,
  });
}

function claudeReference(tool: ToolCall): IndexedReference {
  const input = asRecord(tool.rawInput);
  const title =
    asString(input?.description) ??
    (tool.title && tool.title !== "Agent" && tool.title !== "Task" ? tool.title : undefined) ??
    asString(input?.subagent_type) ??
    "Subagent";
  return {
    key: `${CLAUDE_PREFIX}${tool.toolCallId}`,
    provider: "claude",
    id: tool.toolCallId,
    title,
    status: tool.status,
    prompt: asString(input?.prompt),
    model: asString(input?.model),
    sourceToolCallId: tool.toolCallId,
  };
}

function poolReference(tool: ToolCall): IndexedReference {
  const task = asString(asRecord(tool.rawInput)?.task);
  const title = task ? truncateInline(task, POOL_TITLE_LIMIT) : "";
  return {
    key: `${POOL_PREFIX}${tool.toolCallId}`,
    provider: "pool",
    id: tool.toolCallId,
    title: title || "Subagent",
    status: poolStatus(tool.status),
    statusSource: "tool",
    prompt: task,
    sourceToolCallId: tool.toolCallId,
  };
}

// Pool opens a subagent tool call as "pending" and leaves it there until the
// child returns its final message — it never reports "in_progress". Treat both
// as running so a long delegation does not read as "Starting" throughout.
function poolStatus(status: ToolCallStatus | undefined): string | undefined {
  if (status === undefined) return undefined;
  return status === "pending" || status === "in_progress" ? "running" : status;
}

function truncateInline(value: string, limit: number): string {
  const collapsed = value.split(/\s+/).filter(Boolean).join(" ");
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit).trimEnd()}…`;
}

function claudeParentToolUseId(event: SessionEvent): string | undefined {
  if (!("_meta" in event)) return undefined;
  return asString(asRecord(asRecord(event._meta)?.claudeCode)?.parentToolUseId);
}

function codexCandidates(
  tool: ToolCall,
  index: number,
): Array<{ reference: IndexedReference; entry: CodexSubagentEntry }> {
  const codex = asRecord(asRecord(tool._meta)?.codex);
  if (!codex) return [];

  const input = asRecord(tool.rawInput);
  const collaboration = asRecord(codex.collaboration);
  const subagent = asRecord(codex.subagent);
  const action = asString(collaboration?.tool) ?? asString(input?.tool);
  const activity = asString(subagent?.activity) ?? asString(input?.activityKind);
  const activityThreadId =
    asString(subagent?.threadId) ?? asString(input?.agentThreadId) ?? asString(input?.threadId);
  const states = asRecord(input?.agentsStates);
  const receiverIds = uniqueStrings([
    ...asStringArray(collaboration?.receiverThreadIds),
    ...asStringArray(input?.receiverThreadIds),
    ...Object.keys(states ?? {}),
    ...(activityThreadId ? [activityThreadId] : []),
  ]);
  if (receiverIds.length === 0) return [];

  const path = asPath(subagent?.path ?? input?.agentPath);
  const pathTitle = path.at(-1);
  const prompt = asString(input?.prompt);
  const model = asString(input?.model);
  const reasoningEffort = asString(input?.reasoningEffort);

  return receiverIds.map((threadId) => {
    const state = asRecord(states?.[threadId]);
    const reportedStatus = asString(state?.status);
    const inferredStatus = inferredCodexStatus(activity, action, tool.status);
    const status = reportedStatus ?? inferredStatus?.status;
    const message = asString(state?.message);
    return {
      reference: {
        key: `${CODEX_PREFIX}${threadId}`,
        provider: "codex",
        id: threadId,
        title: pathTitle ?? "Subagent",
        pathTitle,
        status,
        statusSource: reportedStatus ? "reported" : inferredStatus?.source,
        statusIndex: status ? index : undefined,
        prompt,
        model,
        reasoningEffort,
        sourceToolCallId: tool.toolCallId,
      },
      entry: {
        event: tool,
        index,
        action,
        activity,
        status: typeof status === "string" ? status : undefined,
        message,
        prompt,
      },
    };
  });
}

function mergeReference(
  existing: IndexedReference | undefined,
  next: IndexedReference,
): IndexedReference {
  if (!existing) return next;
  const status = mergedStatus(existing, next);
  return {
    ...existing,
    ...next,
    title: next.pathTitle ?? existing.pathTitle ?? existing.title,
    prompt: existing.prompt ?? next.prompt,
    model: existing.model ?? next.model,
    reasoningEffort: existing.reasoningEffort ?? next.reasoningEffort,
    status: status.value,
    statusSource: status.source,
    statusIndex: status.index,
    sourceToolCallId: existing.sourceToolCallId,
    pathTitle: next.pathTitle ?? existing.pathTitle,
  };
}

function mergedStatus(
  existing: IndexedReference,
  next: IndexedReference,
): {
  value: IndexedReference["status"];
  source: IndexedReference["statusSource"];
  index: IndexedReference["statusIndex"];
} {
  if (!next.status) {
    return {
      value: existing.status,
      source: existing.statusSource,
      index: existing.statusIndex,
    };
  }
  if (!existing.status) {
    return { value: next.status, source: next.statusSource, index: next.statusIndex };
  }

  // A started/interacted activity can follow an agentsStates.running snapshot.
  // It confirms the child is still running; it does not make that explicit
  // child state safe to settle from the parent turn's lifecycle.
  if (
    existing.statusSource === "reported" &&
    next.statusSource === "activity" &&
    subagentStatusIsRunning(existing.status) &&
    subagentStatusIsRunning(next.status)
  ) {
    return { value: next.status, source: existing.statusSource, index: next.statusIndex };
  }

  // Codex updates a collaboration tool call in place when its agentsStates
  // snapshot changes. A previously appended "started" activity therefore
  // still appears later in transcript order and must not downgrade an
  // authoritative terminal state back to running. A later reported state
  // (for example after resumeAgent) remains free to transition it again.
  if (next.statusSource === "activity" && !subagentStatusIsRunning(existing.status)) {
    return {
      value: existing.status,
      source: existing.statusSource,
      index: existing.statusIndex,
    };
  }

  return { value: next.status, source: next.statusSource, index: next.statusIndex };
}

function settleCodexReferences(
  references: Map<string, IndexedReference>,
  turns: readonly TurnMetadata[],
  options: SubagentTranscriptIndexOptions,
): void {
  const { codexTurnActive, codexActiveTurnStartIndex } = options;
  if (codexTurnActive === undefined) return;

  for (const [key, reference] of references) {
    if (
      reference.provider !== "codex" ||
      reference.statusSource === "reported" ||
      !subagentStatusIsRunning(reference.status)
    ) {
      continue;
    }
    const statusIndex = reference.statusIndex;
    const settledTurn =
      statusIndex === undefined
        ? undefined
        : turns.find((turn) => statusIndex >= turn.startIndex && statusIndex <= turn.endIndex);
    const belongsToActiveTurn =
      codexTurnActive &&
      statusIndex !== undefined &&
      codexActiveTurnStartIndex !== undefined &&
      statusIndex >= codexActiveTurnStartIndex;
    if (
      belongsToActiveTurn ||
      (!settledTurn && codexTurnActive && codexActiveTurnStartIndex === undefined)
    ) {
      continue;
    }

    references.set(key, {
      ...reference,
      status: settledTurn?.interrupted ? "interrupted" : "completed",
      statusSource: "settled",
    });
  }
}

function inferredCodexStatus(
  activity: string | undefined,
  action: string | undefined,
  toolStatus: ToolCallStatus | undefined,
): { status: string; source: "activity" | "action" | "tool" } | undefined {
  if (action && (toolStatus === "failed" || toolStatus === "cancelled")) {
    return { status: toolStatus, source: "tool" };
  }
  if (activity === "started" || activity === "interacted" || action === "resumeAgent") {
    return { status: "running", source: activity ? "activity" : "action" };
  }
  if (activity === "interrupted") return { status: "interrupted", source: "activity" };
  if (action === "closeAgent") return { status: "shutdown", source: "action" };
  return undefined;
}

function cyclicRootIds(parents: ReadonlyMap<string, string>): ReadonlySet<string> {
  const cyclic = new Set<string>();
  for (const start of parents.keys()) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = start;
    while (current && parents.has(current)) {
      const previousPosition = positions.get(current);
      if (previousPosition !== undefined) {
        for (const id of path.slice(previousPosition)) cyclic.add(id);
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = parents.get(current);
    }
  }
  return cyclic;
}

function remapTurns(
  turns: readonly TurnMetadata[],
  visibleOriginalIndices: readonly number[],
): TurnMetadata[] {
  const originalToVisible = new Map<number, number>();
  visibleOriginalIndices.forEach((original, visible) => originalToVisible.set(original, visible));
  const result: TurnMetadata[] = [];
  for (const turn of turns) {
    const visible = visibleOriginalIndices.filter(
      (index) => index >= turn.startIndex && index <= turn.endIndex,
    );
    if (visible.length === 0) continue;
    result.push({
      ...turn,
      startIndex: originalToVisible.get(visible[0]!)!,
      endIndex: originalToVisible.get(visible.at(-1)!)!,
    });
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asPath(value: unknown): string[] {
  if (typeof value === "string") return value.split("/").filter(Boolean);
  return asStringArray(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))];
}
