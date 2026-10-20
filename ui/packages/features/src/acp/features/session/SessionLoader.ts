import type {
  ClientSideConnection,
  LoadSessionResponse,
  McpServer,
  SessionConfigOption,
  SessionId,
} from "@agentclientprotocol/sdk";
import { failure, isSuccess, loading, success, waiting } from "@camber/lib/async-state";
import { withClaudeSessionFeatures } from "../../claudePromptSuggestions";
import { normalizeACPError } from "../../errors";
import { appState, appStateUpdates } from "../../hostAdapter";
import { mergeLocalInferenceModelConfigOptionDefinitionsForAgent } from "../../localInferenceModelOptions";
import {
  buildSessionInfo,
  mergeSeedSessionInfo,
  type ACPResolvedSessionInfo,
} from "../../sessionInfo";
import { TurnMaterializer } from "../../TurnMaterializer";
import {
  applySessionConfigSelections,
  currentConfigSelections,
  findModeConfigOption,
  mergeConfigSelections,
  syncModeFromConfigOptions,
  updateSessionModeValue,
  type ACPSessionConfigSnapshot,
} from "./configOptions";
import { isSessionActiveError } from "./errors";
import type { ACPSession } from "./Session.svelte";
import { loadPersistedSessionConfig } from "./SessionMetadata";
import type { ACPSessionLoadState } from "./types";

export class ACPSessionLoader {
  constructor(private readonly session: ACPSession) {}

  buildLoadState(): ACPSessionLoadState {
    const s = this.session;
    if (s.sessionId === null) {
      throw new Error("Cannot build load state before an agent-side session exists");
    }
    return {
      sessionId: s.sessionId,
      agentServer: s.agentServer,
      sessionInfo: s.sessionInfo,
      events: [...s.events],
      plan: s.plan,
      configOptions: [...s.configOptions],
      availableCommands: [...s.availableCommands],
      modes: s.modes,
    };
  }

