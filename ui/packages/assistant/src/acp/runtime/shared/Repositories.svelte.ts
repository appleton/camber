import {
  ACP_DESKTOP_CONVERSATIONS_EVENT,
  ACPConnectionPool,
  agentName,
  createACPWorktreeRepository,
  createAssistantTerminalCommandRunner,
  isClaudeAgent,
  LocalInferenceAgentSync,
  readStoredWorktreeSetupSurface,
  setACPAgentRegistryContext,
  setACPAgentServersContext,
  setACPAgentUpdateContext,
  setACPConnectionPoolContext,
  setACPContext,
  setACPConversationContext,
  setACPConversationStatusContext,
  setACPGithubContext,
  setACPHostActions,
  setACPHostStateStore,
  setACPLocalHistoryContext,
  setACPProjectContext,
  setACPSetupScriptOutputContext,
  setACPWorktreeContext,
  setAssistantTerminalContext,
  setLocalInferenceContext,
  setNotificationContext,
  terminalPlacementForWorktreeSetupSurface,
  type ACPConversationsState,
  type Notifier,
} from "@camber/features/acp";
import { setContextRepoContext } from "@camber/features/context";
import { setElicitationContext } from "@camber/features/elicitation";
import { setSecretsContext } from "@camber/features/secrets";
import { initializeStatefulModule as initializeHelperApi } from "@camber/helperapi";
import { onDestroy } from "svelte";
import { get } from "svelte/store";

import { acpDebugRPCHandlers } from "../../../lib/rpc/acpDebugRPC";
import { createHelperApiClient, rpc } from "../../../lib/rpc/client";
import { installDebugRPC } from "../../../lib/rpc/debugRPC";
import { appState } from "../../../lib/store";
import { trackClick } from "../../../lib/telemetry/interactions";
import type { RuntimeProps } from "./types";

interface RepositoriesOptions {
  notifier?: Notifier;
  onACPConnectionPoolReady?: RuntimeProps["onACPConnectionPoolReady"];
}

// Builds and provides the ACP repositories, helper API client, connection pool, and notifications.
// The constructor provides every context (which must happen during component init); initialize()
// installs the debug RPC bridge. Construction order matters: notification → conversation-status →
// elicitation → session repo (see #175); the task repo feeds the connection pool (see #130).
export class Repositories {
  readonly acpRegistry = setACPAgentRegistryContext();
  readonly assistantTerminals = setAssistantTerminalContext();
  readonly setupScriptOutputs = setACPSetupScriptOutputContext();
  readonly helperApiClient = createHelperApiClient();
  readonly acpProjectRepo = setACPProjectContext();
  readonly acpGithubRepo = setACPGithubContext();
  readonly acpConversationRepo: ReturnType<typeof setACPConversationContext>;
  readonly acpLocalHistoryRepo = setACPLocalHistoryContext();
  readonly acpContextRepo = setContextRepoContext();
  readonly notificationRepo: ReturnType<typeof setNotificationContext>;
  readonly acpConversationStatusRepo: ReturnType<typeof setACPConversationStatusContext>;
  readonly elicitation: ReturnType<typeof setElicitationContext>;
  readonly acpRepo: ReturnType<typeof setACPContext>;
  readonly acpConnectionPool: ACPConnectionPool;
  readonly acpAgentServers: ReturnType<typeof setACPAgentServersContext>;
  readonly acpAgentUpdates: ReturnType<typeof setACPAgentUpdateContext>;
  readonly localInference = setLocalInferenceContext();
  readonly localInferenceAgentSync: LocalInferenceAgentSync | undefined;
  readonly secrets: ReturnType<typeof setSecretsContext>;

  constructor({ notifier, onACPConnectionPoolReady }: RepositoriesOptions) {
    initializeHelperApi(this.helperApiClient);
    this.secrets = setSecretsContext({ rpc });
    setACPWorktreeContext(
      createACPWorktreeRepository(
        createAssistantTerminalCommandRunner(this.assistantTerminals, this.setupScriptOutputs, {
          setupInVisibleTerminal: get(appState).environment.assistantHost === "desktop",
          setupPlacement: () =>
            terminalPlacementForWorktreeSetupSurface(readStoredWorktreeSetupSurface()),
        }),
      ),
    );
    this.notificationRepo = setNotificationContext(
      (agentServer, sessionId) => {
        const session = this.acpRepo.getSessionById(sessionId, agentServer);
        void rpc.openAcpChat({ conversationId: session?.conversationId, agentServer, sessionId });
      },
      (agentServer) => agentName(this.acpRegistry, agentServer),
      () => !!get(appState).userSettings.notifyOnApproval,
      () => get(appState).isEditorFocused,
      notifier,
    );
    this.acpConversationStatusRepo = setACPConversationStatusContext(
      this.notificationRepo.publicAPI(),
    );
    this.elicitation = setElicitationContext(this.acpConversationStatusRepo.publicAPI());
    this.acpRepo = setACPContext(
      this.acpConversationStatusRepo.publicAPI(),
      this.elicitation,
      (agentServer) => isClaudeAgent(this.acpRegistry, agentServer),
    );
    this.acpConversationRepo = setACPConversationContext(this.acpRepo.agents);
    // Feed the helper-pushed per-conversation liveStatus into the status
    // repository: it is the only signal for turns driven on another surface,
    // and the session repository's eviction / idle-close protection consults
    // the status repository.
    this.acpConversationRepo.emitter.addEventListener(ACP_DESKTOP_CONVERSATIONS_EVENT, (event) => {
      const detail = (event as CustomEvent<ACPConversationsState>).detail;
      this.acpConversationStatusRepo.syncRemoteStatuses(detail?.sessions ?? []);
    });

    setACPHostStateStore(appState);
    setACPHostActions({ trackClick });

    this.acpConnectionPool = new ACPConnectionPool(this.helperApiClient, this.acpRepo);
    this.acpRepo.agents.setConnectionPool(this.acpConnectionPool);
    this.acpRepo.agents.setHelperApiClient(this.helperApiClient);
    setACPConnectionPoolContext(this.acpConnectionPool);
    onACPConnectionPoolReady?.(this.acpConnectionPool);

    this.acpAgentServers = setACPAgentServersContext({ appState, sessionRepo: this.acpRepo });
    this.acpAgentUpdates = setACPAgentUpdateContext({
      appState,
      registryRepo: this.acpRegistry,
      sessionRepo: this.acpRepo,
    });
    if (get(appState).environment.assistantHost === "desktop") {
      this.localInferenceAgentSync = new LocalInferenceAgentSync(this.localInference, this.acpRepo);
    }
  }

  // Installs the debug RPC bridge over the connection pool; torn down on unmount.
  initialize() {
    onDestroy(installDebugRPC(acpDebugRPCHandlers(this.acpConnectionPool.debug)));
  }
}
