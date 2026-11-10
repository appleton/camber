window.CAMBER_INITIAL_STATE = {
  environment: {
    assistantHost: "vscode",
    assistantEnv: "test",
    assistantHostVersion: "fixture",
    assistantVersion: "0.0.0",
    operatingSystem: "darwin",
    capabilities: { header: true, fileContext: true },
  },
  isHelperSupported: true,
  isAgenticMode: true,
  defaultCwd: "/fixture",
  homeDirectory: "/fixture",
  workspaces: [{ path: "/fixture", name: "Performance fixture", index: 0 }],
};
window.riveUri = "resources/roundel-spinner.riv";
window.riveThinUri = "resources/roundel-spinner-thin.riv";
window.logoUri = "resources/camber-logo.glb";
window.logoFaceUri = "resources/camber-logo-face.glb";
window.__b4 = { requests: [], errors: [], start: performance.now() };
window.addEventListener("error", (e) => window.__b4.errors.push(String(e.error ?? e.message)));
window.addEventListener("unhandledrejection", (e) => window.__b4.errors.push(String(e.reason)));
const originalFetch = window.fetch.bind(window);
window.fetch = (url, options) =>
  /^https?:/.test(String(url)) && !String(url).startsWith(location.origin)
    ? Promise.resolve(
        new Response(JSON.stringify({ agents: [] }), {
          headers: { "content-type": "application/json" },
        }),
      )
    : originalFetch(url, options);
let state;
window.acquireVsCodeApi = () => ({
  getState: () => state,
  setState: (value) => (state = value),
  postMessage(message) {
    window.__b4.requests.push({ command: message.command, payload: message.payload });
    if (!message.requestId) return;
    let result = {};
    if (message.command === "jsonrpc") {
      const [method, params] = message.payload;
      if (method === "camber/acpNav/list")
        result = {
          projects: [],
          conversations: [
            {
              id: "fixture-conversation",
              agentServer: "poolside",
              active: true,
              archived: false,
              cwd: "/fixture",
              workspacePath: "/fixture",
              workingDirectories: ["/fixture"],
              title: "Review performance",
              updatedAt: "2026-09-07T10:00:00Z",
            },
          ],
        };
      else if (method === "camber/acpNav/listAgentServers") result = { agentServers: {} };
      else if (method === "camber/acp/initialize")
        result = {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
          agentInfo: { name: "poolside", version: "fixture" },
        };
      else if (method === "camber/acp/session/new") result = { sessionId: "fixture-session" };
      else if (method.includes("approvals/list")) result = { approvals: [] };
    }
    queueMicrotask(() =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { requestId: message.requestId, payload: result } }),
      ),
    );
  },
});
new MutationObserver(() => {
  if (!window.__b4.mountedMs && document.querySelector("#app button"))
    window.__b4.mountedMs = performance.now() - window.__b4.start;
}).observe(document.getElementById("app"), { childList: true, subtree: true });
