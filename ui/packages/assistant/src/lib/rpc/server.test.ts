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
  let acpProjectRepo: { replaceProjects: Mock };
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
    acpProjectRepo = { replaceProjects: vi.fn() };
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
      acpProjectRepo as any,
      { replaceConversations: vi.fn() } as any,
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
            command: "acpNavDidChange",
            payload: [{ state: { projects: [], conversations: [] } }],
            requestId: "forged",
          },
        });
        expect(acpProjectRepo.replaceProjects).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      } finally {
        iframe.remove();
      }
    });

    it("skips when no handler is configured", async () => {
      await server.route({ data: {} } as MessageEvent<AssistantMessage>);
      expect(send).not.toHaveBeenCalled();
    });

    it("hands agent server store changes to the runtime's subscribers", async () => {
      const { onACPAgentServersDidChange } = await import("@camber/features/acp");
      const listener = vi.fn();
      const stop = onACPAgentServersDidChange(listener);
      try {
        await server.route({
          data: { command: "acpAgentServersDidChange", payload: [], requestId: "agent-servers" },
        });
      } finally {
        stop();
      }
      expect(listener).toHaveBeenCalledTimes(1);
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

    it("removes a project for the desktop app request and reports missing repositories", async () => {
      await server.route({
        data: { command: "removeProject", payload: ["/repo"], requestId: "remove-1" },
      });
      expect(send).toHaveBeenCalledWith("removeProject", {
        requestId: "remove-1",
        error: expect.objectContaining({ message: "This window cannot remove projects" }),
      });

      const order: string[] = [];
      const desktop = new WebviewRPCServer(
        { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        () => {},
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        undefined,
        undefined,
        { removeProject: async (path: string) => void order.push(`remove:${path}`) } as any,
        { refresh: async () => void order.push("refresh") } as any,
        { closeProject: async (path: string) => void order.push(`close:${path}`) },
      );
      const desktopSend = vi.spyOn(desktop, "sendMessage");
      await desktop.route({
        data: { command: "removeProject", payload: ["/repo"], requestId: "remove-2" },
      });
      expect(order).toEqual(["remove:/repo", "close:/repo", "refresh"]);
      expect(desktopSend).toHaveBeenCalledWith("removeProject", {
        requestId: "remove-2",
        response: undefined,
      });
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
