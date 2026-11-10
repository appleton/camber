import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AcpChatPanels } from "./acpChatPanels";

interface MockPanel {
  active: boolean;
  title: string;
  iconPath: unknown;
  reveal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  onDidDispose: ReturnType<typeof vi.fn>;
  onDidChangeViewState: ReturnType<typeof vi.fn>;
  webview: {
    options: Record<string, unknown>;
    html: string;
    postMessage: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
  };
}

const { createdPanels, createMockPanel, sendRequest, writtenFiles } = vi.hoisted(() => {
  const createdPanels: MockPanel[] = [];
  const sendRequest = vi.fn();
  const writtenFiles = new Map<string, string>();

  function createMockPanel(): MockPanel {
    const disposeListeners: Array<() => void> = [];
    const panel: MockPanel = {
      active: false,
      title: "",
      iconPath: undefined,
      reveal: vi.fn(),
      dispose: vi.fn(() => {
        for (const listener of disposeListeners) listener();
      }),
      onDidDispose: vi.fn((listener: () => void) => {
        disposeListeners.push(listener);
        return { dispose: vi.fn() };
      }),
      onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
      webview: {
        options: {},
        html: "",
        postMessage: vi.fn(async () => true),
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
      },
    };
    return panel;
  }

  return { createdPanels, createMockPanel, sendRequest, writtenFiles };
});

vi.mock("vscode", () => ({
  ViewColumn: { Active: 1 },
  Uri: {
    parse(value: string) {
      return { fsPath: value, path: value, toString: () => value };
    },
    file(value: string) {
      return { fsPath: value, path: value, scheme: "file", toString: () => `file:${value}` };
    },
    joinPath(
      base: { fsPath?: string; path?: string; scheme?: string; toString: () => string },
      ...paths: string[]
    ) {
      const basePath = base.fsPath ?? base.path ?? base.toString();
      const joined = [basePath.replace(/\/$/, ""), ...paths].join("/");
      return {
        fsPath: joined,
        path: joined,
        scheme: base.scheme,
        toString: () => (base.scheme === "file" ? `file:${joined}` : joined),
      };
    },
  },
  workspace: {
    fs: {
      createDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async (uri: { fsPath?: string; path?: string }, bytes: Uint8Array) => {
        writtenFiles.set(uri.fsPath ?? uri.path ?? "", new TextDecoder().decode(bytes));
      }),
    },
  },
  window: {
    createWebviewPanel: vi.fn(() => {
      const panel = createMockPanel();
      createdPanels.push(panel);
      return panel;
    }),
  },
}));

vi.mock("./getWebviewHtml", () => ({
  getWebviewHtml: vi.fn(async (_system, webview, _view, variables) => {
    (webview as any).initialState = variables.find(
      (variable: { key: string }) => variable.key === "CAMBER_INITIAL_ACP_CHAT_STATE",
    )?.value;
    return "<html></html>";
  }),
}));

vi.mock("../helper", () => ({
  getHelperSingleton: vi.fn(async () => ({ sendRequest })),
}));

vi.mock("../rpc/server", () => ({
  HostRPCServer: vi.fn().mockImplementation(() => ({
    route: vi.fn(),
  })),
}));

function createPanels(): AcpChatPanels {
  return new AcpChatPanels({
    context: {
      asAbsolutePath: (path: string) => path,
      globalStorageUri: { fsPath: "/global-storage", path: "/global-storage" },
    },
    telemetry: { reportError: vi.fn() },
    // The sidebar broadcast (acpActiveAgentDidChange) runs whenever a panel is
    // bound/focused; provide a minimal assistant so it no-ops in tests.
    assistant: {
      runWhenReady: (fn: () => void) => fn(),
      rpc: { acpActiveAgentDidChange: vi.fn() },
    },
  } as any);
}

