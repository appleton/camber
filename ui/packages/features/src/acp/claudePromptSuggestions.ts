import { normalizeAgentServerName } from "./agentServers";

export const CLAUDE_AGENT_SERVER = "claude-acp";
export const CLAUDE_SDK_MESSAGE_METHOD = "_claude/sdkMessage";

export interface ACPPromptSuggestion {
  id: string | null;
  sessionId: string;
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseClaudePromptSuggestion(
  params: Record<string, unknown>,
): ACPPromptSuggestion | null {
  const sessionId = params.sessionId;
  const message = asRecord(params.message);
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    message?.type !== "prompt_suggestion" ||
    typeof message.suggestion !== "string" ||
    message.suggestion.trim().length === 0
  ) {
    return null;
  }

  return {
    id: typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : null,
    sessionId,
    text: message.suggestion,
  };
}

/** Enable the narrowly scoped Claude SDK events that Camber understands. */
export function withClaudeSessionFeatures(
  agentServer: string,
  meta?: Record<string, unknown>,
  isClaude = normalizeAgentServerName(agentServer) === CLAUDE_AGENT_SERVER,
): Record<string, unknown> | undefined {
  if (!isClaude) return meta;
  return enableClaudeSessionFeatures(meta);
}

export function enableClaudeSessionFeatures(
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  const claudeCode = asRecord(meta?.claudeCode) ?? {};
  const options = asRecord(claudeCode.options) ?? {};
  const rawMessages = Array.isArray(claudeCode.emitRawSDKMessages)
    ? claudeCode.emitRawSDKMessages
    : [];
  const emitsPromptSuggestion = rawMessages.some(
    (entry) => asRecord(entry)?.type === "prompt_suggestion",
  );
  const emitsActiveGoal = rawMessages.some((entry) => asRecord(entry)?.type === "active_goal");

  const requiredRawMessages = [
    ...(emitsPromptSuggestion ? [] : [{ type: "prompt_suggestion" }]),
    ...(emitsActiveGoal ? [] : [{ type: "active_goal" }]),
  ];

  return {
    ...meta,
    claudeCode: {
      ...claudeCode,
      options: {
        ...options,
        promptSuggestions: true,
      },
      emitRawSDKMessages: [...rawMessages, ...requiredRawMessages],
    },
  };
}

/** Add client context to Claude's system prompt without replacing its built-in prompt. */
export function withClaudeAppendSystemPrompt(
  meta: Record<string, unknown> | undefined,
  systemPrompt: string,
): Record<string, unknown> | undefined {
  if (systemPrompt.trim().length === 0) return meta;

  const claudeCode = asRecord(meta?.claudeCode) ?? {};
  const options = asRecord(claudeCode.options) ?? {};
  const existing =
    typeof options.appendSystemPrompt === "string" && options.appendSystemPrompt.trim().length > 0
      ? options.appendSystemPrompt
      : null;

  return {
    ...meta,
    claudeCode: {
      ...claudeCode,
      options: {
        ...options,
        appendSystemPrompt: existing ? `${existing}\n\n${systemPrompt}` : systemPrompt,
      },
    },
  };
}

/** @deprecated Use withClaudeSessionFeatures. */
export const withClaudePromptSuggestions = withClaudeSessionFeatures;

/** @deprecated Use enableClaudeSessionFeatures. */
export const enableClaudePromptSuggestions = enableClaudeSessionFeatures;