  async loadExisting(
    gen: number,
    cwd: string,
    mcpServers: McpServer[],
    seedInfo?: Partial<ACPResolvedSessionInfo>,
    fallbackCwds: string[] = [],
    allowLiveAttach = true,
  ): Promise<void> {
    const s = this.session;
    if (gen !== s.generation || s.sessionId === null) return;
    const sessionId = s.sessionId;
    const agentServer = s.agentServer;
    // A connector refresh (allowLiveAttach=false) can be refused because a
    // turn started after the caller's status check; the pane is then restored
    // to exactly this state.
    const priorPane = {
      loadState: s.loadState,
      loadIntent: s.loadIntent,
      loadingCwd: s.loadingCwd,
      promptError: s.promptError,
    };
    s.clearPromptSuggestion();

    const [storedConfig] = await Promise.all([
      loadPersistedSessionConfig(s).catch(() => null),
      s.env.agents.loadCachedConfigFromStore(agentServer),
    ]);
    if (gen !== s.generation) return;
    if (storedConfig) {
      s.metadata = { ...s.metadata, sessionConfig: storedConfig };
    }

    s.loadingCwd = cwd || "/";
    s.loadIntent = "load";
    s.loadState = loading;
    s.env.agents.clearNonSessionError(agentServer);
    s.promptError = null;

    const conn = await s.env.agents.useAgentServer(agentServer);
    if (gen !== s.generation) return;
    if (!conn) {
      s.loadState = waiting;
      return;
    }

    s.replayMaterializer = new TurnMaterializer();
    s.replaySessionInfo = mergeSeedSessionInfo(sessionId, cwd || "/", seedInfo);
    if (!allowLiveAttach) s.connectorRefreshCapture = [];

    try {
      if (!s.env.agents.capabilitiesFor(agentServer)?.loadSession) {
        throw new Error(`Agent server "${agentServer}" does not support loading sessions`);
      }

      const localModelDefinitions = this.localModelDefinitions();
      const res = await this.loadSessionWithFallbacks(
        gen,
        conn,
        sessionId,
        cwd,
        mcpServers,
        [...fallbackCwds],
        allowLiveAttach,
      );
      if (gen !== s.generation) return;
      const liveAttach = res._meta?.["camber/liveAttach"] === true;
      if (!liveAttach) s.replayMaterializer?.completeOpenToolCalls();
      s.materializer = s.replayMaterializer ?? new TurnMaterializer();
      s.sessionInfo = s.replaySessionInfo;
      s.publishTranscript();
      const reportedConfigOptions = res.configOptions ?? [];
      s.configOptions = mergeLocalInferenceModelConfigOptionDefinitionsForAgent(
        agentServer,
        reportedConfigOptions,
        localModelDefinitions,
      );
      s.availableCommands = s.env.agents.cachedAvailableCommands(agentServer);
      s.modes = res.modes ?? null;
      s.pendingConfigOptions = {};
      // A live attach reports the running agent's configuration. Reapplying
      // an older UI snapshot here can restart the agent or change its model.
      if (!liveAttach) {
        await this.applyPersistedSessionConfig(gen, conn, storedConfig, reportedConfigOptions);
      }
      if (gen !== s.generation) return;
      // Transport implementations may settle the load response independently
      // from replay delivery. Publish once more after persisted config is
      // restored so any replay updates accepted during that window cannot
      // remain materialized but invisible.
      if (!liveAttach) s.replayMaterializer?.completeOpenToolCalls();
      if (s.replayMaterializer) {
        s.titles.finalizeInlineTitle(s.replayMaterializer, { replay: true });
      }
      s.sessionInfo = s.replaySessionInfo;
      s.publishTranscript();
      // A load that replays nothing means the agent could not restore any
      // history for this conversation, even though it accepted the load —
      // either the history is lost agent-side or the conversation never had a
      // completed turn. Record it here, where the replay has settled, so the
      // pane can say so instead of rendering the conversation as a brand-new
      // chat.
      s.restoredWithoutHistory = s.events.length === 0;
      // The agent authoritatively reported no config surface for this
      // session, so any stored snapshot is obsolete.
      if (s.configOptions.length === 0 && s.modes === null) {
        s.metadataManager.dropSessionConfig();
      }
      // Re-persist the settled snapshot: stale selections that were skipped
      // above drop out of storage, and pre-snapshot conversations get
      // backfilled with their current config.
      s.metadataManager.refresh();
      s.loadingCwd = null;
      s.titles.emit(s.sessionInfo?.title);
      appState.update(appStateUpdates.ensureWorkspaceForCwd(s.sessionInfo?.cwd));
      void s.env.agents.upsertCachedConfig(agentServer, {
        configOptions: s.configOptions,
        availableCommands: s.availableCommands,
        modes: s.modes,
      });
      // A real reload delivers the current connector set. A live-attach
      // snapshot does not touch the agent session, so a deferred refresh
      // must survive it.
      if (!liveAttach) s.connectorRefreshDeferred = false;
      s.loadState = success(this.buildLoadState());
      s.env.publishLiveStatuses();
    } catch (e) {
      if (gen !== s.generation) return;
      const error = normalizeACPError(e);
      if (!allowLiveAttach && isSessionActiveError(error)) {
        // A turn started between the connector refresh's status check and
        // the helper's answer. Nothing changed agent-side: restore the pane as
        // it was, put the live updates captured meanwhile back on the live
        // transcript (synchronously, before clearReplay in finally, so later
        // live updates cannot overtake them), and defer the refresh to
        // turnEnded.
        s.loadState = priorPane.loadState;
        s.loadIntent = priorPane.loadIntent;
        s.loadingCwd = priorPane.loadingCwd;
        s.promptError = priorPane.promptError;
        for (const update of s.connectorRefreshCapture ?? []) {
          s.applySessionUpdate(update);
        }
        s.publishTranscript();
        s.connectorRefreshDeferred = true;
        return;
      }
      s.loadState = failure(error);
      s.loadingCwd = null;
    } finally {
      s.connectorRefreshCapture = null;
      if (gen === s.generation) {
        s.transcript.clearReplay();
      }
    }
  }

