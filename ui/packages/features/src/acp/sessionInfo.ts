import type { SessionId, SessionInfo, SessionInfoUpdate } from "@agentclientprotocol/sdk";

const SOURCE_META_KEY = "camber/source";
const READ_ONLY_META_KEY = "camber/read_only";
const CONVERSATION_ID_META_KEY = "camber/conversation_id";
const CONVERSATION_KIND_META_KEY = "camber/conversation_kind";
const ERROR_MESSAGE_META_KEY = "camber/error_message";
const CANCELLATION_REASON_META_KEY = "camber/cancellation_reason";
const AGENT_ID_META_KEY = "camber/agent_id";

export type ACPSessionSource = "native_session" | "conversation" | "unknown";

export type ACPConversationKind = "legacy" | "agentic" | null;

// ACP session state reaches the UI from three places with slightly different shapes:
// list/load responses, partial session_info_update notifications, and local seed state created
// before the server has sent any updates. Projecting them once here keeps the rest of the UI on a
// single null-safe shape and hides protocol metadata parsing behind one boundary.
export interface ACPResolvedSessionInfo {
  sessionId: SessionId;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  source: ACPSessionSource;
  readOnly: boolean;
  errorMessage: string | null;
  cancellationReason: string | null;
  conversationId: string | null;
  conversationKind: ACPConversationKind;
  agentId: string | null;
  _meta: Record<string, unknown>;
}

type ACPMetaCarrier = {
  _meta?: Record<string, unknown> | null;
};

type ACPResolvedSessionMetadata = Pick<
  ACPResolvedSessionInfo,
  | "source"
  | "readOnly"
  | "errorMessage"
  | "cancellationReason"
  | "conversationId"
  | "conversationKind"
  | "agentId"
  | "_meta"
>;

export function buildSessionInfo(
  sessionId: SessionId,
  cwd: string,
  source: ACPSessionSource = "unknown",
): ACPResolvedSessionInfo {
  return {
    sessionId,
    cwd,
    title: null,
    updatedAt: null,
    ...resolveMetadata(
      {},
      {
        source,
        readOnly: source === "conversation",
        errorMessage: null,
        cancellationReason: null,
        conversationId: null,
        conversationKind: null,
        agentId: null,
      },
    ),
  };
}

export function normalizeSessionInfo(info: SessionInfo): ACPResolvedSessionInfo {
  return {
    sessionId: info.sessionId,
    cwd: info.cwd,
    title: info.title ?? null,
    updatedAt: info.updatedAt ?? null,
    ...resolveMetadata(info),
  };
}

export function applySessionInfoUpdate(
  current: ACPResolvedSessionInfo | null,
  sessionId: SessionId,
  update: SessionInfoUpdate,
): ACPResolvedSessionInfo {
  const base = current ?? buildSessionInfo(sessionId, "/");

  return {
    sessionId,
    cwd: base.cwd,
    title: update.title === undefined ? base.title : (update.title ?? null),
    updatedAt: update.updatedAt === undefined ? base.updatedAt : (update.updatedAt ?? null),
    ...resolveMetadata(
      { _meta: { ...base._meta, ...(update._meta ?? {}) } },
      {
        source: base.source,
        readOnly: base.readOnly,
        errorMessage: base.errorMessage,
        cancellationReason: base.cancellationReason,
        conversationId: base.conversationId,
        conversationKind: base.conversationKind,
        agentId: base.agentId,
      },
    ),
  };
}

export function mergeSeedSessionInfo(
  sessionId: SessionId,
  cwd: string,
  seed: Partial<ACPResolvedSessionInfo> | undefined,
): ACPResolvedSessionInfo {
  const base = buildSessionInfo(sessionId, cwd, seed?.source ?? "unknown");
  return {
    ...base,
    ...seed,
    sessionId,
    cwd: seed?.cwd ?? cwd,
    title: seed?.title ?? null,
    updatedAt: seed?.updatedAt ?? null,
    readOnly: seed?.readOnly ?? base.readOnly,
    errorMessage: seed?.errorMessage ?? base.errorMessage,
    cancellationReason: seed?.cancellationReason ?? base.cancellationReason,
    conversationId: seed?.conversationId ?? base.conversationId,
    conversationKind: seed?.conversationKind ?? base.conversationKind,
    agentId: seed?.agentId ?? base.agentId,
    _meta: seed?._meta ?? base._meta,
  };
}

function resolveMetadata(
  value: ACPMetaCarrier,
  fallback: Omit<ACPResolvedSessionMetadata, "_meta"> = {
    source: "unknown",
    readOnly: false,
    errorMessage: null,
    cancellationReason: null,
    conversationId: null,
    conversationKind: null,
    agentId: null,
  },
): ACPResolvedSessionMetadata {
  const _meta = { ...(value._meta ?? {}) };

  return {
    source: normalizeSource(_meta[SOURCE_META_KEY], fallback.source),
    readOnly:
      typeof _meta[READ_ONLY_META_KEY] === "boolean"
        ? _meta[READ_ONLY_META_KEY]
        : fallback.readOnly,
    errorMessage:
      typeof _meta[ERROR_MESSAGE_META_KEY] === "string"
        ? _meta[ERROR_MESSAGE_META_KEY]
        : fallback.errorMessage,
    cancellationReason:
      typeof _meta[CANCELLATION_REASON_META_KEY] === "string"
        ? _meta[CANCELLATION_REASON_META_KEY]
        : fallback.cancellationReason,
    conversationId:
      typeof _meta[CONVERSATION_ID_META_KEY] === "string"
        ? _meta[CONVERSATION_ID_META_KEY]
        : fallback.conversationId,
    conversationKind: normalizeConversationKind(
      _meta[CONVERSATION_KIND_META_KEY],
      fallback.conversationKind,
    ),
    agentId:
      typeof _meta[AGENT_ID_META_KEY] === "string" ? _meta[AGENT_ID_META_KEY] : fallback.agentId,
    _meta,
  };
}

function normalizeSource(value: unknown, fallback: ACPSessionSource = "unknown"): ACPSessionSource {
  if (value === "native_session" || value === "conversation") {
    return value;
  }
  return fallback;
}

function normalizeConversationKind(
  value: unknown,
  fallback: ACPConversationKind = null,
): ACPConversationKind {
  if (value === "legacy" || value === "agentic") {
    return value;
  }
  return fallback;
}
