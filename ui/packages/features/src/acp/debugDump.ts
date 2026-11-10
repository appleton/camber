import { DEFAULT_AGENT_SERVER, normalizeAgentServerName } from "./agentServers";
import type { ACPSession } from "./features/Session.svelte";

export const ACP_DEBUG_DUMP_LOADED_EVENT = "acp:debug-dump-loaded";

export interface ACPDebugDumpLoadedEventDetail {
  agentServer: string;
  conversationId: string;
  sessionId: string | null;
}

export interface ACPDumpEntry {
  _direction: "incoming" | "outgoing";
  _type: "request" | "response" | "notification";
  id?: unknown;
  method?: string;
  params?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface ACPDebugCaptureState {
  /**
   * Always false: capture has no global default, only per-session overrides.
   * Kept so existing consumers that fall back to this field keep working;
   * see `ACPDebugCaptureAPI` for why there is no global setter.
   */
  collecting: boolean;
  /** Conversations opted into capture before their agent session exists. */
  pendingConversations: ReadonlyArray<{ agentServer: string; conversationId: string }>;
  /** Per-session capture overrides. */
  sessions: ReadonlyArray<{ agentServer: string; sessionId: string; collecting: boolean }>;
}

/**
 * Capture is opt-in per conversation (see `ACPLogCaptureConfirmation.svelte`
 * and `acpLogCapture.ts`). A conversation can opt in before its agent session
 * exists; that pending opt-in is promoted to the session returned by
 * `session/new`. There is deliberately no global on/off switch here.
 */
export interface ACPDebugCaptureAPI {
  state(): ACPDebugCaptureState;
  subscribe(listener: (state: ACPDebugCaptureState) => void): () => void;
  /** Set collection for a conversation, including before its session exists. */
  setConversationCollecting(
    agentServer: string,
    conversationId: string,
    sessionId: string | null,
    enabled: boolean,
  ): void;
  /** Stop collection when a conversation is archived or otherwise closed. */
  resetConversationCollecting(
    agentServer: string,
    conversationId: string,
    sessionId: string | null,
  ): void;
  /** Effective collection state for a conversation before or after session creation. */
  isConversationCollecting(
    agentServer: string,
    conversationId: string,
    sessionId: string | null,
  ): boolean;
  /** Promote a pending conversation opt-in once its agent session is created. */
  bindConversationSession(agentServer: string, conversationId: string, sessionId: string): void;
  /** Override collection for one session. */
  setSessionCollecting(agentServer: string, sessionId: string, enabled: boolean): void;
  /** Stop collection for a session when it is archived or otherwise closed. */
  resetSessionCollecting(agentServer: string, sessionId: string): void;
  /** Effective collection state for a session (frames without a known session are never collected). */
  isCollecting(agentServer: string, sessionId: string | null): boolean;
}

type StoredDebugLog = {
  entries: Array<ACPDumpEntry | undefined>;
  estimatedBytes: number;
  entryBytes: number[];
  startIndex: number;
};

// When capture is enabled, bound the retained trajectory independently per
// connected agent so incremental streamed chunks cannot grow it forever.
export const MAX_ACP_DEBUG_LOG_BYTES_PER_AGENT = 32 * 1024 * 1024;
// Requests are correlated with their responses regardless of capture state
// (see `record()`), so this map can grow even while nothing is being
// collected. Bound it per agent and evict the oldest entries once full,
// independent of the byte-capped `messages` buffer above.
export const MAX_ACP_DEBUG_CORRELATIONS_PER_AGENT = 4_096;
const ESTIMATED_ENTRY_OVERHEAD_BYTES = 256;

export class ACPDebugLog {
  private messages = new Map<string, StoredDebugLog>();
  private methods = new Map<
    string,
    Map<string, { method: string; sessionId: string | null; conversationId: string | null }>
  >();
  // Collection is opt-in: nothing is retained until the user enables it per
  // conversation or session, and this in-memory state resets on app restart.
  private pendingConversationCollecting = new Set<string>();
  private sessionCollecting = new Map<string, boolean>();
  private captureListeners = new Set<(state: ACPDebugCaptureState) => void>();
  private entryListeners = new Set<(agentServer: string) => void>();

  constructor(
    private readonly maxBytesPerAgent = MAX_ACP_DEBUG_LOG_BYTES_PER_AGENT,
    private readonly maxCorrelationsPerAgent = MAX_ACP_DEBUG_CORRELATIONS_PER_AGENT,
  ) {}

