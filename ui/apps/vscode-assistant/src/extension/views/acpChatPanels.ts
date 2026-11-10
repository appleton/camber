import type { AnyMessage } from "@agentclientprotocol/sdk";
import type {
  ACPNavConversation,
  ACPNavConversationLiveStatus,
  ACPNavState,
} from "@camber/helperapi/schemas";
import type {
  AcpChatPanelMetadata,
  ActiveFileContext,
  CloseAcpChatOptions,
  Configuration,
  Keybindings,
  Language,
  OpenAcpChatOptions,
} from "@camber/rpc";
import type { AssistantError, AssistantResponse } from "@camber/rpc/assistant";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { HostRPCServer } from "../rpc/server";
import type { System } from "../system";
import { AcpTabIconProvider, type AcpTabIconStatus } from "./acpTabIcon";
import { getWebviewHtml } from "./getWebviewHtml";

export const CAMBER_ACP_CHAT_VIEW_TYPE = "camber-acp-chat" as const;
export const DEFAULT_AGENT_SERVER = "poolside";

export interface AcpChatPanelState {
  conversationId: string;
  agentServer: string;
  sessionId?: string;
  agentName?: string;
  agentIconUrl?: string;
  cwd?: string;
  workingDirectories?: string[];
  readOnly?: boolean;
  fallbackCwds?: string[];
}

export interface AcpChatPanelInitialState {
  kind: "pending" | "session";
  conversationId: string;
  agentServer?: string;
  sessionId?: string;
  cwd?: string;
  workingDirectories?: string[];
  readOnly?: boolean;
  fallbackCwds?: string[];
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  rpcServer: HostRPCServer;
  conversationId: string;
  agentServer?: string;
  sessionId?: string;
  agentName?: string;
  agentIconUrl?: string;
  supportsMcp?: boolean | null;
  allowCustomMcp?: boolean | null;
  sessionTitle?: string;
  lastTouchedAt: number;
  iconRequestId: number;
  disposables: vscode.Disposable[];
}

interface BridgedACPMessage {
  agentServer?: string;
  message?: AnyMessage;
}

type TabStatusKind = AcpTabIconStatus;

const emptyLiveStatus: ACPNavConversationLiveStatus = {
  working: false,
  waitingForUser: false,
  unread: false,
};

function normalizeAgentServer(agentServer: string | undefined): string {
  return agentServer || DEFAULT_AGENT_SERVER;
}

function newConversationId(): string {
  return `conversation:${randomUUID()}`;
}

function panelTitle(sessionTitle: string | undefined): string {
  if (sessionTitle) return sessionTitle;
  return "Camber Chat";
}

function agentNameFromServer(agentServer: string): string {
  return agentServer === DEFAULT_AGENT_SERVER ? "Camber" : agentServer;
}

/**
 * AcpChatPanels owns the per-session ACP chat editor tabs. The sidebar webview
 * never hosts the chat in ACP mode; instead it calls `openAcpChat` on the host
 * which delegates to this manager.
 *
 * Panel keys are conversation IDs. The protocol session ID is kept on the
 * entry only for routing ACP messages and syncing view state.
 */
export class AcpChatPanels {
  private panels = new Map<string, PanelEntry>();
  private navConversations = new Map<string, ACPNavConversation>();
  private focusInputWhenReady = new Set<string>();
  // Replay callback for an agent-exit notification whose postMessage failed
  // (webview not ready), run on panelReady.
  private pendingAgentExits = new Map<string, () => void>();
  private latestConfiguration: Configuration | undefined;
  private latestContext: ActiveFileContext | undefined;
  private latestEditorFocused: boolean | undefined;
  private latestFileIconTheme: unknown;
  private latestKeybindings: Keybindings | undefined;
  private latestLanguages: Language[] | undefined;
  private latestTheme: unknown;
  private readonly tabIcons: AcpTabIconProvider;

  constructor(private system: System) {
    this.tabIcons = new AcpTabIconProvider(system);
  }

