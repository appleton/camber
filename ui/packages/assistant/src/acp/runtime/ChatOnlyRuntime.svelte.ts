import {
  ACP_DEBUG_DUMP_LOADED_EVENT,
  ACP_IDE_WORKSPACE_PATH,
  acpProtocolCwd,
  acpWorkspaceFolders,
  agentIconUrl,
  agentName,
  appState,
  DEFAULT_AGENT_SERVER,
  fetchAllowCustomMCPServers,
  resolveSessionCwd,
  acpHostRpc as rpc,
  type ACPDebugDumpLoadedEventDetail,
} from "@camber/features/acp";
import { onDestroy, onMount } from "svelte";
import { get } from "svelte/store";

import { PendingSessionBootstrap } from "./shared/PendingSessionBootstrap.svelte";
import type { Runtime } from "./shared/types";

const CAMBER_AGENT_SERVER = "poolside";

type PanelMetadata = {
  agentServer: string;
  agentName: string;
  agentIconUrl: string | undefined;
  supportsMcp: boolean | null;
  allowCustomMcp: boolean | null;
};

// Chat-only (IDE editor surface) target: a single conversation persisted into the VS Code webview
// state, with panel-metadata and custom-MCP reporting, layered on top of an CoreRuntime.
export class ChatOnlyRuntime {
  #core: Runtime;
  #initialChatState: typeof CAMBER_INITIAL_ACP_CHAT_STATE;
  #vscode = acquireVsCodeApi<
    | {
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
    | undefined
  >();

  #stopACPDebugDumpSync = () => {};
  #bootstrap: PendingSessionBootstrap;
  #activeSession = $derived.by(() =>
    this.#core.acpRepo.getSessionByConversationId(this.#core.activeConversationId),
  );
  #lastSentPanelMetadata: PanelMetadata | undefined;
  #activeAllowCustomMcp = $state<boolean | null>(null);
  #lastMcpSettingsKey: string | null = null;
  #addingProject = $state(false);

