import type { AssistantMessage } from "@camber/rpc/assistant";
import { describe, type Mock, type MockInstance } from "vitest";
import {
  SET_CURRENT_CONVERSATION_EVENT,
  type WebViewRPCResponseSender,
  WebviewRPCServer,
} from "./server";

describe("client", () => {
  let server: WebviewRPCServer;
  let addEventListener: Mock;
  let removeEventListener: Mock;
  let send: MockInstance<WebViewRPCResponseSender>;
  let acpTransport: { receive: Mock };
  let localInferenceRepo: { applyDidChange: Mock };
  let assistantTerminals: {
    terminalDidOpen: Mock;
    terminalDidUpdate: Mock;
    terminalDidWrite: Mock;
    terminalDidExit: Mock;
    terminalDidClose: Mock;
  };

  beforeEach(async () => {
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    acpTransport = { receive: vi.fn() };
    localInferenceRepo = { applyDidChange: vi.fn() };
    assistantTerminals = {
      terminalDidOpen: vi.fn(),
      terminalDidUpdate: vi.fn(),
      terminalDidWrite: vi.fn(),
      terminalDidExit: vi.fn(),
      terminalDidClose: vi.fn(),
    };

    server = new WebviewRPCServer(
      { addEventListener, removeEventListener },
      (_command, _payload) => {}, // We intercept calls for the test
      {} as any, // appState
      {} as any, // elicitationRepo
      acpTransport as any,
      {} as any, // contextRepo
      assistantTerminals,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      localInferenceRepo as any,
    );

    send = vi.spyOn(server, "sendMessage");
  });

  describe(".constructor", () => {
    it("sets up an event listener", () => {
      expect(addEventListener).toHaveBeenCalledWith("message", expect.anything());
    });
  });

  describe(".dispose", () => {
    it("removes the listener", () => {
      const handler = addEventListener.mock.calls[0][1];
      server.dispose();
      expect(removeEventListener).toHaveBeenCalledWith("message", handler);
    });
  });

  describe(".route", () => {
    it("ignores host notifications forged by an embedded frame", async () => {
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      try {
        expect(iframe.contentWindow).not.toBeNull();
        await server.route({
          source: iframe.contentWindow,
          data: {
            command: "localInferenceDidChange",
            payload: [
              {
                state: {
                  modelsDirectory: "/tmp/models",
                  catalog: [],
                  runtime: { supported: true, status: "stopped", agentServer: "local" },
                },
              },
            ],
            requestId: "forged",
          },
        });
        expect(localInferenceRepo.applyDidChange).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      } finally {
        iframe.remove();
      }
    });

    it("skips when no handler is configured", async () => {
      await server.route({ data: {} } as MessageEvent<AssistantMessage>);
      expect(send).not.toHaveBeenCalled();
    });

    it("applies local inference notifications to the injected repository", async () => {
      const params = {
        state: {
          modelsDirectory: "/tmp/models",
          catalog: [],
          runtime: {
            supported: true,
            status: "stopped",
            agentServer: "local",
          },
        },
      };

      await server.route({
        data: {
          command: "localInferenceDidChange",
          payload: [params],
          requestId: "local-inference",
        },
      });

      expect(localInferenceRepo.applyDidChange).toHaveBeenCalledWith(params);
      expect(send).toHaveBeenCalledWith("localInferenceDidChange", {
        requestId: "local-inference",
        response: undefined,
      });
    });

    it("routes terminal metadata updates to the injected terminal repository", async () => {
      const update = {
        terminalId: "terminal-1",
        title: "npm test",
        cwd: "/repo/packages/features",
      };

      await server.route({
        data: {
          command: "assistantTerminalDidUpdate",
          payload: [update],
          requestId: "terminal-update-1",
        },
      });

      expect(assistantTerminals.terminalDidUpdate).toHaveBeenCalledWith(update);
      expect(send).toHaveBeenCalledWith("assistantTerminalDidUpdate", {
        requestId: "terminal-update-1",
      });
    });

    it("broadcasts a host conversation selection as a window event", async () => {
      const received: CustomEvent[] = [];
      const listener = (event: Event) => received.push(event as CustomEvent);
      window.addEventListener(SET_CURRENT_CONVERSATION_EVENT, listener);
      try {
        await server.route({
          data: {
            command: "setCurrentConversation",
            payload: ["conversation-9"],
            requestId: "set-current-conversation-1",
          },
        });
      } finally {
        window.removeEventListener(SET_CURRENT_CONVERSATION_EVENT, listener);
      }

      expect(received).toHaveLength(1);
      expect(received[0].detail).toEqual({ conversationId: "conversation-9" });
    });

    it("delivers an ACP notification batch in order through one RPC request", async () => {
      const notifications = [
        { jsonrpc: "2.0", method: "session/update", params: { value: 1 } },
        { jsonrpc: "2.0", method: "session/update", params: { value: 2 } },
      ];

      await server.route({
        data: {
          command: "jsonrpcNotifyBatch",
          payload: [notifications],
          requestId: "notification-batch-1",
        },
      });

      expect(acpTransport.receive.mock.calls).toEqual(
        notifications.map((notification) => [notification]),
      );
      expect(send).toHaveBeenCalledWith("jsonrpcNotifyBatch", {
        requestId: "notification-batch-1",
        response: { applied: 2 },
      });
    });

    it("reports the applied prefix when an ACP notification fails mid-batch", async () => {
      const notifications = [
        { jsonrpc: "2.0", method: "session/update", params: { value: 1 } },
        { jsonrpc: "2.0", method: "session/update", params: { value: 2 } },
        { jsonrpc: "2.0", method: "session/update", params: { value: 3 } },
      ];
      acpTransport.receive
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error("transport is not initialized");
        });

      await server.route({
        data: {
          command: "jsonrpcNotifyBatch",
          payload: [notifications],
          requestId: "notification-batch-partial",
        },
      });

      expect(acpTransport.receive.mock.calls).toEqual(
        notifications.slice(0, 2).map((notification) => [notification]),
      );
      expect(send).toHaveBeenCalledWith("jsonrpcNotifyBatch", {
        requestId: "notification-batch-partial",
        response: {
          applied: 1,
          error: "transport is not initialized",
        },
      });
    });
  });
});