  async openSession(opts: OpenAcpChatOptions): Promise<void> {
    const agentServer = normalizeAgentServer(opts.agentServer);

    const existing =
      (opts.conversationId ? this.panels.get(opts.conversationId) : undefined) ??
      (opts.sessionId ? this.panelForSession(agentServer, opts.sessionId) : undefined);
    if (existing) {
      const metadata: AcpChatPanelMetadata = {
        agentServer,
        agentName: opts.agentName,
      };
      if ("agentIconUrl" in opts) {
        metadata.agentIconUrl = opts.agentIconUrl;
      }
      this.updatePanelMetadata(existing.conversationId, metadata);
      existing.panel.reveal();
      this.syncPanelViewState(existing);
      return;
    }

    if (!opts.conversationId && !opts.sessionId) {
      const pending = this.mostRecentPendingPanel();
      if (pending) {
        await this.focusEntryInput(pending);
        return;
      }
    }

    const conversationId = opts.conversationId ?? newConversationId();

    const panel = vscode.window.createWebviewPanel(
      CAMBER_ACP_CHAT_VIEW_TYPE,
      panelTitle(opts.sessionTitle),
      { viewColumn: vscode.ViewColumn.Active },
      {
        retainContextWhenHidden: true,
        enableScripts: true,
      },
    );

    panel.iconPath = this.fallbackIconPathForKind("default");

    const initial: AcpChatPanelInitialState = opts.sessionId
      ? {
          kind: "session",
          conversationId,
          agentServer,
          sessionId: opts.sessionId,
          cwd: opts.cwd,
          workingDirectories: cloneStringArray(opts.workingDirectories),
          readOnly: opts.readOnly,
          fallbackCwds: cloneStringArray(opts.fallbackCwds),
        }
      : { kind: "pending", conversationId };

    await this.bindPanel(panel, initial, {
      agentName: opts.agentName,
      agentIconUrl: opts.agentIconUrl,
      sessionTitle: opts.sessionTitle,
    });
  }

  async focusInput(): Promise<void> {
    const entry = this.mostRecentPanel();
    if (!entry) {
      const conversationId = newConversationId();
      this.focusInputWhenReady.add(conversationId);
      try {
        await this.openSession({ conversationId });
      } catch (error) {
        this.focusInputWhenReady.delete(conversationId);
        throw error;
      }
      return;
    }

    await this.focusEntryInput(entry);
  }

  togglePlanModeOnActivePanel(): void {
    const entry = this.activePanel();
    if (!entry) return;
    void this.postToPanel(entry, "togglePlanMode", []);
  }

  closeSession(session: string | CloseAcpChatOptions): void {
    const conversationId = typeof session === "string" ? session : session.conversationId;
    const entry = this.panels.get(conversationId);
    if (!entry) return;
    entry.panel.dispose();
  }

  panelReady(conversationId: string): void {
    const entry = this.panels.get(conversationId);
    if (!entry) return;
    this.replayHostState(entry);
    const replayAgentExit = this.pendingAgentExits.get(conversationId);
    if (replayAgentExit) {
      this.pendingAgentExits.delete(conversationId);
      replayAgentExit();
    }
    if (this.focusInputWhenReady.delete(conversationId)) {
      void this.focusEntryInput(entry);
    }
  }

  setConfiguration(configuration: Configuration): void {
    this.latestConfiguration = configuration;
    this.notifyAll("setConfiguration", [configuration]);
  }

  setContext(context: ActiveFileContext): void {
    this.latestContext = context;
    this.notifyAll("setContext", [context]);
  }

  updatePanelMetadata(conversationId: string, metadata: AcpChatPanelMetadata): void {
    const entry = this.panels.get(conversationId);
    if (!entry) return;

    let activeAgentChanged = false;
    if (metadata.agentServer !== undefined) {
      entry.agentServer = normalizeAgentServer(metadata.agentServer);
      activeAgentChanged = true;
    }
    if (metadata.agentName !== undefined) {
      entry.agentName = metadata.agentName;
    }
    if ("agentIconUrl" in metadata) {
      entry.agentIconUrl = metadata.agentIconUrl;
    }
    if ("supportsMcp" in metadata) {
      entry.supportsMcp = metadata.supportsMcp ?? null;
      activeAgentChanged = true;
    }
    if ("allowCustomMcp" in metadata) {
      entry.allowCustomMcp = metadata.allowCustomMcp ?? null;
      activeAgentChanged = true;
    }

    if (activeAgentChanged) {
      this.broadcastActiveAgent();
    }
    this.applyPanelDecorations(entry);
  }