  captureState(): ACPDebugCaptureState {
    return {
      collecting: false,
      pendingConversations: Array.from(this.pendingConversationCollecting, (key) =>
        splitPendingConversationCollectingKey(key),
      ),
      sessions: Array.from(this.sessionCollecting, ([key, collecting]) => ({
        ...splitSessionCollectingKey(key),
        collecting,
      })),
    };
  }

  subscribeCapture(listener: (state: ACPDebugCaptureState) => void): () => void {
    this.captureListeners.add(listener);
    listener(this.captureState());
    return () => this.captureListeners.delete(listener);
  }

  subscribeEntries(listener: (agentServer: string) => void): () => void {
    this.entryListeners.add(listener);
    return () => this.entryListeners.delete(listener);
  }

  setConversationCollecting(
    agentServer: string,
    conversationId: string,
    sessionId: string | null,
    enabled: boolean,
  ): void {
    if (sessionId !== null) {
      this.setSessionCollecting(agentServer, sessionId, enabled);
      return;
    }

    const key = pendingConversationCollectingKey(agentServer, conversationId);
    const changed = enabled
      ? !this.pendingConversationCollecting.has(key)
      : this.pendingConversationCollecting.has(key);
    if (!changed) return;
    if (enabled) {
      this.pendingConversationCollecting.add(key);
    } else {
      this.pendingConversationCollecting.delete(key);
    }
    this.emitCaptureState();
  }

  resetConversationCollecting(
    agentServer: string,
    conversationId: string,
    sessionId: string | null,
  ): void {
    this.setConversationCollecting(agentServer, conversationId, sessionId, false);
  }

  isConversationCollecting(
    agentServer: string,
    conversationId: string,
    sessionId: string | null,
  ): boolean {
    if (sessionId !== null) return this.isCollecting(agentServer, sessionId);
    return this.pendingConversationCollecting.has(
      pendingConversationCollectingKey(agentServer, conversationId),
    );
  }

  bindConversationSession(agentServer: string, conversationId: string, sessionId: string): void {
    this.promotePendingConversation(agentServer, conversationId, sessionId);
  }

  setSessionCollecting(agentServer: string, sessionId: string, enabled: boolean): void {
    const key = sessionCollectingKey(agentServer, sessionId);
    if (this.sessionCollecting.get(key) === enabled) return;
    this.sessionCollecting.set(key, enabled);
    this.emitCaptureState();
  }

  resetSessionCollecting(agentServer: string, sessionId: string): void {
    const key = sessionCollectingKey(agentServer, sessionId);
    if (this.sessionCollecting.get(key) === false) return;
    this.sessionCollecting.set(key, false);
    this.emitCaptureState();
  }

  isCollecting(agentServer: string, sessionId: string | null): boolean {
    // Frames without a known session (startup/handshake traffic, or a
    // response whose correlated request fell out of the correlation cap)
    // have nothing to scope collection to, so they are never collected.
    if (sessionId === null) return false;
    return this.sessionCollecting.get(sessionCollectingKey(agentServer, sessionId)) ?? false;
  }

  record(agentServer: string, direction: "incoming" | "outgoing", raw: unknown): void {
    if (!raw || typeof raw !== "object") return;

    const server = normalizeAgentServerName(agentServer);
    const msg = raw as Record<string, unknown>;
    const id = msg.id;
    const method = typeof msg.method === "string" ? msg.method : undefined;

    let type: ACPDumpEntry["_type"];
    let correlatedMethod: string | undefined;
    if (id != null && method) {
      type = "request";
      const sessionId = rawSessionId(msg);
      const conversationId = method === "session/new" ? rawConversationId(msg) : null;
      // Correlate even while paused so responses that arrive after collection
      // resumes still get a method name. Cap the map so an agent that never
      // gets responses (or never has capture turned on) cannot grow it
      // forever; evict the oldest entry first (Map iteration order is
      // insertion order, so this is a cheap FIFO).
      const correlations = this.methodMap(server);
      if (correlations.size >= this.maxCorrelationsPerAgent) {
        const oldestKey = correlations.keys().next().value;
        if (oldestKey !== undefined) correlations.delete(oldestKey);
      }
      correlations.set(requestCorrelationKey(direction, id), {
        method,
        sessionId,
        conversationId,
      });
      if (!this.shouldCollect(server, sessionId, conversationId)) return;
    } else if (id != null) {
      type = "response";
      const methodMap = this.methods.get(server);
      const correlationKey = requestCorrelationKey(oppositeDirection(direction), id);
      const correlated = methodMap?.get(correlationKey);
      correlatedMethod = correlated?.method;
      methodMap?.delete(correlationKey);
      const responseSessionId =
        correlatedMethod === "session/new"
          ? rawResultSessionId(msg)
          : (correlated?.sessionId ?? null);
      if (responseSessionId !== null && correlated?.conversationId) {
        this.bindConversationSession(server, correlated.conversationId, responseSessionId);
      }
      if (!this.shouldCollect(server, responseSessionId, correlated?.conversationId ?? null)) {
        return;
      }
    } else {
      type = "notification";
      if (!this.shouldCollect(server, rawSessionId(msg), null)) return;
    }