describe("AcpChatPanels", () => {
  beforeEach(() => {
    createdPanels.length = 0;
    writtenFiles.clear();
    sendRequest.mockReset();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("focusInput opens a pending chat and focuses when ready", async () => {
    const panels = createPanels();

    await panels.focusInput();

    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0].webview.postMessage).not.toHaveBeenCalled();
    const initialState = initialACPChatState(createdPanels[0]);

    expect(initialState.kind).toBe("pending");
    expect(initialState.conversationId).toMatch(/^conversation:/);

    panels.panelReady(initialState.conversationId);

    expect(createdPanels[0].reveal).toHaveBeenCalledOnce();
    expect(createdPanels[0].webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "focusInput",
        payload: [],
      }),
    );
  });

  test("focusInput reveals and focuses the most recently viewed open chat", async () => {
    const panels = createPanels();

    vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
    await panels.openSession({
      conversationId: "conversation:older",
      agentServer: "camber",
      sessionId: "older",
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    await panels.openSession({
      conversationId: "conversation:newer",
      agentServer: "camber",
      sessionId: "newer",
    });

    await panels.focusInput();

    expect(createdPanels[0].reveal).not.toHaveBeenCalled();
    expect(createdPanels[0].webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "focusInput" }),
    );
    expect(createdPanels[1].reveal).toHaveBeenCalledOnce();
    expect(createdPanels[1].webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "focusInput",
        payload: [],
      }),
    );
  });

  test("reuses an open pending panel instead of creating another", async () => {
    const panels = createPanels();

    await panels.openSession({});
    expect(createdPanels).toHaveLength(1);
    expect(initialACPChatState(createdPanels[0]).kind).toBe("pending");

    await panels.openSession({});

    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0].reveal).toHaveBeenCalledOnce();
    expect(createdPanels[0].webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: "focusInput", payload: [] }),
    );
  });

  test("opens a new panel when every open chat has a session", async () => {
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:live",
      agentServer: "camber",
      sessionId: "session-live",
    });
    await panels.openSession({});

    expect(createdPanels).toHaveLength(2);
    expect(initialACPChatState(createdPanels[1]).kind).toBe("pending");
  });

  test("opens a new panel once the pending panel gains a session", async () => {
    const panels = createPanels();

    await panels.openSession({});
    const initialState = initialACPChatState(createdPanels[0]);
    panels.attachSessionId(initialState.conversationId, "camber", "session-created");

    await panels.openSession({});

    expect(createdPanels).toHaveLength(2);
  });

  test("uses conversation id, not session id, as the panel key", async () => {
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:stable",
      agentServer: "camber",
      sessionId: "session-1",
    });
    await panels.openSession({
      conversationId: "conversation:stable",
      agentServer: "camber",
      sessionId: "session-2",
    });

    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0].reveal).toHaveBeenCalledOnce();
  });

  test("reveals the existing panel when opened by session id without a conversation id", async () => {
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:existing",
      agentServer: "camber",
      sessionId: "session-1",
    });
    await panels.openSession({
      agentServer: "camber",
      sessionId: "session-1",
    });

    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0].reveal).toHaveBeenCalledOnce();
  });

  test("attachSessionId keeps the panel keyed by conversation id", async () => {
    const panels = createPanels();

    await panels.openSession({ conversationId: "conversation:pending" });
    panels.attachSessionId("conversation:pending", "camber", "session-created");
    await panels.openSession({
      conversationId: "conversation:pending",
      agentServer: "camber",
      sessionId: "session-created",
    });

    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0].reveal).toHaveBeenCalledOnce();
  });

  test("uses the agent icon URL for a non-camber tab icon", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => svgResponse(`<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>`)),
    );
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:codex",
      agentServer: "codex-acp",
      sessionId: "session-codex",
      agentName: "Codex CLI",
      agentIconUrl: "https://example.com/codex.svg",
      sessionTitle: "Implement dynamic icons",
    });

    await vi.waitFor(() => expect(writtenFiles.size).toBe(8));

    expect(createdPanels[0].title).toBe("Implement dynamic icons");
    const iconPath = createdPanels[0].iconPath as { dark: { toString(): string } };
    expect(iconPath.dark.toString()).toContain("file:/global-storage/acp-tab-icons/");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(Array.from(writtenFiles.values()).join("\n")).toContain(`circle cx="12.5"`);
  });

  test("ignores plaintext HTTP agent icon URLs", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:http-icon",
      agentServer: "gemini",
      sessionId: "session-http-icon",
      agentIconUrl: "http://example.com/gemini.svg",
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(writtenFiles.size).toBe(0);
    expect(
      (createdPanels[0].iconPath as { dark: { toString(): string } }).dark.toString(),
    ).toContain("./dist/resources/icon-light.svg");
  });

  test("updates a pending panel icon when agent metadata changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        svgResponse(`<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>`),
      ),
    );
    const panels = createPanels();

    await panels.openSession({ conversationId: "conversation:pending" });
    panels.updatePanelMetadata("conversation:pending", {
      agentServer: "gemini",
      agentName: "Gemini",
      agentIconUrl: "https://example.com/gemini.svg",
    });

    await vi.waitFor(() => expect(writtenFiles.size).toBe(8));

    expect(createdPanels[0].title).toBe("Camber Chat");
    expect(
      (createdPanels[0].iconPath as { dark: { toString(): string } }).dark.toString(),
    ).toContain("file:/global-storage/acp-tab-icons/");
  });

  test("keeps a generated agent icon on repeated metadata updates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        svgResponse(`<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>`),
      ),
    );
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:stable-icon",
      agentServer: "gemini",
      sessionId: "session-stable-icon",
      agentIconUrl: "https://example.com/gemini.svg",
    });
    await vi.waitFor(() => expect(writtenFiles.size).toBe(8));

    const generatedIconPath = createdPanels[0].iconPath;
    panels.updatePanelMetadata("conversation:stable-icon", {
      agentServer: "gemini",
      agentIconUrl: "https://example.com/gemini.svg",
    });

    expect(createdPanels[0].iconPath).toBe(generatedIconPath);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("keeps a generated agent icon when reopening without icon metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        svgResponse(`<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>`),
      ),
    );
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:reopen-icon",
      agentServer: "gemini",
      sessionId: "session-reopen-icon",
      agentIconUrl: "https://example.com/gemini.svg",
    });
    await vi.waitFor(() => expect(writtenFiles.size).toBe(8));

    const generatedIconPath = createdPanels[0].iconPath;
    await panels.openSession({
      conversationId: "conversation:reopen-icon",
      agentServer: "gemini",
      sessionId: "session-reopen-icon",
    });

    expect(createdPanels).toHaveLength(1);
    expect(createdPanels[0].reveal).toHaveBeenCalledOnce();
    expect(createdPanels[0].iconPath).toBe(generatedIconPath);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("does not let a stale in-flight icon overwrite a cached agent icon", async () => {
    let resolveSlowIcon: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://example.com/slow.svg") {
          return new Promise<Response>((resolve) => {
            resolveSlowIcon = resolve;
          });
        }
        return Promise.resolve(
          svgResponse(`<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>`),
        );
      }),
    );
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:stale-icon",
      agentServer: "gemini",
      sessionId: "session-stale-icon",
      agentIconUrl: "https://example.com/cached.svg",
    });
    await vi.waitFor(() => expect(writtenFiles.size).toBe(8));

    const cachedIconPath = createdPanels[0].iconPath;
    panels.updatePanelMetadata("conversation:stale-icon", {
      agentServer: "gemini",
      agentIconUrl: "https://example.com/slow.svg",
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));

    panels.updatePanelMetadata("conversation:stale-icon", {
      agentServer: "gemini",
      agentIconUrl: "https://example.com/cached.svg",
    });
    expect(createdPanels[0].iconPath).toBe(cachedIconPath);

    resolveSlowIcon(svgResponse(`<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>`));
    await vi.waitFor(() => expect(writtenFiles.size).toBe(16));

    expect(createdPanels[0].iconPath).toBe(cachedIconPath);
  });

  test("togglePlanModeOnActivePanel posts to the active panel", async () => {
    const panels = createPanels();

    await panels.openSession({ conversationId: "conversation:a" });
    await panels.openSession({ conversationId: "conversation:b" });
    createdPanels[0].active = false;
    createdPanels[1].active = true;

    panels.togglePlanModeOnActivePanel();

    expect(createdPanels[1].webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: "togglePlanMode", payload: [] }),
    );
    expect(createdPanels[0].webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "togglePlanMode" }),
    );
  });

  test("togglePlanModeOnActivePanel does nothing when no panel is active", async () => {
    const panels = createPanels();

    await panels.openSession({ conversationId: "conversation:a" });
    createdPanels[0].active = false;

    panels.togglePlanModeOnActivePanel();

    expect(createdPanels[0].webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "togglePlanMode" }),
    );
  });

  test("broadcasts agent server exits to panels with stale agent metadata", async () => {
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:camber",
      agentServer: "camber",
      sessionId: "session-camber",
    });
    await panels.openSession({
      conversationId: "conversation:claude",
      agentServer: "claude-acp",
      sessionId: "session-claude",
    });

    await panels.routeInbound("camber/acp/serverDidExit", {
      agentServer: "claude-acp",
      error: "exit status 1",
    });

    for (const panel of createdPanels) {
      expect(panel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "acpAgentServerDidExit",
          payload: [{ agentServer: "claude-acp", error: "exit status 1" }],
        }),
      );
    }
  });

  // A panel that misses an agent exit keeps prompting the restarted agent
  // with a stale sessionId and every approval gets denied (PE-2362), so
  // failed deliveries are replayed once the webview reports ready.
  test("replays agent server exit on panelReady when initial delivery failed", async () => {
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:camber",
      agentServer: "camber",
      sessionId: "session-camber",
    });
    const panel = createdPanels[0];
    panel.webview.postMessage.mockResolvedValueOnce(false);

    await panels.routeInbound("camber/acp/serverDidExit", { agentServer: "camber" });
    // let the postMessage(false) promise settle so the replay is queued
    await Promise.resolve();
    await Promise.resolve();

    panel.webview.postMessage.mockClear();
    panels.panelReady("conversation:camber");

    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "acpAgentServerDidExit",
        payload: [{ agentServer: "camber" }],
      }),
    );

    // a second panelReady must not deliver the exit twice
    panel.webview.postMessage.mockClear();
    panels.panelReady("conversation:camber");
    expect(panel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "acpAgentServerDidExit" }),
    );
  });

  // After an agent restart the webview re-binds its session via session/load;
  // HostRPCServer.jsonrpc writes that through via attachSessionId. A
  // session-keyed request (e.g. session/request_permission) for the re-bound
  // session must reach the panel instead of throwing "No ACP chat panel is
  // open" (PE-2362).
  test("routes session-keyed requests after attachSessionId rebinds the session", async () => {
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:rebound",
      agentServer: "camber",
      sessionId: "session-old",
    });
    const panel = createdPanels[0];
    panels.attachSessionId("conversation:rebound", "camber", "session-new");

    panel.webview.postMessage.mockClear();
    const request = panels.routeInbound("camber/jsonrpc/request", {
      agentServer: "camber",
      message: {
        jsonrpc: "2.0",
        id: "req-1",
        method: "session/request_permission",
        params: { sessionId: "session-new" },
      },
    });

    await vi.waitFor(() => {
      expect(panel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: "jsonrpcRequest" }),
      );
    });

    // resolve the pending request through the webview response listener so
    // the routed promise settles
    const posted = panel.webview.postMessage.mock.calls.find(
      ([msg]: [{ command: string }]) => msg.command === "jsonrpcRequest",
    )![0] as { requestId: string };
    const listener = panel.webview.onDidReceiveMessage.mock.calls.at(-1)![0] as (
      event: unknown,
    ) => void;
    listener({ payload: { requestId: posted.requestId, response: { ok: true } } });
    await expect(request).resolves.toEqual({ ok: true });
  });

  // Repeated failed deliveries keep only the latest replay: the webview
  // handling is idempotent and only needs to learn the agent went away.
  test("a later missed exit replaces the queued replay", async () => {
    const panels = createPanels();

    await panels.openSession({
      conversationId: "conversation:camber",
      agentServer: "camber",
      sessionId: "session-camber",
    });
    const panel = createdPanels[0];

    panel.webview.postMessage.mockResolvedValueOnce(false);
    await panels.routeInbound("camber/acp/serverDidExit", { agentServer: "camber" });
    panel.webview.postMessage.mockResolvedValueOnce(false);
    await panels.routeInbound("camber/acp/serverDidExit", {
      agentServer: "camber",
      error: "exit status 1",
    });
    await Promise.resolve();
    await Promise.resolve();

    panel.webview.postMessage.mockClear();
    panels.panelReady("conversation:camber");

    const exitCalls = panel.webview.postMessage.mock.calls.filter(
      ([msg]: [{ command: string }]) => msg.command === "acpAgentServerDidExit",
    );
    expect(exitCalls).toHaveLength(1);
    expect(exitCalls[0][0]).toEqual(
      expect.objectContaining({
        payload: [{ agentServer: "camber", error: "exit status 1" }],
      }),
    );
  });
});

function initialACPChatState(panel: MockPanel): { kind: string; conversationId: string } {
  return (panel.webview as any).initialState;
}

function svgResponse(svg: string): Response {
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
    },
  });
}
