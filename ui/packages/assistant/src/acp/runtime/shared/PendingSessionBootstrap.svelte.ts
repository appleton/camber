import type { Runtime } from "./types";

type ACPSession = ReturnType<Runtime["acpRepo"]["getSessionByConversationId"]>;

// Owns the "prepare an empty pending session while the target is idle" concern shared by the
// desktop and chat-only runtimes. Each runtime supplies the gate and the agentServer/cwd/pending
// resolvers; the common guards, the dedupe key, and the session-error gate live here so the two
// runtimes cannot drift. The sidebar-only runtime never creates sessions and so never uses this.
// Also keeps prepared drafts' config options fresh: window focus triggers a TTL-gated config
// re-probe for every agent backing a sessionless draft.
export interface PendingSessionBootstrapInputs {
  // Target-specific gate. The bootstrap is skipped while this returns false.
  enabled: () => boolean;
  // The session currently bound to runtime.activeConversationId.
  activeSession: () => ACPSession;
  // Agent server the pending session should use.
  agentServer: () => string;
  // Working directory the pending session should use.
  cwd: () => string;
  // Pending conversation id to attach to the created session.
  pendingConversationId: () => string | null;
  // Extra component appended to the dedupe key (e.g. configured agent server names).
  keySuffix?: () => string;
  // A desktop draft is local: its editor need not wait for the background agent probe.
  // Authentication and configured-agent discovery retain their existing gates.
  prepareWhileConfigLoading?: boolean;
}

export class PendingSessionBootstrap {
  #runtime: Runtime;
  #inputs: PendingSessionBootstrapInputs;
  #preparedKey = $state<string | null>(null);

  constructor(runtime: Runtime, inputs: PendingSessionBootstrapInputs) {
    this.#runtime = runtime;
    this.#inputs = inputs;
  }

  // Registers the auto-create effect. Must be called during component init.
  initialize() {
    const runtime = this.#runtime;
    const inputs = this.#inputs;
    $effect(() => {
      const session = inputs.activeSession();
      const agentServer = inputs.agentServer();
      if (
        !inputs.enabled() ||
        session?.sessionId != null ||
        session?.pendingHandoff != null ||
        session?.loadState.status === "loading" ||
        runtime.acpAgentServers.state.status === "loading" ||
        (!inputs.prepareWhileConfigLoading &&
          runtime.acpRepo.agents.isConfigCacheLoadingFor(agentServer)) ||
        runtime.acpRepo.agents.authRequiredForAgent(agentServer) ||
        session?.isSending ||
        this.sessionError()
      ) {
        return;
      }

      const cwd = inputs.cwd();
      const key = this.#keyFor(agentServer, cwd);
      if (this.#preparedKey === key) return;
      this.#preparedKey = key;
      runtime.activeConversationId = runtime.acpRepo.createSession(
        cwd,
        agentServer,
        inputs.pendingConversationId(),
      ).conversationId;
      (globalThis as { __camberStartupDiag?: (event: string) => void }).__camberStartupDiag?.(
        "boot.draftSessionCreated",
      );
    });

    // ACP only reports config options via session/new, so a draft that sits
    // open across e.g. a model release would show stale options until the
    // next prompt. Returning to the window is the natural moment to catch
    // up; the repo's freshness TTL turns focus bursts into no-ops.
    $effect(() => {
      const onFocus = () =>
        runtime.acpRepo.refreshStaleConfigForLocalSessions(runtime.activeConversationId);
      window.addEventListener("focus", onFocus);
      return () => window.removeEventListener("focus", onFocus);
    });
  }

  sessionError() {
    const session = this.#inputs.activeSession();
    if (session?.loadState.status === "failure") {
      return session.loadState.error;
    }
    return this.#runtime.acpRepo.agents.nonSessionErrorFor(this.#inputs.agentServer());
  }

  // Pre-seed the dedupe key after a runtime imperatively creates a session, so the effect above
  // does not immediately create a second one for the same agentServer/cwd.
  markPrepared(agentServer: string, cwd: string) {
    this.#preparedKey = this.#keyFor(agentServer, cwd);
  }

  #keyFor(agentServer: string, cwd: string): string {
    const suffix = this.#inputs.keySuffix?.() ?? "";
    return suffix ? `${agentServer}\0${cwd}\0${suffix}` : `${agentServer}\0${cwd}`;
  }
}
