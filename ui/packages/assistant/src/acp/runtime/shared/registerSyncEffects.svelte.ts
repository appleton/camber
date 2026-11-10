import {
  AggregatedSessionListSource,
  refreshACPNavState,
  wireACPHistorySync,
  wireACPSessionSync,
} from "@camber/features/acp";
import { onDestroy, onMount } from "svelte";
import { get } from "svelte/store";

import { appState, resolveSessionCwd } from "../../../lib/store";
import type { Repositories } from "./Repositories.svelte";
import { watchAgentUpdates } from "./watchAgentUpdates";

interface RegisterSyncEffectsOptions {
  repositories: Repositories;
}

// Hosts that install startup diagnostics (desktop) receive these checkpoints
// in the boot log; elsewhere the optional global is absent and they no-op.
function bootDiag(event: string): void {
  (globalThis as { __camberStartupDiag?: (event: string) => void }).__camberStartupDiag?.(event);
}

// Wires ACP history/session sync, local history source, nav polling, and initial refreshes.
export function registerSyncEffects({ repositories }: RegisterSyncEffectsOptions) {
  let stopACPHistorySync = () => {};
  let stopACPSessionSync = () => {};
  let stopACPNavPoll = () => {};
  let stopAgentUpdates = () => {};

  onMount(() => {
    stopAgentUpdates = watchAgentUpdates(async () => {
      await Promise.allSettled([
        repositories.acpRegistry.load(),
        repositories.acpAgentServers
          .refresh({ background: true })
          .then(() => bootDiag("boot.agentServersLoaded")),
      ]);
      repositories.acpAgentUpdates.refresh();
    });
    repositories.acpAgentServers.configureSessionRepo();
    repositories.acpLocalHistoryRepo.setListSource(
      new AggregatedSessionListSource(
        () => repositories.acpRepo.agents.agentServerNames,
        (agentServer) => repositories.acpRepo.agents.connectServer(agentServer),
        (agentServer) => repositories.acpRepo.agents.getInitializeResponse(agentServer),
      ),
    );
    stopACPHistorySync = wireACPHistorySync({
      emitter: repositories.acpRepo.emitter,
      capture: repositories.acpConnectionPool.debug.capture,
      history: {
        hideSession: (conversationId) =>
          repositories.acpConversationRepo.hideSession(conversationId),
        showSession: (conversationId) =>
          repositories.acpConversationRepo.showSession(conversationId),
        upsertConversation: (workspacePath, session) =>
          repositories.acpConversationRepo.upsertConversation(workspacePath, session),
        updateSessionTitle: (conversationId, title) =>
          repositories.acpConversationRepo.updateSessionTitle(conversationId, title),
        touchSession: (conversationId) =>
          repositories.acpConversationRepo.touchSession(conversationId),
      },
      getRefreshCwd: () => resolveSessionCwd(get(appState)),
    });
    stopACPSessionSync = wireACPSessionSync({
      emitter: repositories.acpConversationRepo.emitter,
      capture: repositories.acpConnectionPool.debug.capture,
      sessions: repositories.acpRepo,
    });
    const pollInterval = window.setInterval(() => {
      if (document.hidden) return;
      void refreshACPNavState(repositories.acpProjectRepo, repositories.acpConversationRepo);
    }, 5000);
    stopACPNavPoll = () => window.clearInterval(pollInterval);

    // One combined acpNav/list feeds both repos; separate refresh() calls
    // would issue the same helper RPC twice at the moment the helper is
    // busiest (cold start). Falls back to per-repo refreshes on failure.
    void refreshACPNavState(repositories.acpProjectRepo, repositories.acpConversationRepo).then(
      () => bootDiag("boot.navListApplied"),
    );
    // Boot snapshot: approvals pending from before this surface connected
    // (e.g. an agent waiting on a prompt while the app was closed). Steady-state
    // changes arrive via didChange; reconnect owners request another snapshot.
    void repositories.acpRepo.refreshApprovals();
  });

  onDestroy(() => {
    stopACPHistorySync();
    stopACPSessionSync();
    stopACPNavPoll();
    stopAgentUpdates();
  });
}