  setEditorFocused(focused: boolean): void {
    this.latestEditorFocused = focused;
    this.notifyAll("setEditorFocused", [focused]);
  }

  setFileIconTheme(theme: unknown): void {
    this.latestFileIconTheme = theme;
    this.notifyAll("setFileIconTheme", [theme]);
  }

  setKeybindings(keybindings: Keybindings): void {
    this.latestKeybindings = keybindings;
    this.notifyAll("setKeybindings", [keybindings]);
  }

  setLanguages(languages: Language[]): void {
    this.latestLanguages = languages;
    this.notifyAll("setLanguages", [languages]);
  }

  setTheme(theme: unknown): void {
    this.latestTheme = theme;
    this.notifyAll("setTheme", [theme]);
  }

  /**
   * Called when the extension observes a successful `session/new` response
   * from a panel's outbound RPC. The panel is identified by its conversation
   * id; the protocol session ID is attached for routing.
   */
  attachSessionId(conversationId: string, agentServer: string, sessionId: string): void {
    const entry = this.panels.get(conversationId);
    if (!entry) return;
    agentServer = normalizeAgentServer(agentServer);
    entry.agentServer = agentServer;
    entry.sessionId = sessionId;
    entry.agentName ??= agentNameFromServer(agentServer);
    entry.lastTouchedAt = Date.now();
    this.applyPanelNavState(entry);
    this.syncPanelViewState(entry);
  }

  acpNavDidChange(state: ACPNavState, opts: { syncViewState?: boolean } = {}): void {
    this.navConversations.clear();
    const archivedConversationIds = new Set<string>();
    for (const conversation of state.conversations ?? []) {
      if (!conversation.active || conversation.archived) {
        archivedConversationIds.add(conversation.id);
        continue;
      }
      this.navConversations.set(conversation.id, conversation);
    }

    for (const entry of Array.from(this.panels.values())) {
      if (archivedConversationIds.has(entry.conversationId)) {
        entry.panel.dispose();
        continue;
      }
      this.applyPanelNavState(entry);
      if (opts.syncViewState !== false && entry.panel.visible) this.syncPanelViewState(entry);
    }
  }

  async routeInbound(methodName: string, params: unknown): Promise<unknown> {
    switch (methodName) {
      case "camber/jsonrpc/notify":
        return this.routeJsonrpcNotify(params);
      case "camber/jsonrpc/request":
        return this.routeJsonrpcRequest(params);
      case "camber/acp/serverDidExit":
        return this.routeAgentServerDidExit(params);
      case "camber/acp/elicitation/create":
        return this.routeElicitation(params);
      case "camber/acp/approvals/didChange":
        return this.routeApprovalsDidChange(params);
      case "camber/mcpServers/didChange":
        return this.routeMcpServersDidChange();
    }
  }

  /**
   * Webview panel serializer entrypoint. Rebinds a restored panel back into
   * the map under its conversation id.
   */
  async adoptPanel(panel: vscode.WebviewPanel, state: AcpChatPanelState): Promise<void> {
    const agentServer = normalizeAgentServer(state.agentServer);
    if (this.panels.has(state.conversationId)) {
      panel.dispose();
      this.panels.get(state.conversationId)!.panel.reveal();
      return;
    }

    const initial: AcpChatPanelInitialState = {
      kind: state.sessionId ? "session" : "pending",
      conversationId: state.conversationId,
      agentServer,
      sessionId: state.sessionId,
      cwd: state.cwd,
      workingDirectories: cloneStringArray(state.workingDirectories),
      readOnly: state.readOnly,
      fallbackCwds: cloneStringArray(state.fallbackCwds),
    };

    await this.bindPanel(panel, initial, {
      agentName: state.agentName,
      agentIconUrl: state.agentIconUrl,
    });
  }

