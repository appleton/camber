// RemoteHost implements the webview host RPC surface over the helper's remote
// access WebSocket. It plays the role DesktopHost/the VS Code extension play
// on those surfaces: outbound host requests funnel into `handleHostRequest`,
// inbound helper traffic is delivered to the shared WebviewRPCServer, which
// subscribes through `webviewRpcListener` (the runtime prop those surfaces
// leave defaulted to `window`). Responses come back through
// `webviewResponseHandler`. Nothing goes through global window events, so the
// RPC server never sees unrelated window "message" traffic (browser
// extensions, iframes) and helper messages never leak to other listeners.

import { webviewCommandForHelperNotification } from "@camber/rpc/assistant";

import { recoverSession, type SessionRecovery } from "./deviceSession";
import { SessionStreamGate, type StaleSession } from "./sessionStreamGate";
import { CONNECTION_LOST_MESSAGE, WsRpc, type WsRpcStatus } from "./wsRpc";

// Structurally identical to @camber/assistant's WebviewRPCListener runtime
// prop (Pick<Window, ...>); declared here so this transport package does not
// depend on the whole assistant UI package for one type alias.
export type WebviewRPCListener = Pick<Window, "addEventListener" | "removeEventListener">;

type WebviewResponsePayload = {
  requestId: string;
  response?: unknown;
  error?: { message: string; code?: unknown; data?: unknown };
};

type PendingWebviewCall = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

// The helper-side remote terminal tab, shaped like the shared UI's
// AssistantTerminalTab so it can be handed straight to the terminal repo.
type RemoteTerminalTab = {
  id: string;
  title: string;
  cwd: string;
  worktreePath: string;
  createdAt: string;
  exitCode?: number;
};

type RemoteTerminalAttachResult = {
  terminalId: string;
  alive: boolean;
  data?: string;
  seq?: number;
  truncated?: boolean;
  exitCode?: number;
};

export type { WsRpcStatus as ConnectionStatus, StaleSession };

// Helper notifications whose surfaces the mobile shell deliberately does not
// render. They still fan out to this client (the hub broadcasts everything),
// but forwarding them would only feed webview stores nothing reads. Remove an
// entry when mobile grows that surface; notifications NOT listed here forward
// by default via the shared table.
const UNRENDERED_ON_MOBILE = new Set(["camber/localInference/didChange"]);

export interface RemoteHostCallbacks {
  onStatusChange?: (status: WsRpcStatus) => void;
  // A file open requested by the shared UI (file chips, tool cards, markdown
  // links). The mobile app pushes its file viewer screen; without a handler
  // the request is dropped, matching the old stubbed behavior.
  onOpenFile?: (path: string, line?: number, column?: number) => void;
  // The persisted device token itself was rejected (device revoked): only
  // re-pairing can fix this. Plain session-cookie expiry never reaches here —
  // it is recovered silently with the device token.
  onAuthExpired?: () => void;
  // Fired after the socket reopens following a real disconnect, once
  // /api/me re-confirmed the session and camber/remote/resume replayed the
  // missed live events. staleSessions are the ones the helper could NOT
  // resume (helper restart, buffer evicted): their in-memory transcripts may
  // be missing messages and must be re-loaded. The conversation list should
  // be refreshed either way.
  onReconnected?: (staleSessions: StaleSession[]) => void;
  // Fired when a session's live stream broke while connected (an event gap
  // that never filled, or a helper restart detected mid-stream). Same
  // remediation as a failed resume: re-load the session.
  onStaleSessions?: (staleSessions: StaleSession[]) => void;
}

export class RemoteHost {
  #rpc: WsRpc;
  #webviewReady: Promise<void>;
  #resolveWebviewReady!: () => void;
  #webviewListeners = new Set<EventListenerOrEventListenerObject>();
  #pendingWebviewCalls = new Map<string, PendingWebviewCall>();
  #callbacks: RemoteHostCallbacks;
  #everOpened = false;
  #probing = false;
  #deviceId: string | null = null;
  #gate: SessionStreamGate;
  #openWaiters: (() => void)[] = [];
  #recovering: Promise<SessionRecovery> | null = null;
  #authExpiredFired = false;
  // Live helper-side terminals this client is subscribed to. lastSeq is the
  // absolute output byte offset already forwarded to the webview, used to
  // dedupe live events against an attach backfill after a reconnect.
  #terminals = new Map<string, { lastSeq: number }>();