  /**
   * Reconnect the current session with the helper's latest MCP server set.
   * Prefer session/resume so the transcript stays untouched; older agents fall
   * back to the existing session/load replay path.
   */
  async refreshMCPServers(
    gen: number,
    { trustRemoteStatus = true }: { trustRemoteStatus?: boolean } = {},
  ): Promise<boolean> {
    const s = this.session;
    if (gen !== s.generation || s.sessionId === null) return false;
    // A running turn can take neither a resume nor a reload: the helper
    // refuses both without interrupting the agent. Skip the wire entirely and
    // retry once the turn ends (handleTurnEnded), so the live pane never flips
    // into a load state and live updates are never captured by a replay
    // materializer and discarded. The retry path distrusts the helper-pushed
    // status, which can lag turnEnded, and lets the helper be the authority.
    if (
      s.isPromptActive ||
      (trustRemoteStatus && s.env.isConversationWorking(s.sessionId, s.agentServer))
    ) {
      s.connectorRefreshDeferred = true;
      return false;
    }
    s.connectorRefreshDeferred = false;
    s.clearPromptSuggestion();

    const sessionId = s.sessionId;
    const agentServer = s.agentServer;
    const cwd = s.sessionInfo?.cwd || s.cwd || s.loadingCwd || "/";
    const conn = await s.env.agents.useAgentServer(agentServer);
    if (gen !== s.generation || !conn) return false;

    const supportsResume =
      s.env.agents.capabilitiesFor(agentServer)?.sessionCapabilities?.resume != null;
    if (supportsResume) {
      try {
        const _meta = withClaudeSessionFeatures(
          agentServer,
          undefined,
          s.env.isClaudeAgent(agentServer),
        );
        const res = await conn.resumeSession({
          sessionId,
          cwd,
          mcpServers: [],
          ...(_meta ? { _meta } : {}),
        });
        if (gen !== s.generation) return false;

        // Some agents recreate the underlying session when its MCP server set
        // changes, so their resume response contains agent-wide defaults rather
        // than this conversation's selections. Capture those selections before
        // the response replaces the local config surface, then restore them
        // below. Capturing after resume settles (rather than before the call)
        // keeps a user config change that landed mid-resume as the winner.
        const { configSelections, modeSelection } = this.captureConfigSelections();
        const localModelDefinitions = this.localModelDefinitions();

        let configChanged = false;
        let reportedConfigOptions: SessionConfigOption[] | undefined;
        if (res.configOptions !== undefined) {
          reportedConfigOptions = res.configOptions ?? [];
          s.configOptions = mergeLocalInferenceModelConfigOptionDefinitionsForAgent(
            agentServer,
            reportedConfigOptions,
            localModelDefinitions,
          );
          s.pendingConfigOptions = {};
          configChanged = true;
        }
        if (res.modes !== undefined) {
          s.modes = res.modes ?? null;
          configChanged = true;
        }
        if (configChanged) {
          await this.restoreSessionConfigSelections(
            gen,
            conn,
            configSelections,
            modeSelection,
            reportedConfigOptions,
          );
          if (gen !== s.generation) return false;
          s.metadataManager.refresh();
          void s.env.agents.upsertCachedConfig(agentServer, {
            configOptions: s.configOptions,
            availableCommands: s.availableCommands,
            modes: s.modes,
          });
        }
        s.env.agents.clearNonSessionError(agentServer);
        return true;
      } catch {
        // An agent can reject either resume or re-applying its previous config.
        // Loading the same session is the interoperable fallback.
      }
    }

    // A snapshot cannot apply new connectors. Require an actual idle reload
    // here; the helper rejects an active turn without interrupting it, and
    // loadExisting restores the pane and defers the refresh in that case.
    await this.loadExisting(gen, cwd, [], s.sessionInfo ?? undefined, [], false);
    // A deferred refresh restores the previous (successful) load state; it is
    // still not applied.
    return gen === s.generation && isSuccess(s.loadState) && !s.connectorRefreshDeferred;
  }