  disposeAll(): void {
    for (const entry of this.panels.values()) {
      entry.panel.dispose();
    }
    this.panels.clear();
    this.navConversations.clear();
    this.focusInputWhenReady.clear();
    this.pendingAgentExits.clear();
  }

  private async bindPanel(
    panel: vscode.WebviewPanel,
    initial: AcpChatPanelInitialState,
    metadata: { agentName?: string; agentIconUrl?: string; sessionTitle?: string } = {},
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
    };

    const rpcServer = new HostRPCServer(this.system, panel.webview, {
      acpChatPanels: this,
      getAcpChatPanelConversationId: () => initial.conversationId,
    });
    const messageDisposable = panel.webview.onDidReceiveMessage(rpcServer.route.bind(rpcServer));
    const entry: PanelEntry = {
      panel,
      rpcServer,
      conversationId: initial.conversationId,
      agentServer: initial.agentServer,
      sessionId: initial.sessionId,
      agentName: metadata.agentName,
      agentIconUrl: metadata.agentIconUrl,
      sessionTitle: metadata.sessionTitle,
      lastTouchedAt: Date.now(),
      iconRequestId: 0,
      disposables: [messageDisposable],
    };
    const viewStateDisposable = panel.onDidChangeViewState(() => {
      entry.lastTouchedAt = Date.now();
      this.syncPanelViewState(entry);
      this.broadcastActiveAgent();
    });

    entry.disposables.push(viewStateDisposable);
    this.panels.set(entry.conversationId, entry);
    this.broadcastActiveAgent();

    panel.onDidDispose(() => {
      for (const d of entry.disposables) d.dispose();
      if (this.panels.get(entry.conversationId) === entry) {
        this.panels.delete(entry.conversationId);
        this.pendingAgentExits.delete(entry.conversationId);
      }
      this.broadcastActiveAgent();
      if (entry.sessionId) {
        void this.setConversationViewState(
          entry.agentServer ?? DEFAULT_AGENT_SERVER,
          entry.sessionId,
          false,
        );
      }
    });

