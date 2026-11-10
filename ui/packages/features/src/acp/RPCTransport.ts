import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { DEFAULT_AGENT_SERVER, normalizeAgentServerName } from "./agentServers";
import type { ACPDebugLog } from "./debugDump";
import { toErrorResponse } from "./errors";
import type { HelperAPIClient } from "./hostRpc";

export interface ACPTransport {
  receive(msg: unknown): void;
  sendRequest(msg: unknown): Promise<unknown>;
  disconnect?(agentServer?: string): void;
}

/**
 * RPCTransport bridges the ACP SDK's Stream interface to the existing
 * helper ↔ vscode extension ↔ webview JSON-RPC channel.
 *
 * Outbound (writable): ACP SDK writes JSON-RPC 2.0 messages here.
 *   - Requests (have `method` + `id`): forwarded to the Go helper via
 *     `jsonrpcCall`, and the LSP response is injected back into the
 *     readable stream so the SDK can match it by `id`.
 *   - Notifications (have `method`, no `id`): fire-and-forget via
 *     `jsonrpcNotify`.
 *
 * Inbound (readable): messages from the Go helper arrive via `receive()`
 *   and are enqueued for the ACP SDK's Connection to process.
 */
export class RPCTransport implements Stream, ACPTransport {
  writable: WritableStream<AnyMessage>;
  readable: ReadableStream<AnyMessage>;
  private readableCtl?: ReadableStreamDefaultController<AnyMessage>;
  private readonly agentServer: string;
  private pendingRequests = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();

  constructor(
    helperApiClient: HelperAPIClient,
    agentServer = DEFAULT_AGENT_SERVER,
    private readonly debugLog?: ACPDebugLog,
  ) {
    this.agentServer = normalizeAgentServerName(agentServer);
    const transport = this;

    this.writable = new WritableStream({
      async write(msg: AnyMessage) {
        transport.debugLog?.record(transport.agentServer, "outgoing", msg);
        if (!("method" in msg) && "id" in msg && msg.id != null) {
          // Response from SDK (e.g. after handling requestPermission) —
          // resolve the pending promise so it flows back to the caller.
          const pending = transport.pendingRequests.get(msg.id);
          if (pending) {
            transport.pendingRequests.delete(msg.id);
            if ("error" in msg) {
              pending.reject(msg.error);
            } else {
              pending.resolve((msg as any).result);
            }
          }
          return;
        }
        if ("method" in msg && "id" in msg) {
          // Outbound ACP request — route to the Go helper and feed the
          // response back into the readable stream for the SDK to resolve.
          // The helper call is intentionally detached so long-lived requests
          // like session/prompt do not block later writes such as cancel.
          const method = `camber/acp/${msg.method}`;
          const params = transport.withAgentServer(msg.params ?? {});
          void Promise.resolve()
            .then(() => helperApiClient.jsonrpcCall(method, params))
            .then((result) => {
              transport.receive({ jsonrpc: "2.0", id: msg.id, result } as AnyMessage);
            })
            .catch((error) => {
              transport.receive({ jsonrpc: "2.0", id: msg.id, error: toErrorResponse(error) });
            });
        } else if ("method" in msg) {
          // Outbound ACP notification — fire and forget.
          helperApiClient.jsonrpcNotify(
            `camber/acp/${msg.method}`,
            transport.withAgentServer(msg.params ?? {}),
          );
        }
      },
    });

    this.readable = new ReadableStream({
      start: (controller) => {
        this.readableCtl = controller;
      },
    });
  }

  /**
   * Inject a message from the Go helper (via the extension bridge) into the
   * ACP SDK's readable stream.
   */
  receive(msg: unknown) {
    if (!this.readableCtl) {
      throw new Error("transport: message received before stream initialization");
    }
    if (!msg || typeof msg !== "object") {
      throw new Error("transport: invalid message");
    }
    // Ensure the jsonrpc field is present — intermediate layers may strip it.
    if (!("jsonrpc" in msg)) {
      throw new Error("transport: missing jsonrpc version field");
    }
    this.debugLog?.record(this.agentServer, "incoming", msg);
    this.readableCtl.enqueue(msg as AnyMessage);
  }

  /**
   * Inject an inbound JSON-RPC request into the SDK and wait for the SDK to
   * write the response back through the writable stream.
   */
  async sendRequest(msg: unknown): Promise<unknown> {
    if (!msg || typeof msg !== "object") {
      throw new Error("transport: sendRequest requires a JSON-RPC message");
    }
    const id = (msg as any).id;
    if (id == null) {
      throw new Error("transport: sendRequest requires a message with an id");
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
    this.receive(msg);
    return promise;
  }

  private withAgentServer(params: unknown): object {
    if (params && typeof params === "object" && !Array.isArray(params)) {
      return { ...(params as Record<string, unknown>), agentServer: this.agentServer };
    }

    return { agentServer: this.agentServer };
  }
}
