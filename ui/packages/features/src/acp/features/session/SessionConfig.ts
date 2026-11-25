import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { normalizeACPError, type ACPRequestError } from "../../errors";
import {
  applyDefaultConfigOptions,
  collaborationModeSurface,
  currentConfigSelections,
  exitModeForConfigOption,
  exitModeForModes,
  findCollaborationModeConfigOption,
  findModeConfigOption,
  isModeConfigOption,
  mergeConfigSelections,
  planValueForConfigOption,
  shouldPersistConfigSelection,
  syncModeFromConfigOptions,
  updateBooleanConfigOptionValue,
  updateConfigOptionValue,
  updateSessionModeValue,
} from "./configOptions";
import { isStaleSessionError } from "./errors";
import type { ACPSession } from "./Session.svelte";
import type { ACPCollaborationModeSurface, ACPPendingConfigOption } from "./types";
import { ACP_PLAN_MODE_ID } from "./types";

export class ACPSessionConfig {
  constructor(private readonly session: ACPSession) {}

  applyCached(): void {
    const s = this.session;
    const cached = s.env.agents.cachedConfigFor(s.agentServer);
    if (!cached) {
      s.configOptions = [];
      s.availableCommands = [];
      s.modes = null;
      return;
    }
    s.configOptions = applyDefaultConfigOptions(
      cached.configOptions ?? [],
      s.env.agents.defaultConfigOptionsFor(s.agentServer),
    );
    s.availableCommands = cached.availableCommands ?? [];
    s.modes = syncModeFromConfigOptions(cached.modes ?? null, s.configOptions);
    this.resetInheritedPlanMode();
  }

  /**
   * applyCached, but re-impose the choices the user explicitly made on THIS
   * session, where the refreshed definitions still offer them. Background
   * refreshes (window-focus probes, probe streaming updates) use this:
   * applyCached alone pipes the cache through the configured defaults, which
   * would silently reset a draft's picker choices — and collapse divergent
   * same-agent drafts onto the single shared cache slot.
   *
   * Only user-touched options are preserved. Values the draft merely
   * inherited must keep tracking the cache, otherwise a newly remembered
   * last-used value (or a changed agent default) could never reach an open
   * draft.
   */
  applyCachedPreservingSelections(): void {
    const s = this.session;
    const touched = s.userSelectedConfigIds;
    const selections = new Map(
      [...currentConfigSelections(s.configOptions)].filter(([configId]) => touched.has(configId)),
    );
    const modeId = s.userSelectedMode ? (s.modes?.currentModeId ?? null) : null;
    this.applyCached();
    if (selections.size > 0) {
      s.configOptions = mergeConfigSelections(s.configOptions, selections);
      s.modes = syncModeFromConfigOptions(s.modes, s.configOptions);
    }
    // Legacy mode state without a mode config option: restore the user's
    // chosen mode directly when the refreshed list still offers it.
    if (
      modeId &&
      !findModeConfigOption(s.configOptions) &&
      s.modes?.availableModes.some((mode) => mode.id === modeId)
    ) {
      s.modes = updateSessionModeValue(s.modes, modeId);
    }
  }