    const entry: ACPDumpEntry = {
      ...msg,
      _direction: direction,
      _type: type,
    };
    delete entry.jsonrpc;

    if (type === "response") {
      if (correlatedMethod) entry.method = correlatedMethod;
      if ("result" in entry) {
        entry.params = entry.result;
        delete entry.result;
      }
    }

    this.storeEntry(server, entry);
  }

  dump(agentServer = DEFAULT_AGENT_SERVER): ACPDumpEntry[] {
    const log = this.messages.get(normalizeAgentServerName(agentServer));
    const entries =
      log?.entries
        .slice(log.startIndex)
        .filter((entry): entry is ACPDumpEntry => entry !== undefined) ?? [];
    return JSON.parse(JSON.stringify(entries)) as ACPDumpEntry[];
  }

  clear(agentServer = DEFAULT_AGENT_SERVER): void {
    const server = normalizeAgentServerName(agentServer);
    this.messages.delete(server);
    this.methods.delete(server);
    this.emitEntries(server);
  }

  /**
   * Drop pending request/response correlation state for an agent, e.g. when
   * its connection is torn down. Captured messages are left intact so the
   * user can still dump what was collected before the disconnect.
   */
  clearCorrelations(agentServer: string): void {
    this.methods.delete(normalizeAgentServerName(agentServer));
  }

  replace(agentServer: string, entries: ACPDumpEntry[]): void {
    const server = normalizeAgentServerName(agentServer);
    this.messages.delete(server);
    for (const entry of entries) {
      // Avoid cloning a loaded frame that will be discarded immediately.
      if (estimatedEntryBytes(entry) > this.maxBytesPerAgent) continue;
      this.storeEntry(server, JSON.parse(JSON.stringify(entry)) as ACPDumpEntry);
    }
    this.methods.delete(server);
  }

  private storeEntry(server: string, entry: ACPDumpEntry): void {
    const entryBytes = estimatedEntryBytes(entry);
    // An individual frame larger than the whole budget cannot be retained.
    if (entryBytes > this.maxBytesPerAgent) return;

    const log = this.messages.get(server) ?? {
      entries: [],
      estimatedBytes: 0,
      entryBytes: [],
      startIndex: 0,
    };
    log.entries.push(entry);
    log.entryBytes.push(entryBytes);
    log.estimatedBytes += entryBytes;

    while (log.estimatedBytes > this.maxBytesPerAgent) {
      log.estimatedBytes -= log.entryBytes[log.startIndex] ?? 0;
      // Release the evicted payload immediately without shifting a potentially
      // large array for every subsequent streamed chunk.
      log.entries[log.startIndex] = undefined;
      log.entryBytes[log.startIndex] = 0;
      log.startIndex++;
    }

    // Keep queue bookkeeping bounded too. This runs rarely and only copies
    // live entries; the steady-state eviction path above remains O(1).
    if (log.startIndex >= 1024 && log.startIndex * 2 >= log.entries.length) {
      log.entries = log.entries.slice(log.startIndex);
      log.entryBytes = log.entryBytes.slice(log.startIndex);
      log.startIndex = 0;
    }
    this.messages.set(server, log);
    this.emitEntries(server);
  }

  private methodMap(
    agentServer: string,
  ): Map<string, { method: string; sessionId: string | null; conversationId: string | null }> {
    const existing = this.methods.get(agentServer);
    if (existing) return existing;
    const next = new Map<
      string,
      { method: string; sessionId: string | null; conversationId: string | null }
    >();
    this.methods.set(agentServer, next);
    return next;
  }