  constructor(core: Runtime, initialChatState = window.CAMBER_INITIAL_ACP_CHAT_STATE) {
    this.#core = core;
    this.#initialChatState = initialChatState;

    // Auto-create an empty pending session unless the host handed us a specific session to restore
    // (that path is loaded in initialize() below). keySuffix tracks the agent-server list so a
    // freshly configured agent re-triggers the bootstrap.
    this.#bootstrap = new PendingSessionBootstrap(core, {
      enabled: () => this.#initialChatState?.kind !== "session",
      activeSession: () => this.#activeSession,
      agentServer: () => this.#activeAgentServer(),
      cwd: () => this.#pendingConversationCwd(),
      pendingConversationId: () =>
        this.#activeSession?.pendingConversationId ??
        this.#initialChatState?.conversationId ??
        null,
      keySuffix: () => this.#core.acpRepo.agents.agentServerNames.join("\0"),
    });
  }

  // Registers every effect/onMount this controller owns. Must be called during component init.
  initialize() {
    this.#bootstrap.initialize();

    onMount(async () => {
      const handleDebugDumpLoaded = (event: Event) => {
        const detail = (event as CustomEvent<ACPDebugDumpLoadedEventDetail>).detail;
        if (detail?.conversationId) {
          this.#core.activeConversationId = detail.conversationId;
        }
      };
      this.#core.acpRepo.emitter.addEventListener(
        ACP_DEBUG_DUMP_LOADED_EVENT,
        handleDebugDumpLoaded,
      );
      this.#stopACPDebugDumpSync = () => {
        this.#core.acpRepo.emitter.removeEventListener(
          ACP_DEBUG_DUMP_LOADED_EVENT,
          handleDebugDumpLoaded,
        );
      };

      // Reopening a persisted chat: show its conversation id immediately, then swap to whatever the
      // loaded record resolves to (the two can differ for a pending conversation).
      const initialChatState = this.#initialChatState;
      if (initialChatState?.kind === "session") {
        const cwd = initialChatState.cwd ?? "/";
        const load = this.#core.acpRepo.loadSessionRecord(
          initialChatState.sessionId,
          cwd,
          [],
          {
            conversationId: initialChatState.conversationId,
            ...(initialChatState.readOnly ? { readOnly: true } : {}),
          },
          initialChatState.agentServer,
          { fallbackCwds: initialChatState.fallbackCwds ?? [] },
        );
        this.#core.activeConversationId = initialChatState.conversationId;
        void load.then((session) => {
          if (session) this.#core.activeConversationId = session.conversationId;
        });
      }
    });

    // Keep #activeAllowCustomMcp in sync with the host's per-session "allow custom MCP" setting.
    // Only Camber sessions have it; #lastMcpSettingsKey dedupes so we refetch only when the
    // server/session/config actually changes, and the late-result guard drops stale responses.
    $effect(() => {
      const agentServer = this.#activeAgentServer();
      const sessionId = this.#activeSession?.sessionId ?? null;
      const configKey = (this.#activeSession?.configOptions ?? [])
        .map((o) => `${o.id}=${(o as { currentValue?: string }).currentValue ?? ""}`)
        .join("&");

      if (agentServer !== CAMBER_AGENT_SERVER || !sessionId) {
        this.#activeAllowCustomMcp = null;
        this.#lastMcpSettingsKey = null;
        return;
      }

      const key = `${agentServer}:${sessionId}:${configKey}`;
      if (key === this.#lastMcpSettingsKey) return;
      this.#lastMcpSettingsKey = key;

      void (async () => {
        const value = await fetchAllowCustomMCPServers(agentServer, sessionId);
        if (this.#lastMcpSettingsKey !== key) return;
        this.#activeAllowCustomMcp = value;
      })();
    });

    // Push the chat's agent identity + MCP capabilities up to the host so it can render the panel
    // chrome (title/icon, MCP affordances). Diffed against the last sent value to avoid redundant RPC.
    $effect(() => {
      const agentServer = this.#activeAgentServer();
      const caps = this.#core.acpRepo.agents.capabilitiesFor(agentServer);
      const metadata: PanelMetadata = {
        agentServer,
        agentName: agentName(this.#core.acpRegistry, agentServer),
        agentIconUrl: agentIconUrl(this.#core.acpRegistry, agentServer),
        supportsMcp: caps ? !!caps.mcpCapabilities?.http : null,
        allowCustomMcp: this.#activeAllowCustomMcp,
      };
      if (
        this.#lastSentPanelMetadata?.agentServer === metadata.agentServer &&
        this.#lastSentPanelMetadata.agentName === metadata.agentName &&
        this.#lastSentPanelMetadata.agentIconUrl === metadata.agentIconUrl &&
        this.#lastSentPanelMetadata.supportsMcp === metadata.supportsMcp &&
        this.#lastSentPanelMetadata.allowCustomMcp === metadata.allowCustomMcp
      ) {
        return;
      }

      this.#lastSentPanelMetadata = metadata;
      void rpc.updateAcpChatPanelMetadata(metadata);
    });

    // Persist enough to reopen this exact chat into the VS Code webview state, so the editor tab
    // restores the right conversation/agent/cwd after a reload or window restore.
    $effect(() => {
      const conversationId =
        this.#activeSession?.conversationId ?? this.#initialChatState?.conversationId;
      if (!conversationId) {
        this.#vscode.setState(undefined);
        return;
      }
      const agentServer = this.#activeAgentServer();

      this.#vscode.setState({
        conversationId,
        agentServer,
        sessionId:
          this.#activeSession?.sessionId ??
          (this.#initialChatState?.kind === "session"
            ? this.#initialChatState.sessionId
            : undefined),
        agentName: agentName(this.#core.acpRegistry, agentServer),
        agentIconUrl: agentIconUrl(this.#core.acpRegistry, agentServer),
        cwd:
          this.#activeSession?.sessionInfo?.cwd ??
          this.#activeSession?.pendingCwd ??
          this.#initialChatState?.cwd,
        workingDirectories: this.#initialChatState?.workingDirectories
          ? Array.from(this.#initialChatState.workingDirectories)
          : undefined,
        readOnly:
          this.#initialChatState?.kind === "session" ? this.#initialChatState.readOnly : undefined,
        fallbackCwds:
          this.#initialChatState?.kind === "session" && this.#initialChatState.fallbackCwds
            ? Array.from(this.#initialChatState.fallbackCwds)
            : undefined,
      });
    });

    onDestroy(() => {
      this.#stopACPDebugDumpSync();
    });
  }

  get addingProject() {
    return this.#addingProject;
  }

  get activeConversationId() {
    return this.#core.activeConversationId;
  }

  setActiveConversationId = (id: string | null) => {
    this.#core.activeConversationId = id;
  };

  handleNewConversation = async () => {
    await rpc.openAcpChat({});
  };

  handleAddProject = async () => {
    if (this.#addingProject) return;
    this.#addingProject = true;
    try {
      const project = await rpc.selectProjectFolder();
      if (!project?.path) return;
      await this.#core.acpConversationRepo.refresh();
      await this.#core.acpAgentServers.refresh();
      const agentServer = this.#core.acpRepo.agents.defaultAgentServer || DEFAULT_AGENT_SERVER;
      const conversation = await this.#core.acpConversationRepo.createPendingConversation(
        ACP_IDE_WORKSPACE_PATH,
        project.path,
        agentServer,
        [project.path],
      );
      this.#core.activeConversationId = this.#core.acpRepo.createSession(
        project.path,
        conversation.agentServer,
        conversation.id,
        { isPendingConversationPersisted: true },
      ).conversationId;
    } finally {
      this.#addingProject = false;
    }
  };

  handleShowAgentSettings = () => {
    rpc.openSettings("camber.agentServers");
  };

  #pendingConversationCwd(): string {
    const state = get(appState);
    return acpProtocolCwd(acpWorkspaceFolders(state), resolveSessionCwd(state));
  }

  #activeAgentServer(): string {
    return (
      this.#activeSession?.agentServer ??
      this.#initialChatState?.agentServer ??
      this.#core.acpRepo.agents.defaultAgentServer ??
      DEFAULT_AGENT_SERVER
    );
  }
}
