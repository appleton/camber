import { beforeEach, describe, expect, test, vi } from "vitest";
import { Assistant, AssistantState } from "./assistant";

interface MockWebviewView {
  visible: boolean;
  badge?: { value: number; tooltip: string };
  show: ReturnType<typeof vi.fn>;
  onDidDispose: ReturnType<typeof vi.fn>;
  onDidChangeVisibility: ReturnType<typeof vi.fn>;
  webview: {
    options: Record<string, unknown>;
    html: string;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
  };
  dispose: () => void;
}

const { executeCommand } = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: {
    executeCommand,
  },
}));

vi.mock("../rpc/client", () => ({
  createRpcClient: vi.fn(() => ({
    setConfiguration: vi.fn(),
  })),
}));

vi.mock("../rpc/server", () => ({
  HostRPCServer: vi.fn().mockImplementation(() => ({
    route: vi.fn(),
  })),
}));

vi.mock("../configuration", () => ({
  getCamberConfig: vi.fn(() => ({ uri: "" })),
}));

vi.mock("../context", () => ({
  sendActiveFileContext: vi.fn(),
}));

vi.mock("./getWebviewHtml", () => ({
  getWebviewHtml: vi.fn(async () => "<html></html>"),
}));

function createAssistant(): Assistant {
  const assistant = new Assistant({
    telemetry: {
      log: vi.fn(),
    },
    decorationProvider: {
      deleteAllInserts: vi.fn(),
    },
    acpChatPanels: {
      setConfiguration: vi.fn(),
    },
    context: {
      globalStorageUri: {
        fsPath: "/user/globalStorage/appleton.camber-assistant",
      },
    },
  } as any);
  assistant.mark(AssistantState.READY);
  return assistant;
}

function createWebviewView(visible: boolean): MockWebviewView {
  const disposeListeners: Array<() => void> = [];

  return {
    visible,
    show: vi.fn(),
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
    webview: {
      options: {},
      html: "",
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
    dispose: () => {
      for (const listener of disposeListeners) listener();
    },
  };
}

describe("Assistant", () => {
  beforeEach(() => {
    executeCommand.mockReset();
    executeCommand.mockResolvedValue(undefined);
  });

  test("showSidebar focuses the Camber view", async () => {
    const assistant = createAssistant();

    await assistant.showSidebar();

    expect(executeCommand).toHaveBeenCalledExactlyOnceWith("camber-webview.focus");
  });

  test("resolveWebviewView clears extension state when disposed", async () => {
    const assistant = createAssistant();
    const webviewView = createWebviewView(true);

    await assistant.resolveWebviewView(webviewView as any);

    webviewView.dispose();

    expect(assistant.webviewView).toBeUndefined();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test("updates the conversation attention badge count", async () => {
    const assistant = createAssistant();
    const webviewView = createWebviewView(true);
    await assistant.resolveWebviewView(webviewView as any);

    assistant.updateAttentionCount([
      attentionConversation("conversation:waiting", { waitingForUser: true }),
      attentionConversation("conversation:unread", { unread: true }),
      attentionConversation("conversation:working", { working: true }),
    ]);

    expect(webviewView.badge).toEqual({
      value: 2,
      tooltip: "2 conversations need attention",
    });
  });

  test("uses singular grammar for one conversation attention badge", async () => {
    const assistant = createAssistant();
    const webviewView = createWebviewView(true);
    await assistant.resolveWebviewView(webviewView as any);

    assistant.updateAttentionCount([
      attentionConversation("conversation:unread", { unread: true }),
    ]);

    expect(webviewView.badge).toEqual({
      value: 1,
      tooltip: "1 conversation needs attention",
    });
  });

  test("clears the conversation attention badge with a zero badge", async () => {
    const assistant = createAssistant();
    const webviewView = createWebviewView(true);
    await assistant.resolveWebviewView(webviewView as any);

    assistant.updateAttentionCount([
      attentionConversation("conversation:unread", { unread: true }),
    ]);
    assistant.updateAttentionCount(null);

    expect(webviewView.badge).toEqual({ value: 0, tooltip: "" });
  });
});

function attentionConversation(
  id: string,
  liveStatus: { working?: boolean; waitingForUser?: boolean; unread?: boolean },
) {
  return {
    id,
    active: true,
    archived: false,
    liveStatus: {
      working: liveStatus.working ?? false,
      waitingForUser: liveStatus.waitingForUser ?? false,
      unread: liveStatus.unread ?? false,
    },
  } as any;
}