  // Attempts session/load with each cwd in turn. Agents may reject a load when
  // the working directory no longer exists (e.g. a removed worktree); retrying
  // with a surviving directory keeps the transcript reachable. Each attempt
  // starts a fresh replay materializer so a partially-streamed failed attempt
  // cannot double-append events.
  private async loadSessionWithFallbacks(
    gen: number,
    conn: ClientSideConnection,
    sessionId: SessionId,
    cwd: string,
    mcpServers: McpServer[],
    fallbackCwds: string[],
    allowLiveAttach: boolean,
  ): Promise<LoadSessionResponse> {
    const s = this.session;
    const cwds = [cwd, ...fallbackCwds].filter(
      (candidate, index, all) => candidate && all.indexOf(candidate) === index,
    );
    let lastError: unknown;
    for (const [index, candidate] of cwds.entries()) {
      if (index > 0) {
        if (gen !== s.generation) throw lastError;
        s.replayMaterializer = new TurnMaterializer();
      }
      try {
        const _meta = withClaudeSessionFeatures(
          s.agentServer,
          undefined,
          s.env.isClaudeAgent(s.agentServer),
        );
        return await conn.loadSession({
          sessionId,
          cwd: candidate,
          mcpServers,
          _meta: { ..._meta, "camber/liveAttach": allowLiveAttach },
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("No working directory available to load the session");
  }

  private async applyPersistedSessionConfig(
    gen: number,
    conn: ClientSideConnection,
    stored: ACPSessionConfigSnapshot | null,
    reportedConfigOptions = this.session.configOptions,
  ): Promise<void> {
    const s = this.session;
    if (!stored || gen !== s.generation || s.sessionId === null) return;
    const sessionId = s.sessionId;

    // applySessionConfigSelections drops selections whose option no longer
    // exists or no longer offers the stored value.
    const selections = new Map(Object.entries(stored.selections));

    try {
      const result = await applySessionConfigSelections({
        conn,
        sessionId,
        configOptions: s.configOptions,
        reportedConfigOptions,
        selections,
        isCurrent: () => gen === s.generation && s.sessionId !== null,
        reconcileConfigOptions: (reported, fallback) =>
          mergeLocalInferenceModelConfigOptionDefinitionsForAgent(
            s.agentServer,
            reported,
            fallback,
          ),
        onApplied: (configOptions) => {
          s.configOptions = configOptions;
          s.modes = syncModeFromConfigOptions(s.modes, s.configOptions);
        },
      });
      if (!result || gen !== s.generation) return;
      s.configOptions = result;

      // Mode fallback: if stored a modeId, no mode config option, mode differs, and mode exists
      const hasModeConfig = Boolean(findModeConfigOption(s.configOptions));
      if (
        stored.modeId &&
        !hasModeConfig &&
        s.modes?.currentModeId !== stored.modeId &&
        s.modes?.availableModes.some((m) => m.id === stored.modeId)
      ) {
        await conn.setSessionMode({ sessionId, modeId: stored.modeId });
        if (gen !== s.generation) return;
        s.modes = updateSessionModeValue(s.modes, stored.modeId);
      }
    } catch (e) {
      // A failure to re-apply must NOT fail the load
      console.warn("acp: failed to re-apply persisted session config", e);
    }
  }

  async restoreAfterReconnect(gen: number, conn: ClientSideConnection): Promise<boolean> {
    const s = this.session;
    const agentServer = s.agentServer;
    if (!s.restoreRequired) {
      return true;
    }
    if (gen !== s.generation || s.sessionId === null) {
      return false;
    }
    s.clearPromptSuggestion();

    if (!s.env.agents.capabilitiesFor(agentServer)?.loadSession) {
      return false;
    }

    const sessionId = s.sessionId;
    const cwd = s.sessionInfo?.cwd ?? "/";
    s.loadIntent = "load";
    s.loadState = loading;
    s.replayMaterializer = new TurnMaterializer();
    s.replaySessionInfo = s.sessionInfo ?? buildSessionInfo(sessionId, cwd);

    try {
      const _meta = withClaudeSessionFeatures(
        agentServer,
        undefined,
        s.env.isClaudeAgent(agentServer),
      );
      const res = await conn.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
        ...(_meta ? { _meta } : {}),
      });
      if (gen !== s.generation) return false;
      const { configSelections, modeSelection } = this.captureConfigSelections();
      const localModelDefinitions = this.localModelDefinitions();
      const reportedConfigOptions = res.configOptions ?? [];
      s.configOptions = mergeLocalInferenceModelConfigOptionDefinitionsForAgent(
        agentServer,
        reportedConfigOptions,
        localModelDefinitions,
      );
      s.availableCommands = s.env.agents.cachedAvailableCommands(agentServer);
      s.modes = res.modes ?? null;
      await this.restoreSessionConfigSelections(
        gen,
        conn,
        configSelections,
        modeSelection,
        reportedConfigOptions,
      );
      if (gen !== s.generation) return false;
      if (s.replayMaterializer) {
        s.titles.finalizeInlineTitle(s.replayMaterializer, { replay: true });
      }
      s.sessionInfo = s.replaySessionInfo;
      s.restoreRequired = false;
      void s.env.agents.upsertCachedConfig(agentServer, {
        configOptions: s.configOptions,
        availableCommands: s.availableCommands,
        modes: s.modes,
      });
      s.loadState = success(this.buildLoadState());
      s.env.agents.clearNonSessionError(agentServer);
      return true;
    } catch (e) {
      if (gen !== s.generation) return false;
      s.loadState = failure(normalizeACPError(e));
      return false;
    } finally {
      if (gen === s.generation) {
        s.transcript.clearReplay();
      }
    }
  }

  // Snapshot the conversation's current config selections so they can be
  // re-applied after a resume/load response overwrites the local surface.
  // Options with a user change still in flight are skipped: that request
  // will land its own newer value, and re-applying the captured (older) one
  // would revert the user's choice.
  private captureConfigSelections(): {
    configSelections: Map<string, string | boolean>;
    modeSelection: string | null | undefined;
  } {
    const s = this.session;
    const configSelections = currentConfigSelections(s.configOptions);
    for (const [configId, pending] of Object.entries(s.pendingConfigOptions)) {
      if (pending.error === null) configSelections.delete(configId);
    }
    const modeConfig = findModeConfigOption(s.configOptions);
    return { configSelections, modeSelection: modeConfig ? null : s.modes?.currentModeId };
  }

  private localModelDefinitions(): SessionConfigOption[] {
    const s = this.session;
    const cached = s.env.agents.cachedConfigFor(s.agentServer)?.configOptions ?? [];
    return mergeLocalInferenceModelConfigOptionDefinitionsForAgent(
      s.agentServer,
      s.configOptions,
      cached,
    );
  }

  private async restoreSessionConfigSelections(
    gen: number,
    conn: ClientSideConnection,
    configSelections: Map<string, string | boolean>,
    modeSelection: string | null | undefined,
    reportedConfigOptions = this.session.configOptions,
  ): Promise<void> {
    const s = this.session;
    if (gen !== s.generation || s.sessionId === null) return;

    // s.configOptions currently holds the agent's response (its defaults).
    // Show the captured selections immediately and reconcile against the
    // response over the wire, so the picker never flashes the defaults while
    // the restore is in flight.
    const agentConfigOptions = s.configOptions;
    s.configOptions = mergeConfigSelections(agentConfigOptions, configSelections);
    s.modes = syncModeFromConfigOptions(s.modes, s.configOptions);

    const configOptions = await applySessionConfigSelections({
      conn,
      sessionId: s.sessionId,
      configOptions: agentConfigOptions,
      reportedConfigOptions,
      selections: configSelections,
      isCurrent: () => gen === s.generation && s.sessionId !== null,
      reconcileConfigOptions: (reported, fallback) =>
        mergeLocalInferenceModelConfigOptionDefinitionsForAgent(s.agentServer, reported, fallback),
      onApplied: (configOptions) => {
        s.configOptions = mergeConfigSelections(configOptions, configSelections);
        s.modes = syncModeFromConfigOptions(s.modes, s.configOptions);
      },
    });
    if (!configOptions) return;
    s.configOptions = configOptions;
    s.modes = syncModeFromConfigOptions(s.modes, s.configOptions);

    const hasModeConfig = Boolean(findModeConfigOption(s.configOptions));
    if (!modeSelection || hasModeConfig || s.modes?.currentModeId === modeSelection) return;
    // A mode the agent no longer offers would be rejected; keep its default.
    if (s.modes && !s.modes.availableModes.some((mode) => mode.id === modeSelection)) return;
    s.modes = s.modes
      ? updateSessionModeValue(s.modes, modeSelection)
      : { currentModeId: modeSelection, availableModes: [] };
    await conn.setSessionMode({ sessionId: s.sessionId, modeId: modeSelection });
  }
}