    panel.webview.html = await getWebviewHtml(this.system, panel.webview, "acp-chat", [
      { key: "CAMBER_INITIAL_ACP_CHAT_STATE", value: initial },
    ]);
    this.applyPanelNavState(entry);
    this.syncPanelViewState(entry);
  }

  private routeJsonrpcNotify(params: unknown): void {
    const { agentServer, message } = unwrapBridgeMessage(params);
    const sessionId = sessionIdFromMessage(message);
    if (sessionId) {
      const entry = this.panelForSession(agentServer, sessionId);
      if (entry) {
        entry.lastTouchedAt = Date.now();
        void this.postToPanel(entry, "jsonrpcNotify", [params]);
        return;
      }
    }

    for (const entry of this.panelsForAgent(agentServer)) {
      void this.postToPanel(entry, "jsonrpcNotify", [params]);
    }
  }

  private async routeJsonrpcRequest(params: unknown): Promise<unknown> {
    const { agentServer, message } = unwrapBridgeMessage(params);
    const sessionId = sessionIdFromMessage(message);
    const entry = sessionId
      ? this.panelForSession(agentServer, sessionId)
      : this.mostRecentPanelForAgent(agentServer);
    if (!entry) {
      throw new Error(
        `No ACP chat panel is open for ${agentServer}${sessionId ? `:${sessionId}` : ""}`,
      );
    }

    entry.lastTouchedAt = Date.now();
    return await this.requestFromPanel(entry, "jsonrpcRequest", [params]);
  }

  private routeAgentServerDidExit(params: unknown): void {
    for (const entry of this.panels.values()) {
      entry.lastTouchedAt = Date.now();
      void this.postToPanel(entry, "acpAgentServerDidExit", [params]).then((posted) => {
        if (posted || this.panels.get(entry.conversationId) !== entry) return;
        this.pendingAgentExits.set(entry.conversationId, () => {
          void this.postToPanel(entry, "acpAgentServerDidExit", [params]);
        });
      });
    }
  }

  private async routeElicitation(params: unknown): Promise<unknown> {
    const agentServer = agentServerFromParams(params);
    const sessionId = sessionIdFromParams(params);
    const entry = sessionId
      ? this.panelForSession(agentServer, sessionId)
      : this.mostRecentPanelForAgent(agentServer);
    if (!entry) {
      throw new Error(
        `No ACP chat panel is open for ${agentServer}${sessionId ? `:${sessionId}` : ""}`,
      );
    }

    entry.lastTouchedAt = Date.now();
    return await this.requestFromPanel(entry, "elicitation", [params]);
  }

  // The helper's pending approval set changed. Every panel receives the full
  // set and reconciles by key — a panel renders entries for its own session
  // inline and holds the rest unbound, so no per-panel filtering is needed.
  private routeApprovalsDidChange(params: unknown): void {
    for (const entry of this.panels.values()) {
      void this.postToPanel(entry, "acpApprovalsDidChange", [params]);
    }
  }

  // The user's MCP connector store changed: every panel re-lists it and
  // re-injects the connector set into its live agent sessions.
  private routeMcpServersDidChange(): void {
    for (const entry of this.panels.values()) {
      void this.postToPanel(entry, "mcpServersDidChange", []);
    }
  }

  private panelsForAgent(agentServer: string): PanelEntry[] {
    return Array.from(this.panels.values()).filter((entry) => entry.agentServer === agentServer);
  }

  private panelForSession(agentServer: string, sessionId: string): PanelEntry | undefined {
    agentServer = normalizeAgentServer(agentServer);
    return Array.from(this.panels.values()).find(
      (entry) => entry.agentServer === agentServer && entry.sessionId === sessionId,
    );
  }

  private mostRecentPanelForAgent(agentServer: string): PanelEntry | undefined {
    const entries = this.panelsForAgent(agentServer);
    if (entries.length <= 1) return entries[0];
    return [...entries].sort((left, right) => right.lastTouchedAt - left.lastTouchedAt).at(0);
  }

  private mostRecentPanel(): PanelEntry | undefined {
    const entries = Array.from(this.panels.values());
    if (entries.length <= 1) return entries[0];
    return [...entries].sort((left, right) => right.lastTouchedAt - left.lastTouchedAt).at(0);
  }

  private mostRecentPendingPanel(): PanelEntry | undefined {
    const entries = Array.from(this.panels.values()).filter((entry) => !entry.sessionId);
    if (entries.length <= 1) return entries[0];
    return [...entries].sort((left, right) => right.lastTouchedAt - left.lastTouchedAt).at(0);
  }

  private activePanel(): PanelEntry | undefined {
    return Array.from(this.panels.values()).find((entry) => entry.panel.active);
  }

  // Tell the sidebar webview which ACP agent the user is currently working with.
  // The sidebar is a separate webview and can't see the focused chat editor, so
  // it relies on this to decide e.g. whether to show Camber-specific UI.
  private broadcastActiveAgent(): void {
    // runWhenReady covers the sidebar opening after the last focus event; it
    // also fires immediately once the sidebar is ready, so live updates work.
    this.system.assistant.runWhenReady(() => {
      // Prefer the focused editor panel (authoritative) over "most recently
      // touched" (a heuristic that can lag when switching agents/chats). Falls
      // back to most-recent when no chat editor is focused (e.g. the user is on
      // the sidebar), which preserves the last active chat's agent.
      const panel = this.activePanel() ?? this.mostRecentPanel();
      void this.system.assistant.rpc.acpActiveAgentDidChange({
        agentServer: panel?.agentServer ?? null,
        supportsMcp: panel?.supportsMcp ?? null,
        allowCustomMcp: panel?.allowCustomMcp ?? null,
      });
    });
  }

  private async focusEntryInput(entry: PanelEntry): Promise<void> {
    entry.panel.reveal();
    entry.lastTouchedAt = Date.now();
    this.syncPanelViewState(entry);
    const posted = await this.postToPanel(entry, "focusInput", []);
    if (!posted) {
      this.focusInputWhenReady.add(entry.conversationId);
    }
  }

  private async postToPanel(
    entry: PanelEntry,
    command: string,
    payload: unknown[],
  ): Promise<boolean> {
    return await entry.panel.webview.postMessage({
      command,
      requestId: randomUUID(),
      payload,
    });
  }

  private notifyAll(command: string, payload: unknown[]): void {
    for (const entry of this.panels.values()) {
      void this.postToPanel(entry, command, payload);
    }
  }

  private replayHostState(entry: PanelEntry): void {
    if (this.latestConfiguration) {
      void this.postToPanel(entry, "setConfiguration", [this.latestConfiguration]);
    }
    if (this.latestContext) {
      void this.postToPanel(entry, "setContext", [this.latestContext]);
    }
    if (this.latestEditorFocused !== undefined) {
      void this.postToPanel(entry, "setEditorFocused", [this.latestEditorFocused]);
    }
    if (this.latestKeybindings) {
      void this.postToPanel(entry, "setKeybindings", [this.latestKeybindings]);
    }
    if (this.latestLanguages) {
      void this.postToPanel(entry, "setLanguages", [this.latestLanguages]);
    }
    if (this.latestTheme !== undefined) {
      void this.postToPanel(entry, "setTheme", [this.latestTheme]);
    }
    if (this.latestFileIconTheme !== undefined) {
      void this.postToPanel(entry, "setFileIconTheme", [this.latestFileIconTheme]);
    }
  }

  private async requestFromPanel(
    entry: PanelEntry,
    command: string,
    payload: unknown[],
  ): Promise<unknown> {
    const requestId = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const listener = entry.panel.webview.onDidReceiveMessage(
        (event: AssistantResponse | AssistantError) => {
          if (event.payload?.requestId !== requestId) return;
          listener.dispose();
          if ("error" in event.payload && event.payload.error) {
            reject(event.payload.error);
          } else {
            resolve(event.payload.response);
          }
        },
      );
    });

    await entry.panel.webview.postMessage({ command, requestId, payload });
    return await response;
  }

  private applyPanelNavState(entry: PanelEntry): void {
    if (!entry.sessionId) {
      this.applyPanelDecorations(entry);
      return;
    }

    const conversation = this.navConversations.get(entry.conversationId);
    if (conversation?.title) {
      entry.sessionTitle = conversation.title;
    }
    if (conversation?.agentServer) {
      entry.agentServer = conversation.agentServer;
      entry.agentName ??= agentNameFromServer(conversation.agentServer);
    }
    this.applyPanelDecorations(entry, conversation?.liveStatus);
  }

  private applyPanelDecorations(
    entry: PanelEntry,
    liveStatus: ACPNavConversationLiveStatus = emptyLiveStatus,
  ): void {
    const kind = tabStatusKind(liveStatus);
    entry.panel.title = panelTitle(entry.sessionTitle);
    this.applyPanelIcon(entry, kind);
  }

  private applyPanelIcon(entry: PanelEntry, kind: TabStatusKind): void {
    const agentServer = normalizeAgentServer(entry.agentServer);
    const agentIconUrl = entry.agentIconUrl;
    const requestId = ++entry.iconRequestId;
    const cachedIconPath = this.tabIcons.cachedIconPathForAgent(agentServer, agentIconUrl, kind);
    if (cachedIconPath) {
      entry.panel.iconPath = cachedIconPath;
      return;
    }

    entry.panel.iconPath = this.fallbackIconPathForKind(kind);
    if (!agentIconUrl || agentServer === DEFAULT_AGENT_SERVER) return;

    void this.tabIcons
      .iconPathForAgent(agentServer, agentIconUrl, kind)
      .then((iconPath) => {
        if (!iconPath) return;
        if (this.panels.get(entry.conversationId) !== entry) return;
        if (entry.iconRequestId !== requestId) return;
        entry.panel.iconPath = iconPath;
      })
      .catch((error) => {
        this.system.telemetry.reportError(
          new Error("failed to update ACP chat tab icon", { cause: error }),
        );
      });
  }

  private fallbackIconPathForKind(kind: TabStatusKind): vscode.WebviewPanel["iconPath"] {
    const iconFile =
      kind === "waiting"
        ? "icon-status-waiting.svg"
        : kind === "working"
          ? "icon-status-working.svg"
          : kind === "unread"
            ? "icon-status-unread.svg"
            : "icon-light.svg";
    const iconUri = vscode.Uri.parse(
      this.system.context.asAbsolutePath(`./dist/resources/${iconFile}`),
    );
    return {
      dark: iconUri,
      light: iconUri,
    };
  }

  private syncPanelViewState(entry: PanelEntry): void {
    if (!entry.sessionId) return;
    void this.setConversationViewState(
      entry.agentServer ?? DEFAULT_AGENT_SERVER,
      entry.sessionId,
      entry.panel.visible,
    );
  }

  private async setConversationViewState(
    agentServer: string,
    sessionId: string,
    active: boolean,
  ): Promise<void> {
    let acpNavState: ACPNavState | null = null;
    try {
      const { getHelperSingleton } = await import("../helper");
      const client = await getHelperSingleton(this.system);
      acpNavState = (await client.sendRequest("camber/acpNav/setConversationViewState", {
        agentServer,
        sessionId,
        active,
      })) as ACPNavState;
    } catch (error) {
      this.system.telemetry.reportError(
        new Error("failed to update ACP conversation view state", { cause: error }),
      );
    }
    if (!acpNavState) return;
    this.system.assistant.updateAttentionCount(acpNavState.conversations);
    this.acpNavDidChange(acpNavState, { syncViewState: false });
    if (this.system.assistant.isReady) {
      void this.system.assistant.rpc.acpNavDidChange({ state: acpNavState });
    }
  }
}

