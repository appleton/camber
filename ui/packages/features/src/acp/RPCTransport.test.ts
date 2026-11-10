import type { AnyMessage } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_SERVER } from "./agentServers";
import { ACPDebugLog } from "./debugDump";
import type { HelperAPIClient } from "./hostRpc";
import { RPCTransport } from "./RPCTransport";

function mockHelperApiClient(): HelperAPIClient {
  return {
    jsonrpcCall: vi.fn().mockResolvedValue({ ok: true }),
    jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
  };
}

/** Drain one chunk from the readable side. */
async function readOne(transport: RPCTransport): Promise<AnyMessage> {
  const reader = transport.readable.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return value!;
}

describe("RPCTransport", () => {
  describe("writable — outbound request (method + id)", () => {
    it("forwards requests to jsonrpcCall with the camber/acp/ prefix", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      const writer = transport.writable.getWriter();
      await writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { workingDirectory: "/tmp" },
      } as AnyMessage);
      writer.releaseLock();

      expect(client.jsonrpcCall).toHaveBeenCalledWith("camber/acp/session/new", {
        agentServer: DEFAULT_AGENT_SERVER,
        workingDirectory: "/tmp",
      });
    });

    it("defaults params to {} when omitted", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      const writer = transport.writable.getWriter();
      await writer.write({ jsonrpc: "2.0", id: 2, method: "session/new" } as AnyMessage);
      writer.releaseLock();

      expect(client.jsonrpcCall).toHaveBeenCalledWith("camber/acp/session/new", {
        agentServer: DEFAULT_AGENT_SERVER,
      });
    });

    it("routes requests to the configured agent server", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client, "echo");

      const writer = transport.writable.getWriter();
      await writer.write({
        jsonrpc: "2.0",
        id: 3,
        method: "session/new",
        params: { agentServer: "wrong", workingDirectory: "/tmp" },
      } as AnyMessage);
      writer.releaseLock();

      expect(client.jsonrpcCall).toHaveBeenCalledWith("camber/acp/session/new", {
        agentServer: "echo",
        workingDirectory: "/tmp",
      });
    });

    it("injects the resolved response into the readable stream", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      const writer = transport.writable.getWriter();
      await writer.write({ jsonrpc: "2.0", id: 7, method: "session/new" } as AnyMessage);
      writer.releaseLock();

      const msg = await readOne(transport);
      expect(msg).toMatchObject({ jsonrpc: "2.0", id: 7, result: { ok: true } });
    });

    it("injects an error response when jsonrpcCall rejects", async () => {
      const client = mockHelperApiClient();
      (client.jsonrpcCall as ReturnType<typeof vi.fn>).mockRejectedValue({
        code: -32001,
        message: "upstream error",
      });
      const transport = new RPCTransport(client);

      const writer = transport.writable.getWriter();
      await writer.write({ jsonrpc: "2.0", id: 10, method: "session/new" } as AnyMessage);
      writer.releaseLock();

      const msg = await readOne(transport);
      expect(msg).toMatchObject({
        jsonrpc: "2.0",
        id: 10,
        error: { code: -32001, message: "upstream error" },
      });
    });

    it("injects an error response when jsonrpcCall throws synchronously", async () => {
      const client = mockHelperApiClient();
      (client.jsonrpcCall as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw { code: -32600, message: "invalid request" };
      });
      const transport = new RPCTransport(client);

      const writer = transport.writable.getWriter();
      await writer.write({ jsonrpc: "2.0", id: 3, method: "session/new" } as AnyMessage);
      writer.releaseLock();

      const msg = await readOne(transport);
      expect(msg).toMatchObject({ jsonrpc: "2.0", id: 3 });
      expect(msg).toHaveProperty("error", { code: -32600, message: "invalid request" });
    });

    it("wraps non-structured synchronous errors with code -32603", async () => {
      const client = mockHelperApiClient();
      (client.jsonrpcCall as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw "boom";
      });
      const transport = new RPCTransport(client);

      const writer = transport.writable.getWriter();
      await writer.write({ jsonrpc: "2.0", id: 4, method: "session/new" } as AnyMessage);
      writer.releaseLock();

      const msg = await readOne(transport);
      expect(msg).toHaveProperty("error", { code: -32603, message: "boom" });
    });
  });

  describe("writable — outbound notification (method, no id)", () => {
    it("forwards notifications to jsonrpcNotify with the camber/acp/ prefix", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      const writer = transport.writable.getWriter();
      await writer.write({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: "s1" },
      } as AnyMessage);
      writer.releaseLock();

      expect(client.jsonrpcNotify).toHaveBeenCalledWith("camber/acp/session/cancel", {
        agentServer: DEFAULT_AGENT_SERVER,
        sessionId: "s1",
      });
      expect(client.jsonrpcCall).not.toHaveBeenCalled();
    });

    it("defaults params to {} when omitted", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      const writer = transport.writable.getWriter();
      await writer.write({ jsonrpc: "2.0", method: "session/cancel" } as AnyMessage);
      writer.releaseLock();

      expect(client.jsonrpcNotify).toHaveBeenCalledWith("camber/acp/session/cancel", {
        agentServer: DEFAULT_AGENT_SERVER,
      });
    });

    it("allows a later notification to be written while a request is still in flight", async () => {
      const client = mockHelperApiClient();
      let resolveRequest!: (value: { ok: true }) => void;
      const request = new Promise<{ ok: true }>((resolve) => {
        resolveRequest = resolve;
      });
      (client.jsonrpcCall as ReturnType<typeof vi.fn>).mockReturnValue(request);
      const transport = new RPCTransport(client);

      const writer = transport.writable.getWriter();
      await writer.write({ jsonrpc: "2.0", id: 1, method: "session/prompt" } as AnyMessage);
      await writer.write({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: "s1" },
      } as AnyMessage);
      writer.releaseLock();

      expect(client.jsonrpcNotify).toHaveBeenCalledWith("camber/acp/session/cancel", {
        agentServer: DEFAULT_AGENT_SERVER,
        sessionId: "s1",
      });

      resolveRequest({ ok: true });
    });
  });

  describe("writable — response messages (no method)", () => {
    it("resolves a pending sendRequest when SDK writes a result response", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      const promise = transport.sendRequest({
        jsonrpc: "2.0",
        id: "req-1",
        method: "session/request_permission",
        params: { sessionId: "s1" },
      } as AnyMessage);

      // Simulate SDK writing a response through the writable stream.
      const writer = transport.writable.getWriter();
      await writer.write({
        jsonrpc: "2.0",
        id: "req-1",
        result: { outcome: "allowed" },
      } as AnyMessage);
      writer.releaseLock();

      await expect(promise).resolves.toEqual({ outcome: "allowed" });
      expect(client.jsonrpcCall).not.toHaveBeenCalled();
      expect(client.jsonrpcNotify).not.toHaveBeenCalled();
    });

    it("rejects a pending sendRequest when SDK writes an error response", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      const promise = transport.sendRequest({
        jsonrpc: "2.0",
        id: "req-2",
        method: "session/request_permission",
        params: {},
      } as AnyMessage);

      const writer = transport.writable.getWriter();
      await writer.write({
        jsonrpc: "2.0",
        id: "req-2",
        error: { code: -32600, message: "denied" },
      } as AnyMessage);
      writer.releaseLock();

      await expect(promise).rejects.toEqual({ code: -32600, message: "denied" });
    });

    it("does not forward response messages to helper", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      // No pending request — response is still silently consumed.
      const writer = transport.writable.getWriter();
      await writer.write({ jsonrpc: "2.0", id: 99, result: {} } as AnyMessage);
      writer.releaseLock();

      expect(client.jsonrpcCall).not.toHaveBeenCalled();
      expect(client.jsonrpcNotify).not.toHaveBeenCalled();
    });
  });

  describe("sendRequest", () => {
    it("injects the request into the readable stream", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      transport.sendRequest({
        jsonrpc: "2.0",
        id: "req-3",
        method: "session/request_permission",
        params: { sessionId: "s1" },
      } as AnyMessage);

      const received = await readOne(transport);
      expect(received).toMatchObject({
        jsonrpc: "2.0",
        id: "req-3",
        method: "session/request_permission",
      });

      // Clean up: resolve the pending promise.
      const writer = transport.writable.getWriter();
      await writer.write({ jsonrpc: "2.0", id: "req-3", result: {} } as AnyMessage);
      writer.releaseLock();
    });

    it("throws if message has no id", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      await expect(
        transport.sendRequest({ jsonrpc: "2.0", method: "foo" } as AnyMessage),
      ).rejects.toThrow("sendRequest requires a message with an id");
    });
  });

  describe("receive — inbound messages", () => {
    it("enqueues messages onto the readable stream", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      const msg: AnyMessage = {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1" },
      };
      transport.receive(msg);

      const received = await readOne(transport);
      expect(received).toEqual(msg);
    });

    it("throws when jsonrpc field is missing", () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      const msg = { method: "session/update", params: {} } as unknown as AnyMessage;
      expect(() => transport.receive(msg)).toThrow("missing jsonrpc version field");
    });

    it("preserves an existing jsonrpc field", async () => {
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client);

      const msg: AnyMessage = { jsonrpc: "2.0", method: "session/update", params: {} };
      transport.receive(msg);

      const received = await readOne(transport);
      expect(received).toHaveProperty("jsonrpc", "2.0");
    });
  });

  describe("ACP debug dump", () => {
    it("records Pool-compatible outgoing requests and incoming responses", async () => {
      const agentServer = "debug-dump-agent";
      const debugLog = new ACPDebugLog();
      debugLog.setSessionCollecting(agentServer, "s1", true);
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client, agentServer, debugLog);

      const writer = transport.writable.getWriter();
      await writer.write({
        jsonrpc: "2.0",
        id: 42,
        method: "session/prompt",
        params: { sessionId: "s1", prompt: [] },
      } as AnyMessage);
      writer.releaseLock();
      await readOne(transport);

      expect(debugLog.dump(agentServer)).toEqual([
        {
          _direction: "outgoing",
          _type: "request",
          id: 42,
          method: "session/prompt",
          params: { sessionId: "s1", prompt: [] },
        },
        {
          _direction: "incoming",
          _type: "response",
          id: 42,
          method: "session/prompt",
          params: { ok: true },
        },
      ]);
    });

    it("correlates incoming agent requests with outgoing client responses", async () => {
      const agentServer = "debug-permission-agent";
      const debugLog = new ACPDebugLog();
      debugLog.setSessionCollecting(agentServer, "s1", true);
      const client = mockHelperApiClient();
      const transport = new RPCTransport(client, agentServer, debugLog);

      const promise = transport.sendRequest({
        jsonrpc: "2.0",
        id: "permission-1",
        method: "session/request_permission",
        params: { sessionId: "s1" },
      } as AnyMessage);

      const writer = transport.writable.getWriter();
      await writer.write({
        jsonrpc: "2.0",
        id: "permission-1",
        result: { outcome: "allowed" },
      } as AnyMessage);
      writer.releaseLock();
      await promise;

      expect(debugLog.dump(agentServer)).toEqual([
        {
          _direction: "incoming",
          _type: "request",
          id: "permission-1",
          method: "session/request_permission",
          params: { sessionId: "s1" },
        },
        {
          _direction: "outgoing",
          _type: "response",
          id: "permission-1",
          method: "session/request_permission",
          params: { outcome: "allowed" },
        },
      ]);
    });
  });
});