  private shouldCollect(
    agentServer: string,
    sessionId: string | null,
    conversationId: string | null,
  ): boolean {
    if (sessionId !== null && this.isCollecting(agentServer, sessionId)) return true;
    if (conversationId !== null) {
      return this.pendingConversationCollecting.has(
        pendingConversationCollectingKey(agentServer, conversationId),
      );
    }
    if (sessionId !== null) return false;
    const prefix = `${normalizeAgentServerName(agentServer)}\0`;
    for (const key of this.pendingConversationCollecting) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private promotePendingConversation(
    agentServer: string,
    conversationId: string,
    sessionId: string,
  ): void {
    const pendingKey = pendingConversationCollectingKey(agentServer, conversationId);
    if (!this.pendingConversationCollecting.delete(pendingKey)) return;
    this.sessionCollecting.set(sessionCollectingKey(agentServer, sessionId), true);
    this.emitCaptureState();
  }

  private emitCaptureState(): void {
    const state = this.captureState();
    for (const listener of this.captureListeners) listener(state);
  }

  private emitEntries(server: string): void {
    for (const listener of this.entryListeners) listener(server);
  }
}

function estimatedEntryBytes(entry: ACPDumpEntry): number {
  try {
    // JSON payloads dominate these objects. Account for UTF-16 storage plus a
    // conservative fixed allowance for object/array bookkeeping.
    return JSON.stringify(entry).length * 2 + ESTIMATED_ENTRY_OVERHEAD_BYTES;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function rawSessionId(message: Record<string, unknown>): string | null {
  const params = message.params as { sessionId?: unknown } | undefined | null;
  return typeof params?.sessionId === "string" && params.sessionId.length > 0
    ? params.sessionId
    : null;
}

function rawResultSessionId(message: Record<string, unknown>): string | null {
  const result = message.result as { sessionId?: unknown } | undefined | null;
  return typeof result?.sessionId === "string" && result.sessionId.length > 0
    ? result.sessionId
    : null;
}

function rawConversationId(message: Record<string, unknown>): string | null {
  const params = message.params as { _meta?: unknown } | undefined | null;
  if (!params?._meta || typeof params._meta !== "object") return null;
  const conversationId = (params._meta as Record<string, unknown>)["camber/conversation_id"];
  return typeof conversationId === "string" && conversationId.length > 0 ? conversationId : null;
}

function pendingConversationCollectingKey(agentServer: string, conversationId: string): string {
  return `${normalizeAgentServerName(agentServer)}\0${conversationId}`;
}

function splitPendingConversationCollectingKey(key: string): {
  agentServer: string;
  conversationId: string;
} {
  const separator = key.indexOf("\0");
  return {
    agentServer: key.slice(0, separator),
    conversationId: key.slice(separator + 1),
  };
}

function sessionCollectingKey(agentServer: string, sessionId: string): string {
  return `${normalizeAgentServerName(agentServer)}\0${sessionId}`;
}

function splitSessionCollectingKey(key: string): { agentServer: string; sessionId: string } {
  const separator = key.indexOf("\0");
  return {
    agentServer: key.slice(0, separator),
    sessionId: key.slice(separator + 1),
  };
}

function requestCorrelationKey(direction: "incoming" | "outgoing", id: unknown): string {
  return `${direction}\0${JSON.stringify(id)}`;
}

function oppositeDirection(direction: "incoming" | "outgoing"): "incoming" | "outgoing" {
  return direction === "incoming" ? "outgoing" : "incoming";
}

export interface ACPDebugAPI {
  capture: ACPDebugCaptureAPI;
  subscribeEntries(listener: (agentServer: string) => void): () => void;
  dump(agentServer?: string): ACPDumpEntry[];
  dumpJSON(agentServer?: string): string;
  clear(agentServer?: string): void;
  load(entries: ACPDumpEntry[] | string, agentServer?: string): Promise<void>;
  restartServer(agentServer?: string): Promise<void>;
}

export function debugDumpLoadedDetail(session: ACPSession): ACPDebugDumpLoadedEventDetail {
  return {
    agentServer: session.agentServer,
    conversationId: session.conversationId,
    sessionId: session.sessionId,
  };
}

export function normalizeDumpEntries(input: unknown): ACPDumpEntry[] {
  if (!Array.isArray(input)) {
    throw new Error("ACP dump must be a JSON array");
  }
  return input as ACPDumpEntry[];
}