/**
 * `WebviewPanelSerializer` that rebinds restored ACP chat panels through the
 * shared `AcpChatPanels` instance. Used to survive window reloads.
 */
export class AcpChatPanelSerializer implements vscode.WebviewPanelSerializer {
  constructor(private panels: AcpChatPanels) {}

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    if (!isAcpChatPanelState(state)) {
      panel.dispose();
      return;
    }
    await this.panels.adoptPanel(panel, state);
  }
}

function isAcpChatPanelState(state: unknown): state is AcpChatPanelState {
  return (
    typeof state === "object" &&
    state !== null &&
    typeof (state as AcpChatPanelState).conversationId === "string" &&
    typeof (state as AcpChatPanelState).agentServer === "string" &&
    ((state as AcpChatPanelState).sessionId === undefined ||
      typeof (state as AcpChatPanelState).sessionId === "string") &&
    ((state as AcpChatPanelState).agentName === undefined ||
      typeof (state as AcpChatPanelState).agentName === "string") &&
    ((state as AcpChatPanelState).agentIconUrl === undefined ||
      typeof (state as AcpChatPanelState).agentIconUrl === "string")
  );
}

function unwrapBridgeMessage(payload: unknown): { agentServer: string; message: AnyMessage } {
  if (
    payload &&
    typeof payload === "object" &&
    "message" in payload &&
    (payload as BridgedACPMessage).message
  ) {
    return {
      agentServer: agentServerFromParams(payload),
      message: (payload as BridgedACPMessage).message!,
    };
  }

  return {
    agentServer: DEFAULT_AGENT_SERVER,
    message: payload as AnyMessage,
  };
}

function agentServerFromParams(params: unknown): string {
  if (params && typeof params === "object" && typeof (params as any).agentServer === "string") {
    return (params as any).agentServer || DEFAULT_AGENT_SERVER;
  }
  return DEFAULT_AGENT_SERVER;
}

function sessionIdFromParams(params: unknown): string | undefined {
  if (params && typeof params === "object" && typeof (params as any).sessionId === "string") {
    return (params as any).sessionId;
  }
}

function sessionIdFromMessage(message: AnyMessage): string | undefined {
  const params = "params" in message ? message.params : undefined;
  return sessionIdFromParams(params);
}

function tabStatusKind(status: ACPNavConversationLiveStatus): TabStatusKind {
  if (status.waitingForUser) return "waiting";
  if (status.working) return "working";
  if (status.unread) return "unread";
  return "default";
}

function cloneStringArray(value: readonly string[] | undefined): string[] | undefined {
  return value ? Array.from(value) : undefined;
}