  constructor(callbacks: RemoteHostCallbacks = {}) {
    this.#callbacks = callbacks;
    this.#gate = new SessionStreamGate({
      onStale: (session) => this.#callbacks.onStaleSessions?.([session]),
      ownDeviceId: () => this.#deviceId,
    });
    this.#webviewReady = new Promise((resolve) => {
      this.#resolveWebviewReady = resolve;
    });
    this.#rpc = new WsRpc({
      resolveUrl: () => this.#resolveWsUrl(),
      onNotification: (method, params) => this.#dispatchHelperNotification(method, params),
      onRequest: (method, params) => this.#dispatchHelperRequest(method, params),
      onStatusChange: (status) => this.#handleStatusChange(status),
    });
    this.#installLifecycleListeners();
    void this.#loadDeviceId();
  }

  async #loadDeviceId(): Promise<void> {
    if (this.#deviceId !== null) return;
    try {
      const resp = await fetch("/api/me", { credentials: "same-origin" });
      if (!resp.ok) return;
      const body = (await resp.json()) as { deviceId?: string };
      if (typeof body.deviceId === "string") this.#deviceId = body.deviceId;
    } catch {
      // Next reconnect's /api/me check retries; until then no own-echo drops
      // happen, which is safe (we cannot have prompted yet).
    }
  }

  #handleStatusChange(status: WsRpcStatus) {
    this.#callbacks.onStatusChange?.(status);
    if (status !== "open") return;
    const waiters = this.#openWaiters;
    this.#openWaiters = [];
    for (const resolve of waiters) resolve();
    if (!this.#everOpened) {
      this.#everOpened = true;
      return;
    }
    void this.#resyncAfterReconnect();
  }

  // iOS kills background sockets (often without a close event), so treat every
  // return-to-foreground signal as a reason to check the connection.
  #installLifecycleListeners() {
    const kick = () => this.#ensureLiveConnection();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") kick();
    });
    window.addEventListener("pageshow", kick);
    window.addEventListener("online", kick);
  }

  #ensureLiveConnection() {
    if (!this.#rpc.isOpen) {
      this.#rpc.ensureConnected();
      return;
    }
    // The socket claims to be open, but after backgrounding it may be a
    // zombie. Probe with the helper's ping endpoint; no reply means the
    // socket is dead — drop it so the reconnect path takes over.
    if (this.#probing) return;
    this.#probing = true;
    const probe = this.#rpc.call("camber/hello", { ping: "keepalive" });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 4000),
    );
    void Promise.race([probe, timeout])
      .catch(() => this.#rpc.forceReconnect())
      .finally(() => {
        this.#probing = false;
      });
  }

  // Re-establish the session with the stored device token, single-flight so
  // parallel 401s (ticket fetch + resync) share one attempt. Fires
  // onAuthExpired (once) only when the device token itself is rejected.
  async #recoverAuth(): Promise<SessionRecovery> {
    this.#recovering ??= recoverSession().finally(() => {
      this.#recovering = null;
    });
    const recovery = await this.#recovering;
    if (recovery.status === "recovered") {
      if (recovery.deviceId !== null) this.#deviceId = recovery.deviceId;
    } else if (recovery.status === "unauthorized" && !this.#authExpiredFired) {
      this.#authExpiredFired = true;
      this.#callbacks.onAuthExpired?.();
    }
    return recovery;
  }

  async #resyncAfterReconnect() {
    // Re-check auth first: the session cookie may have expired (helper
    // restart, 12h TTL) while we were offline. An expired cookie recovers in
    // place with the device token — never with a page reload, which would
    // throw away the transcript and cursors over a routine Tailscale blip.
    try {
      const resp = await fetch("/api/me", { credentials: "same-origin" });
      if (resp.status === 401 || resp.status === 403) {
        if ((await this.#recoverAuth()).status !== "recovered") return;
      } else if (resp.ok) {
        const body = (await resp.json()) as { deviceId?: string };
        if (typeof body.deviceId === "string") this.#deviceId = body.deviceId;
      }
    } catch {
      // Network flaked again; the next reconnect will retry the whole path.
      return;
    }
    const staleSessions = await this.#resumeSessions();
    await this.#reattachTerminals();
    this.#callbacks.onReconnected?.(staleSessions);
  }

  // Re-subscribe to the helper-side terminals after a reconnect (the helper
  // streams output to one client connection, and ours changed) and backfill
  // whatever was missed. Terminals the helper lost (restart) are closed in
  // the webview.
  async #reattachTerminals(sessions?: { terminalId: string; sinceSeq: number }[]): Promise<void> {
    sessions ??= [...this.#terminals.entries()].map(([terminalId, t]) => ({
      terminalId,
      sinceSeq: t.lastSeq,
    }));
    if (sessions.length === 0) return;
    try {
      const result = (await this.#rpc.call("camber/remoteTerminal/attach", { sessions })) as {
        sessions?: RemoteTerminalAttachResult[];
      };
      for (const session of result.sessions ?? []) {
        if (!session.alive) {
          this.#terminals.delete(session.terminalId);
          void this.#callWebview("assistantTerminalDidClose", [{ terminalId: session.terminalId }]);
          continue;
        }
        const tracked = this.#terminals.get(session.terminalId);
        if (session.data) {
          void this.#callWebview("assistantTerminalDidWrite", [
            { terminalId: session.terminalId, data: session.data },
          ]);
        }
        if (tracked && typeof session.seq === "number" && session.seq > tracked.lastSeq) {
          tracked.lastSeq = session.seq;
        }
        if (session.exitCode !== undefined) {
          void this.#callWebview("assistantTerminalDidExit", [
            { terminalId: session.terminalId, exitCode: session.exitCode },
          ]);
        }
      }
    } catch (error) {
      console.warn("camber: terminal reattach failed", error);
    }
  }

  // Ask the helper to replay the live events missed while offline. Sessions
  // it cannot bridge are marked stale (their events stay gated off) and
  // reported so the caller re-loads them.
  async #resumeSessions(): Promise<StaleSession[]> {
    const cursors = this.#gate.cursors();
    if (cursors.length === 0) return [];
    try {
      const result = (await this.#rpc.call("camber/remote/resume", { sessions: cursors })) as {
        sessions?: { agentServer: string; sessionId: string; resumed: boolean }[];
      };
      const stale = (result.sessions ?? []).filter((s) => !s.resumed);
      for (const s of stale) this.#gate.markStale(s.agentServer, s.sessionId);
      return stale.map(({ agentServer, sessionId }) => ({ agentServer, sessionId }));
    } catch (error) {
      console.warn("camber: resume after reconnect failed", error);
      // Without a successful resume nothing was replayed; treat every
      // cursored session as stale so the caller re-loads them.
      for (const c of cursors) this.#gate.markStale(c.agentServer, c.sessionId);
      return cursors.map(({ agentServer, sessionId }) => ({ agentServer, sessionId }));
    }
  }

  // Fetch a fresh single-use WS ticket over HTTP (where the session cookie is
  // reliably sent) and build the wss URL with it. iOS Safari does not send
  // SameSite cookies on script-initiated WebSocket handshakes, so the cookie
  // alone can't authenticate the socket. A dead session cookie previously
  // wedged this path in a 401 retry loop ("Offline — retrying…" forever);
  // now it recovers with the device token and retries once.
  async #resolveWsUrl(): Promise<string> {
    let resp = await fetch("/api/ws-ticket", { credentials: "same-origin" });
    if (resp.status === 401 || resp.status === 403) {
      if ((await this.#recoverAuth()).status !== "recovered") {
        throw new Error(`ws-ticket ${resp.status}`);
      }
      resp = await fetch("/api/ws-ticket", { credentials: "same-origin" });
    }
    if (!resp.ok) throw new Error(`ws-ticket ${resp.status}`);
    const { ticket } = (await resp.json()) as { ticket: string };
    const wsProto = location.protocol === "https:" ? "wss" : "ws";
    return `${wsProto}://${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`;
  }

  // Fetch a file's bytes from the helper's session-gated /api/file endpoint,
  // recovering an expired session cookie the same way the WS ticket path
  // does. Returns null for any miss (unauthenticated, missing, too large,
  // offline): callers answer host RPCs whose contract is an inert default,
  // not an error.
  async #fetchFile(path: string, method: "GET" | "HEAD"): Promise<Response | null> {
    const url = `/api/file?path=${encodeURIComponent(path)}`;
    try {
      let resp = await fetch(url, { method, credentials: "same-origin" });
      if (resp.status === 401 || resp.status === 403) {
        if ((await this.#recoverAuth()).status !== "recovered") return null;
        resp = await fetch(url, { method, credentials: "same-origin" });
      }
      return resp.ok ? resp : null;
    } catch {
      return null;
    }
  }

  // webviewRpcListener prop: the shared WebviewRPCServer registers its
  // "message" handler here; #callWebview invokes those handlers directly.
  webviewRpcListener: WebviewRPCListener = {
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (type === "message" && listener) this.#webviewListeners.add(listener);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (type === "message" && listener) this.#webviewListeners.delete(listener);
    },
  };

  // rpcWebViewResponseHandler prop: the webview answers host->webview calls here.
  webviewResponseHandler = (
    _command: string | number | symbol,
    payload: WebviewResponsePayload,
  ) => {
    const pending = this.#pendingWebviewCalls.get(payload.requestId);
    if (!pending) return;
    this.#pendingWebviewCalls.delete(payload.requestId);
    if (payload.error) {
      pending.reject(payload.error);
    } else {
      pending.resolve(payload.response);
    }
  };

  // Pushes a new syntax color theme into the shared webview runtime, used when
  // the mobile appearance setting changes after mount (the CSS token theme is
  // applied separately by toggling the vscode-light/vscode-dark classes).
  setColorTheme(colorTheme: unknown): void {
    void this.#callWebview("setTheme", [colorTheme]);
  }

  // Mirrors the page's visibility into the shared runtime's focus flag: a
  // backgrounded phone must not count as watching its open conversation (the
  // chat pane reports view state to the helper only while focused), and
  // returning to the foreground re-reports and clears unread.
  setEditorFocused(focused: boolean): void {
    void this.#callWebview("setEditorFocused", [focused]);
  }

  // rpcHostRequestHandler prop: every `rpc.*` call from the shared UI lands here.
  handleHostRequest = async (method: string, args: unknown[]): Promise<unknown> => {
    switch (method) {
      case "jsonrpc": {
        const rpcMethod = args[0] as string;
        if (rpcMethod === "camber/acp/session/prompt") {
          return await this.#promptWithRetry(args[1]);
        }
        const result = await this.#rpc.call(rpcMethod, args[1]);
        if (rpcMethod === "camber/acp/session/load") {
          this.#applyLoadCursor(args[1], result);
        }
        return result;
      }
      case "jsonrpcNotify":
        this.#rpc.notify(args[0] as string, args[1]);
        return undefined;

      case "ready":
        this.#resolveWebviewReady();
        return undefined;

      // Local browser capabilities.
      case "writeToClipboard":
        await navigator.clipboard.writeText(String(args[0] ?? ""));
        return undefined;
      case "openExternalURL":
        window.open(String(args[0]), "_blank", "noopener");
        return undefined;
      case "showInfoMessage":
        console.info("camber:", args[0]);
        return undefined;

      // Worktree terminals are helper-side PTYs (camber/remoteTerminal/*),
      // so the shared terminal repository — and worktree setup/teardown
      // scripts run through it — work against the desktop machine.
      case "createAssistantTerminal": {
        const [worktreePath, command, env, , , cols, rows] = args as [
          string,
          string | undefined,
          Record<string, string> | undefined,
          unknown,
          unknown,
          number | undefined,
          number | undefined,
        ];
        const result = (await this.#rpc.call("camber/remoteTerminal/create", {
          cwd: worktreePath,
          command,
          env,
          // Spawn at the measured pane size so the first prompt paints at the
          // right width; the helper falls back to 80x24 when omitted.
          cols,
          rows,
        })) as { tab: RemoteTerminalTab };
        this.#terminals.set(result.tab.id, { lastSeq: 0 });
        return result.tab;
      }
      case "listAssistantTerminals": {
        const result = (await this.#rpc.call("camber/remoteTerminal/list", {})) as {
          tabs?: RemoteTerminalTab[];
        };
        const tabs = result.tabs ?? [];
        // Terminals we don't know yet survived a page reload: subscribe this
        // connection to them and replay their scrollback from the start.
        const unknown = tabs.filter((tab) => !this.#terminals.has(tab.id));
        for (const tab of unknown) this.#terminals.set(tab.id, { lastSeq: 0 });
        if (unknown.length > 0) {
          void this.#reattachTerminals(unknown.map((tab) => ({ terminalId: tab.id, sinceSeq: 0 })));
        }
        return tabs;
      }
      case "writeAssistantTerminal":
        await this.#rpc.call("camber/remoteTerminal/write", {
          terminalId: args[0],
          data: args[1],
        });
        return undefined;
      case "resizeAssistantTerminal":
        await this.#rpc.call("camber/remoteTerminal/resize", {
          terminalId: args[0],
          cols: args[1],
          rows: args[2],
        });
        return undefined;
      case "clearAssistantTerminal":
        await this.#rpc.call("camber/remoteTerminal/clear", { terminalId: args[0] });
        return undefined;
      case "deleteAssistantTerminal":
        this.#terminals.delete(String(args[0]));
        await this.#rpc.call("camber/remoteTerminal/delete", { terminalId: args[0] });
        return undefined;
      case "closeAssistantTerminalsForWorktree":
      case "closeAssistantTerminalsForProject":
        await this.#rpc.call("camber/remoteTerminal/closeForPath", { path: args[0] });
        return undefined;

      // File reads go over the helper's authenticated /api/file endpoint (the
      // desktop and VS Code hosts answer these from their local filesystem).
      case "checkFileExists":
        return (await this.#fetchFile(String(args[0]), "HEAD")) !== null;
      case "getFileContents": {
        const path = String(args[0]);
        const resp = await this.#fetchFile(path, "GET");
        // undefined, not null: the Host.getFileContents contract is
        // AttachedFile | undefined, and callers gate on undefined (a null
        // would slip through as a bogus attached file).
        if (!resp) return undefined;
        return { path, content: await resp.text() };
      }
      case "getImageFileData": {
        const path = String(args[0]);
        const resp = await this.#fetchFile(path, "GET");
        if (!resp) return undefined;
        const blob = await resp.blob();
        return {
          path,
          mimeType: blob.type || "application/octet-stream",
          data: await base64FromBlob(blob),
        };
      }
      case "openFile": {
        const [path, line, column] = args as [string, number | undefined, number | undefined];
        this.#callbacks.onOpenFile?.(path, line, column);
        return undefined;
      }

      // Answered with inert defaults: these surfaces don't exist on a phone.
      case "getKeybindings":
        return {};
      case "listSecrets":
        return [];
      case "getSecret":
        return null;
      case "getFileIconDefinition":
        return null;
      case "selectProjectFolder":
        return null;
      case "getConfiguration":
        return {};
      case "reportError":
        console.debug("Assistant reported an error", args[0]);
        return undefined;
      case "reportEvent":
      case "setWebviewFocus":
      case "updateAcpChatPanelMetadata":
      case "setACPAgentServers":
      case "openSettings":
      case "openAcpChat":
      case "closeAcpChat":
        return undefined;

      default:
        console.debug("remoteHost: unhandled host rpc method", method, args);
        return undefined;
    }
  };

  async #callWebview(command: string, payload: unknown[]): Promise<unknown> {
    await this.#webviewReady;
    return await new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.#pendingWebviewCalls.set(requestId, { resolve, reject });
      // The shared WebviewRPCServer routes {command, payload, requestId}
      // envelopes; it only ever reads `event.data`.
      const event = new MessageEvent("message", { data: { command, payload, requestId } });
      for (const listener of this.#webviewListeners) {
        if (typeof listener === "function") {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }
    });
  }

  // Prompts survive connection drops. The turn keeps running helper-side
  // when our socket dies, so a prompt call rejected by the socket close is
  // re-issued with the same _meta turnId once the connection is back: the
  // helper attaches the retry to the running turn (or returns the stored
  // result if it finished while we were offline) instead of starting a
  // duplicate turn.
  async #promptWithRetry(params: unknown): Promise<unknown> {
    const request = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    const meta = (
      request._meta && typeof request._meta === "object" ? request._meta : {}
    ) as Record<string, unknown>;
    meta["camber/turnId"] = crypto.randomUUID();
    request._meta = meta;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#rpc.call("camber/acp/session/prompt", request);
      } catch (error) {
        const lost = error instanceof Error && error.message === CONNECTION_LOST_MESSAGE;
        if (!lost || attempt >= 5) throw error;
        await this.#nextOpen();
      }
    }
  }

  // Resolves on the next socket open (immediately if already open).
  #nextOpen(): Promise<void> {
    if (this.#rpc.isOpen) return Promise.resolve();
    return new Promise((resolve) => {
      this.#openWaiters.push(resolve);
    });
  }

  // Anchor the session's live-event cursor from a session/load response: the
  // replay covered everything up to the reported seq, so stamped events at or
  // below it are duplicates the gate must drop (the replay/live cutover).
  #applyLoadCursor(params: unknown, result: unknown): void {
    const req = params as { agentServer?: string; sessionId?: string } | undefined;
    const meta = (result as { _meta?: Record<string, unknown> } | null)?._meta?.[
      "camber/sessionCursor"
    ] as { epoch?: string; seq?: number } | undefined;
    if (!req?.sessionId || typeof meta?.epoch !== "string" || typeof meta?.seq !== "number") {
      return;
    }
    const drained = this.#gate.setBaseline(
      req.agentServer ?? "poolside",
      req.sessionId,
      meta.epoch,
      meta.seq,
    );
    for (const envelope of drained) {
      void this.#callWebview("jsonrpcNotify", [envelope]);
    }
  }

  #dispatchHelperNotification(method: string, params: unknown): void {
    // Mobile-specific handling first (the live-session seq gate and terminal
    // output dedup); everything else routes through the shared helper
    // notification table so a notification added there reaches this surface
    // without touching this file, unless its surface is deliberately not
    // rendered on mobile (see UNRENDERED_ON_MOBILE).
    switch (method) {
      case "camber/jsonrpc/notify": {
        const admitted = this.#gate.admit(params);
        if (admitted === null) {
          // Not a stamped session event (load replay, config probes, other
          // notification bridges): pass through untouched.
          void this.#callWebview("jsonrpcNotify", [params]);
          return;
        }
        for (const envelope of admitted) {
          void this.#callWebview("jsonrpcNotify", [envelope]);
        }
        return;
      }
      case "camber/remoteTerminal/didWrite": {
        const write = params as { terminalId: string; data: string; seq: number };
        const tracked = this.#terminals.get(write.terminalId);
        // Drop chunks an attach backfill already covered.
        if (tracked && write.seq <= tracked.lastSeq) return;
        if (tracked) {
          tracked.lastSeq = write.seq;
        } else {
          this.#terminals.set(write.terminalId, { lastSeq: write.seq });
        }
        void this.#callWebview("assistantTerminalDidWrite", [
          { terminalId: write.terminalId, data: write.data },
        ]);
        return;
      }
      case "camber/remoteTerminal/didExit": {
        const exit = params as { terminalId: string; exitCode?: number };
        void this.#callWebview("assistantTerminalDidExit", [exit]);
        return;
      }
    }
    if (UNRENDERED_ON_MOBILE.has(method)) return;
    const command = webviewCommandForHelperNotification(method);
    if (!command) {
      console.debug("remoteHost: unhandled helper notification", method);
      return;
    }
    void this.#callWebview(command, [params]);
  }

  async #dispatchHelperRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "camber/jsonrpc/request":
        return await this.#callWebview("jsonrpcRequest", [params]);
      case "camber/acp/elicitation/create":
        return await this.#callWebview("elicitation", [params]);
      default:
        throw new Error(`remoteHost: unsupported helper request ${method}`);
    }
  }
}

// FileReader instead of btoa(String.fromCharCode(...)): images run to
// megabytes and per-byte string building trips call-stack/quadratic-append
// limits on mobile Safari.
function base64FromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not encode file"));
    reader.readAsDataURL(blob);
  });
}