  // Remember an explicit user choice, both on the session (so a background
  // re-apply keeps it here) and on the agent (so it survives a probe and, for
  // options with known-safe semantics, seeds the next new conversation — see
  // shouldPersistConfigSelection). Mode-shaped choices (permission mode,
  // build/plan collaboration — including the ones togglePlanMode routes
  // through setOption) and other options this client cannot classify are
  // session state, not defaults: they are recorded in memory only, never
  // persisted, so one permission-relaxing session — or one pick on an
  // unclassified "extras" option — cannot become every future conversation's
  // starting state.
  #recordUserSelection(configId: string, value: string | boolean): void {
    const s = this.session;
    s.userSelectedConfigIds = new Set(s.userSelectedConfigIds).add(configId);
    const option = s.configOptions.find((candidate) => candidate.id === configId);
    s.env.agents.recordUserConfigSelection(s.agentServer, configId, value, {
      persist: option !== undefined && shouldPersistConfigSelection(option),
    });
  }

  #recordUserModeSelection(modeId: string): void {
    const s = this.session;
    s.userSelectedMode = true;
    s.env.agents.recordUserModeSelection(s.agentServer, modeId);
  }

  async setMode(modeId: string): Promise<void> {
    const s = this.session;
    const agentServer = s.agentServer;
    this.#recordUserModeSelection(modeId);
    if (s.sessionId === null) {
      return s.serialize(async (gen) => {
        if (gen !== s.generation) return;
        s.modes = updateSessionModeValue(s.modes, modeId);
        await this.upsertCachedConfig(agentServer);
      });
    }

    const sessionId = s.sessionId;
    const gen = s.generation;
    return s.enqueueConfigOption("mode", async () => {
      // A suspended session's agent side was closed while idle; reattach
      // before the wire call or it answers "session not found".
      if (s.suspended && !(await s.reattachSuspendedCore(gen))) return;
      const conn = await s.env.agents.activate(agentServer);
      if (gen !== s.generation || !conn) return;
      try {
        await conn.setSessionMode({ sessionId, modeId });
      } catch (e) {
        this.markSuspendedOnStaleError(e);
        throw e;
      }
      if (gen !== s.generation) return;
      s.modes = updateSessionModeValue(s.modes, modeId);
      void this.upsertCachedConfig(agentServer);
      s.metadataManager.refresh();
    });
  }

  async setOption(configId: string, value: string): Promise<void> {
    const s = this.session;
    const agentServer = s.agentServer;
    this.#recordUserSelection(configId, value);
    if (s.sessionId === null) {
      return s.serialize(async (gen) => {
        if (gen !== s.generation) return;
        s.configOptions = updateConfigOptionValue(s.configOptions, configId, value);
        const modeConfig = s.configOptions.find((option) => option.id === configId);
        if (isModeConfigOption(modeConfig)) {
          s.modes = updateSessionModeValue(s.modes, modeConfig.currentValue);
        }
        await this.upsertCachedConfig(agentServer);
      });
    }

    const sessionId = s.sessionId;
    const gen = s.generation;
    const requestId = s.nextConfigRequestId();
    return s
      .enqueueConfigOption(configId, async () => {
        this.setPending({ configId, value, requestId, error: null });
        if (s.suspended && !(await s.reattachSuspendedCore(gen))) {
          this.clearPending(configId, requestId);
          return;
        }
        const conn = await s.env.agents.activate(agentServer);
        if (gen !== s.generation || !conn) {
          this.clearPending(configId, requestId);
          return;
        }
        const res = await conn.setSessionConfigOption({ sessionId, configId, value });
        if (gen !== s.generation) {
          this.clearPending(configId, requestId);
          return;
        }
        this.applyOptions(
          res?.configOptions ?? updateConfigOptionValue(s.configOptions, configId, value),
          requestId,
          configId,
        );
      })
      .catch((e: unknown) => {
        const err = normalizeACPError(e);
        this.markSuspendedOnStaleError(err);
        this.failPending(configId, requestId, err);
        throw err;
      });
  }

  async setBooleanOption(configId: string, value: boolean): Promise<void> {
    const s = this.session;
    const agentServer = s.agentServer;
    this.#recordUserSelection(configId, value);
    if (s.sessionId === null) {
      return s.serialize(async (gen) => {
        if (gen !== s.generation) return;
        s.configOptions = updateBooleanConfigOptionValue(s.configOptions, configId, value);
        await this.upsertCachedConfig(agentServer);
      });
    }

    const sessionId = s.sessionId;
    const gen = s.generation;
    const requestId = s.nextConfigRequestId();
    return s
      .enqueueConfigOption(configId, async () => {
        this.setPending({ configId, value: String(value), requestId, error: null });
        if (s.suspended && !(await s.reattachSuspendedCore(gen))) {
          this.clearPending(configId, requestId);
          return;
        }
        const conn = await s.env.agents.activate(agentServer);
        if (gen !== s.generation || !conn) {
          this.clearPending(configId, requestId);
          return;
        }
        const res = await conn.setSessionConfigOption({
          sessionId,
          configId,
          value,
          type: "boolean",
        });
        if (gen !== s.generation) {
          this.clearPending(configId, requestId);
          return;
        }
        this.applyOptions(
          res?.configOptions ?? updateBooleanConfigOptionValue(s.configOptions, configId, value),
          requestId,
          configId,
        );
      })
      .catch((e: unknown) => {
        const err = normalizeACPError(e);
        this.markSuspendedOnStaleError(err);
        this.failPending(configId, requestId, err);
        throw err;
      });
  }

  /**
   * A "session not found"-shaped rejection means the agent-side session is
   * gone (closed by another surface, or a close that raced a resume). Mark
   * the record suspended so the next interaction reattaches instead of
   * failing the same way again.
   */
  private markSuspendedOnStaleError(e: unknown): void {
    if (isStaleSessionError(normalizeACPError(e))) {
      this.session.suspended = true;
    }
  }

  async togglePlanMode(): Promise<void> {
    const planTarget = this.planModeTarget();
    if (!planTarget) return;

    const nextMode = this.isPlanModeActive ? planTarget.exitModeId : planTarget.planModeId;
    if (!nextMode) return;

    if (planTarget.kind === "config") {
      await this.setOption(planTarget.configId, nextMode);
      return;
    }
    await this.setMode(nextMode);
  }

  get currentModeId(): string | null {
    const modeConfig = findModeConfigOption(this.session.configOptions);
    if (modeConfig) return modeConfig.currentValue;
    return this.session.modes?.currentModeId ?? null;
  }

  /**
   * Plan mode reads from whichever option owns it. Agents that separate the
   * two publish plan on their collaboration option and leave only approval
   * policies on `mode`, so consulting `mode` alone would report "not planning"
   * for every one of them.
   */
  get isPlanModeActive(): boolean {
    const target = this.planModeTarget();
    if (!target) return false;
    if (target.kind === "config") {
      const option = this.session.configOptions.find((o) => o.id === target.configId);
      return option?.type === "select" && option.currentValue === target.planModeId;
    }
    return this.currentModeId === target.planModeId;
  }

  get availableModes(): { id: string; name: string }[] {
    return this.session.modes?.availableModes ?? [];
  }

  get canTogglePlanMode(): boolean {
    return this.planModeTarget() !== null;
  }

  /**
   * True when plan mode is owned by the collaboration option (build/plan).
   * Those agents keep `mode` purely about permissions, so plan state shows in
   * their own collaboration control rather than the full-width plan banner.
   */
  get planModeViaCollaboration(): boolean {
    const target = this.planModeTarget();
    return target?.kind === "config" && target.viaCollaboration;
  }

  get collaborationModeSurface(): ACPCollaborationModeSurface {
    return collaborationModeSurface(this.session.configOptions);
  }

  pendingOption(configId: string): ACPPendingConfigOption | null {
    return this.session.pendingConfigOptions[configId] ?? null;
  }

  setPending(pending: ACPPendingConfigOption): void {
    this.session.pendingConfigOptions = {
      ...this.session.pendingConfigOptions,
      [pending.configId]: pending,
    };
    this.session.env.publishLiveStatuses();
  }

  clearPending(configId: string, requestId?: number): void {
    const current = this.session.pendingConfigOptions[configId];
    if (!current || (requestId !== undefined && current.requestId !== requestId)) return;
    const next = { ...this.session.pendingConfigOptions };
    delete next[configId];
    this.session.pendingConfigOptions = next;
    this.session.env.publishLiveStatuses();
  }

  failPending(configId: string, requestId: number, error: ACPRequestError): void {
    const current = this.session.pendingConfigOptions[configId];
    if (!current || current.requestId !== requestId) return;
    this.session.pendingConfigOptions = {
      ...this.session.pendingConfigOptions,
      [configId]: { ...current, error },
    };
    this.session.env.publishLiveStatuses();
  }

  applyOptions(configOptions: SessionConfigOption[], requestId?: number, requestConfigId?: string) {
    const s = this.session;
    s.configOptions = configOptions;
    s.modes = syncModeFromConfigOptions(s.modes, s.configOptions);
    if (requestConfigId) {
      const current = s.pendingConfigOptions[requestConfigId];
      if (current && (requestId === undefined || current.requestId === requestId)) {
        const next = { ...s.pendingConfigOptions };
        delete next[requestConfigId];
        s.pendingConfigOptions = next;
      }
    } else {
      const next = { ...s.pendingConfigOptions };
      for (const option of configOptions) delete next[option.id];
      s.pendingConfigOptions = next;
    }
    void this.upsertCachedConfig(s.agentServer);
    s.metadataManager.refresh();
    s.env.publishLiveStatuses();
  }

  applyModeUpdate(modeId: string): void {
    const s = this.session;
    const modeConfig = findModeConfigOption(s.configOptions);
    if (modeConfig) {
      s.configOptions = updateConfigOptionValue(s.configOptions, modeConfig.id, modeId);
    }
    s.modes = s.modes
      ? updateSessionModeValue(s.modes, modeId)
      : { currentModeId: modeId, availableModes: [] };
    void this.upsertCachedConfig(s.agentServer);
    s.metadataManager.refresh();
  }

  private planModeTarget():
    | {
        kind: "config";
        configId: string;
        planModeId: string;
        exitModeId: string | null;
        viaCollaboration: boolean;
      }
    | { kind: "mode"; planModeId: string; exitModeId: string | null }
    | null {
    // The collaboration option wins when it offers plan: on agents that have
    // both, that is where plan lives and `mode` is purely about permissions.
    const collaborationConfig = findCollaborationModeConfigOption(this.session.configOptions);
    const collaborationPlanModeId = collaborationConfig
      ? planValueForConfigOption(collaborationConfig)
      : null;
    if (collaborationConfig && collaborationPlanModeId) {
      return {
        kind: "config",
        configId: collaborationConfig.id,
        planModeId: collaborationPlanModeId,
        exitModeId: exitModeForConfigOption(collaborationConfig),
        viaCollaboration: true,
      };
    }
    const modeConfig = findModeConfigOption(this.session.configOptions);
    const modePlanModeId = modeConfig ? planValueForConfigOption(modeConfig) : null;
    if (modeConfig && modePlanModeId) {
      return {
        kind: "config",
        configId: modeConfig.id,
        planModeId: modePlanModeId,
        exitModeId: exitModeForConfigOption(modeConfig),
        viaCollaboration: false,
      };
    }
    const modes = this.session.modes;
    if (modes?.availableModes.some((mode) => mode.id === ACP_PLAN_MODE_ID)) {
      return {
        kind: "mode",
        planModeId: ACP_PLAN_MODE_ID,
        exitModeId: exitModeForModes(modes),
      };
    }
    return null;
  }

  /**
   * Plan mode is a conversation-local switch. The shared config cache still
   * carries its latest value so definitions can be reused, but an untouched
   * draft must start in the corresponding non-plan mode. A plan choice made
   * on this draft is user-selected and remains intact across cache refreshes.
   */
  private resetInheritedPlanMode(): void {
    const s = this.session;
    const target = this.planModeTarget();
    if (!target || !target.exitModeId || !this.isPlanModeActive) return;

    if (target.kind === "config") {
      if (s.userSelectedConfigIds.has(target.configId)) return;
      s.configOptions = updateConfigOptionValue(
        s.configOptions,
        target.configId,
        target.exitModeId,
      );
      s.modes = syncModeFromConfigOptions(s.modes, s.configOptions);
      return;
    }

    if (s.userSelectedMode) return;
    s.modes = updateSessionModeValue(s.modes, target.exitModeId);
  }

  private async upsertCachedConfig(agentServer: string): Promise<void> {
    await this.session.env.agents.upsertCachedConfig(agentServer, {
      configOptions: this.session.configOptions,
      availableCommands: this.session.availableCommands,
      modes: this.session.modes,
    });
  }
}
