import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import type { LocalInferenceModel, LocalInferenceState } from "@camber/helperapi/schemas";
import type { ACPAgentServers } from "@camber/rpc";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACP_AUTH_REQUIRED_ERROR_CODE } from "../authMethods";
import { ACPError } from "../errors";
import { appState, type AppState } from "../hostAdapter";
import { ACPAgentRepository } from "./AgentRepository.svelte";
import { applyDefaultConfigOptions } from "./session/configOptions";

vi.mock("@camber/helperapi", () => ({
  initializeStatefulModule: vi.fn(),
  camberAcpNavGetConfigCache: vi.fn(),
  camberAcpNavListAgentServers: vi.fn(),
  camberAcpNavSetAgentServers: vi.fn(),
  camberAcpNavUpsertConfigCache: vi.fn(async () => ({ entry: null })),
  camberAcpSessionClose: vi.fn(async () => ({})),
}));

describe("ACPAgentRepository", () => {
  let previousAppState: AppState;

  beforeEach(() => {
    previousAppState = get(appState);
    vi.clearAllMocks();
  });

  afterEach(() => {
    appState.set(previousAppState);
  });

  it("configures agents before host settings include an agent-server map", () => {
    appState.update((state) => ({
      ...state,
      userSettings: { ...state.userSettings, acpAgentServers: undefined },
    }));
    const repo = new ACPAgentRepository();
    repo.defaultConfigOptionsByAgentServer = {
      poolside: { approvalMode: "read-only" },
    };

    repo.configureAgentServers(["poolside"], "poolside");

    expect(repo.defaultConfigOptionsFor("poolside")).toEqual({});
  });

  it("mirrors a last-used selection into the defaults before the store write lands, then keeps the saved state", async () => {
    const { camberAcpNavListAgentServers, camberAcpNavSetAgentServers } = await import(
      "@camber/helperapi"
    );
    const initialAgentServers = {
      poolside: { default_config_options: { approvalMode: "agent" } },
    };
    appState.update((state) => ({
      ...state,
      userSettings: { ...state.userSettings, acpAgentServers: initialAgentServers },
    }));
    vi.mocked(camberAcpNavListAgentServers).mockResolvedValue({
      agentServers: initialAgentServers,
    });
    let save: (value: { agentServers: typeof initialAgentServers }) => void = () => {};
    vi.mocked(camberAcpNavSetAgentServers).mockImplementation(
      () =>
        new Promise((resolve) => {
          save = resolve;
        }),
    );
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside"], "poolside");

    repo.recordUserConfigSelection("poolside", "approvalMode", "read-only");

    // The mirror updates ahead of the store write (the set is still blocked
    // here), so the UI reflects the selection without waiting on disk.
    await vi.waitFor(() =>
      expect(repo.defaultConfigOptionsFor("poolside")).toEqual({ approvalMode: "read-only" }),
    );
    await vi.waitFor(() => expect(camberAcpNavSetAgentServers).toHaveBeenCalledOnce());

    const savedAgentServers = {
      poolside: { default_config_options: { approvalMode: "read-only" } },
    };
    save({ agentServers: savedAgentServers });

    await vi.waitFor(() =>
      expect(get(appState).userSettings.acpAgentServers).toEqual(savedAgentServers),
    );
    expect(repo.defaultConfigOptionsFor("poolside")).toEqual({ approvalMode: "read-only" });
  });

  it("restores the previous default when a last-used persist fails", async () => {
    const { camberAcpNavListAgentServers, camberAcpNavSetAgentServers } = await import(
      "@camber/helperapi"
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const initialAgentServers = {
        poolside: { default_config_options: { approvalMode: "agent" } },
      };
      appState.update((state) => ({
        ...state,
        userSettings: { ...state.userSettings, acpAgentServers: initialAgentServers },
      }));
      vi.mocked(camberAcpNavListAgentServers).mockResolvedValue({
        agentServers: initialAgentServers,
      });
      vi.mocked(camberAcpNavSetAgentServers).mockRejectedValue(new Error("save failed"));
      const repo = new ACPAgentRepository();
      repo.configureAgentServers(["poolside"], "poolside");

      repo.recordUserConfigSelection("poolside", "approvalMode", "read-only");

      // The fire-and-forget path logs the failure rather than throwing...
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      // ...and rolls the optimistic mirror back to the stored default.
      expect(repo.defaultConfigOptionsFor("poolside")).toEqual({ approvalMode: "agent" });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("persists explicit selections as the agent's last-used values, serialized in order", async () => {
    const { camberAcpNavListAgentServers, camberAcpNavSetAgentServers } = await import(
      "@camber/helperapi"
    );
    // Stateful store double: each list read reflects the previous write, as
    // the helper's does. The persist queue serializes list-then-set round
    // trips, so no write can read a state missing an earlier write's key.
    let stored: Record<string, { default_config_options?: Record<string, string> }> = {
      poolside: {},
    };
    vi.mocked(camberAcpNavListAgentServers).mockImplementation(async () => ({
      agentServers: stored,
    }));
    vi.mocked(camberAcpNavSetAgentServers).mockImplementation(async (params) => {
      stored = params.agentServers as typeof stored;
      return { agentServers: stored };
    });
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside"], "poolside");

    repo.recordUserConfigSelection("poolside", "model", "opus");
    // Booleans are stored as "true"/"false" strings.
    repo.recordUserConfigSelection("poolside", "fast", true);

    await vi.waitFor(() =>
      expect(repo.defaultConfigOptionsFor("poolside")).toEqual({ model: "opus", fast: "true" }),
    );
    expect(stored.poolside.default_config_options).toEqual({ model: "opus", fast: "true" });
    // The in-memory per-run selection map records alongside.
    expect(repo.userConfigSelectionsFor("poolside").get("model")).toBe("opus");
    expect(repo.userConfigSelectionsFor("poolside").get("fast")).toBe(true);
  });

  // Both writers round-trip list → merge → set over the whole agent-server
  // map. Without a shared queue, a config-option persist and an agent-default
  // persist in flight together would each list a state missing the other's
  // change, and whichever set landed second would drop the first on disk.
  interface InterleaveStore {
    stored: Record<string, { default_config_options?: Record<string, string> }>;
    storedDefault: string | undefined;
    releases: (() => void)[];
  }

  async function mockInterleavedStore(): Promise<InterleaveStore> {
    const { camberAcpNavListAgentServers, camberAcpNavSetAgentServers } = await import(
      "@camber/helperapi"
    );
    const store: InterleaveStore = {
      stored: { poolside: {}, "claude-acp": {} },
      storedDefault: undefined,
      releases: [],
    };
    vi.mocked(camberAcpNavListAgentServers).mockImplementation(async () => ({
      agentServers: store.stored,
      defaultAgentServer: store.storedDefault,
    }));
    // Each set blocks until the test releases it, committing to the store
    // only then — so the test controls exactly when each write lands.
    vi.mocked(camberAcpNavSetAgentServers).mockImplementation(
      (params) =>
        new Promise((resolve) => {
          store.releases.push(() => {
            store.stored = params.agentServers as InterleaveStore["stored"];
            if (params.defaultAgentServer !== undefined) {
              store.storedDefault = params.defaultAgentServer;
            }
            resolve({ agentServers: store.stored, defaultAgentServer: store.storedDefault });
          });
        }),
    );
    return store;
  }

  it("serializes an agent-default persist with a last-used selection persist (agent first)", async () => {
    // The config-first order lives in "serializes a last-used selection
    // persist with an agent-default persist" below; this covers the agent
    // write committing first with the selection queued behind it.
    const store = await mockInterleavedStore();
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside", "claude-acp"], "poolside");

    const agentPersist = repo.setDefaultAgentServer("claude-acp");
    repo.recordUserConfigSelection("poolside", "model", "opus");
    // The agent-default optimistic update lands immediately, outside the
    // queue.
    expect(repo.defaultAgentServer).toBe("claude-acp");

    // Only the agent write is in flight; the selection write queues behind
    // it and lists only after the first set has committed.
    await vi.waitFor(() => expect(store.releases).toHaveLength(1));
    store.releases[0]();
    await vi.waitFor(() => expect(store.releases).toHaveLength(2));
    store.releases[1]();
    await agentPersist;

    await vi.waitFor(() =>
      expect(store.stored.poolside.default_config_options).toEqual({ model: "opus" }),
    );
    expect(store.storedDefault).toBe("claude-acp");
    expect(repo.defaultAgentServer).toBe("claude-acp");
  });

  it("serializes a last-used selection persist with an agent-default persist", async () => {
    const store = await mockInterleavedStore();
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside", "claude-acp"], "poolside");

    // The fire-and-forget last-used path shares the same queue.
    repo.recordUserConfigSelection("poolside", "model", "opus");
    const agentPersist = repo.setDefaultAgentServer("claude-acp");

    await vi.waitFor(() => expect(store.releases).toHaveLength(1));
    store.releases[0]();
    await vi.waitFor(() => expect(store.releases).toHaveLength(2));
    store.releases[1]();
    await agentPersist;

    expect(store.stored.poolside.default_config_options).toEqual({ model: "opus" });
    expect(store.storedDefault).toBe("claude-acp");
  });

  it("preserves a just-persisted default when a settings save queues behind it", async () => {
    const store = await mockInterleavedStore();
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside", "claude-acp"], "poolside");

    // A picker selection is persisting model: opus through the
    // fire-and-forget last-used path...
    repo.recordUserConfigSelection("poolside", "model", "opus");
    // ...while the settings panel saves from a snapshot taken before that
    // landed: it removes claude-acp, adds codex-acp, and its stale copy of
    // camber still carries the old defaults.
    const hostSet = vi.fn(async (agentServers: ACPAgentServers) => {
      store.stored = agentServers as InterleaveStore["stored"];
    });
    const panelSave = repo.saveAgentServers(
      {
        poolside: { default_config_options: { model: "sonnet" } },
        "codex-acp": { command: "codex" },
      },
      hostSet,
    );

    // The panel save waits in the queue: nothing reaches the host RPC until
    // the default-persist's set has committed.
    await vi.waitFor(() => expect(store.releases).toHaveLength(1));
    expect(hostSet).not.toHaveBeenCalled();
    store.releases[0]();
    const saved = await panelSave;

    // The panel's edits landed (claude-acp removed, codex-acp kept as
    // given), and the freshly persisted default replaced the panel's stale
    // copy instead of being dropped from disk.
    const expected = {
      poolside: { default_config_options: { model: "opus" } },
      "codex-acp": { command: "codex" },
    };
    expect(hostSet).toHaveBeenCalledTimes(1);
    expect(hostSet).toHaveBeenCalledWith(expected);
    expect(saved).toEqual(expected);
    expect(store.stored).toEqual(expected);
    expect(repo.defaultConfigOptionsFor("poolside")).toEqual({ model: "opus" });
  });

  it("skips the last-used persist when the stored value already matches", async () => {
    const { camberAcpNavSetAgentServers } = await import("@camber/helperapi");
    const repo = new ACPAgentRepository();
    repo.defaultConfigOptionsByAgentServer = { poolside: { model: "opus" } };

    repo.recordUserConfigSelection("poolside", "model", "opus");

    // Let the persist queue drain before asserting nothing was written.
    await flushMicrotasks();
    expect(camberAcpNavSetAgentServers).not.toHaveBeenCalled();
    expect(repo.userConfigSelectionsFor("poolside").get("model")).toBe("opus");
  });

  it("records but never persists selections flagged persist: false", async () => {
    const { camberAcpNavListAgentServers, camberAcpNavSetAgentServers } = await import(
      "@camber/helperapi"
    );
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside"], "poolside");

    // Mode-shaped selections are session state: recorded in memory (probe
    // preservation reads this) but excluded from the last-used store.
    repo.recordUserConfigSelection("poolside", "permission_mode", "yolo", { persist: false });

    await flushMicrotasks();
    expect(camberAcpNavListAgentServers).not.toHaveBeenCalled();
    expect(camberAcpNavSetAgentServers).not.toHaveBeenCalled();
    expect(repo.userConfigSelectionsFor("poolside").get("permission_mode")).toBe("yolo");
  });

  it("logs and keeps going when a last-used persist fails", async () => {
    const { camberAcpNavListAgentServers, camberAcpNavSetAgentServers } = await import(
      "@camber/helperapi"
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(camberAcpNavListAgentServers).mockResolvedValue({
        agentServers: { poolside: {} },
      });
      vi.mocked(camberAcpNavSetAgentServers)
        .mockRejectedValueOnce(new Error("save failed"))
        .mockImplementation(async (params) => ({ agentServers: params.agentServers }));
      const repo = new ACPAgentRepository();
      repo.configureAgentServers(["poolside"], "poolside");

      repo.recordUserConfigSelection("poolside", "model", "opus");
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      // The selection itself survives the failed persist.
      expect(repo.userConfigSelectionsFor("poolside").get("model")).toBe("opus");

      // The queue is not wedged: the next selection persists normally.
      repo.recordUserConfigSelection("poolside", "effort", "high");
      await vi.waitFor(() =>
        expect(repo.defaultConfigOptionsFor("poolside")).toEqual(
          expect.objectContaining({ effort: "high" }),
        ),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  // ---- pinned defaults -----------------------------------------------------

  interface PinnedStore {
    stored: Record<
      string,
      { default_config_options?: Record<string, string>; pinned_config_options?: string[] }
    >;
    storedDefault: string | undefined;
    storedPinned: boolean;
  }

  // Stateful store double with pin support: each list read reflects the
  // previous write, and the pin flag serializes Go-style (omitted when false).
  async function mockPinnedStore(initial: PinnedStore["stored"]): Promise<PinnedStore> {
    const { camberAcpNavListAgentServers, camberAcpNavSetAgentServers } = await import(
      "@camber/helperapi"
    );
    const store: PinnedStore = { stored: initial, storedDefault: undefined, storedPinned: false };
    const state = () => ({
      agentServers: store.stored,
      defaultAgentServer: store.storedDefault,
      default_agent_server_pinned: store.storedPinned ? true : undefined,
    });
    vi.mocked(camberAcpNavListAgentServers).mockImplementation(async () => state());
    vi.mocked(camberAcpNavSetAgentServers).mockImplementation(async (params) => {
      store.stored = params.agentServers as PinnedStore["stored"];
      if (params.defaultAgentServer !== undefined) {
        store.storedDefault = params.defaultAgentServer;
      }
      if (params.default_agent_server_pinned !== undefined) {
        store.storedPinned = params.default_agent_server_pinned;
      }
      return state();
    });
    return store;
  }

  it("pins a config option: one queued write carries the default value and the pin", async () => {
    const { camberAcpNavSetAgentServers } = await import("@camber/helperapi");
    const store = await mockPinnedStore({
      poolside: { default_config_options: { model: "haiku" } },
    });
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside"], "poolside");

    const pending = repo.setPinnedDefaultConfigOption("poolside", "model", "opus");

    // Optimistic and immediate, outside the queue.
    expect(repo.isPinnedConfigOption("poolside", "model")).toBe(true);
    expect(repo.defaultConfigOptionsFor("poolside")).toEqual({ model: "opus" });

    await pending;
    expect(store.stored.poolside.default_config_options).toEqual({ model: "opus" });
    expect(store.stored.poolside.pinned_config_options).toEqual(["model"]);
    // The value and the membership landed in ONE set, not two round trips.
    expect(camberAcpNavSetAgentServers).toHaveBeenCalledTimes(1);
    expect(repo.isPinnedConfigOption("poolside", "model")).toBe(true);
  });

  it("unpins a config option: membership goes, the default value stays", async () => {
    const store = await mockPinnedStore({
      poolside: {
        default_config_options: { model: "opus", effort: "high" },
        pinned_config_options: ["model", "effort"],
      },
    });
    appState.update((state) => ({
      ...state,
      userSettings: { ...state.userSettings, acpAgentServers: store.stored },
    }));
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside"], "poolside");

    const pending = repo.unpinDefaultConfigOption("poolside", "model");
    // Optimistic and immediate.
    expect(repo.isPinnedConfigOption("poolside", "model")).toBe(false);
    expect(repo.isPinnedConfigOption("poolside", "effort")).toBe(true);

    await pending;
    expect(store.stored.poolside.default_config_options).toEqual({
      model: "opus",
      effort: "high",
    });
    expect(store.stored.poolside.pinned_config_options).toEqual(["effort"]);

    // Emptying the pin list drops the field entirely instead of writing [].
    await repo.unpinDefaultConfigOption("poolside", "effort");
    expect(store.stored.poolside.default_config_options).toEqual({
      model: "opus",
      effort: "high",
    });
    expect(store.stored.poolside.pinned_config_options).toBeUndefined();
  });

  it("unpins with clearValue: the queued write drops the pin AND the stored value", async () => {
    // The last-used auto-follow never writes behavioral-mode or
    // uncategorized options, but applyDefaultConfigOptions applies EVERY
    // stored default to new sessions. A keep-value unpin of such a key would
    // leave e.g. "Bypass permissions" as every future conversation's
    // invisible default with no UI to clear it, so the star unpin passes
    // clearValue for options the follow won't manage.
    const store = await mockPinnedStore({
      poolside: {
        default_config_options: { permission_mode: "bypass", model: "opus" },
        pinned_config_options: ["permission_mode"],
      },
    });
    appState.update((state) => ({
      ...state,
      userSettings: { ...state.userSettings, acpAgentServers: store.stored },
    }));
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside"], "poolside");

    const pending = repo.unpinDefaultConfigOption("poolside", "permission_mode", {
      clearValue: true,
    });
    // Optimistic and immediate: the mirror drops the key too, so this
    // window's applyDefaultConfigOptions stops seeing it right away.
    expect(repo.isPinnedConfigOption("poolside", "permission_mode")).toBe(false);
    expect(repo.defaultConfigOptionsFor("poolside")).toEqual({ model: "opus" });

    await pending;
    expect(store.stored.poolside.default_config_options).toEqual({ model: "opus" });
    expect(store.stored.poolside.pinned_config_options).toBeUndefined();

    // What a new session starts from — the store shape that feeds
    // applyDefaultConfigOptions — no longer carries the mode.
    const modeOption: SessionConfigOption = {
      id: "permission_mode",
      name: "Permission Mode",
      type: "select",
      category: "mode",
      currentValue: "default",
      options: [
        { name: "Always Ask", value: "default" },
        { name: "Bypass Permissions", value: "bypass" },
      ],
    };
    expect(
      applyDefaultConfigOptions([modeOption], store.stored.poolside.default_config_options ?? {}),
    ).toEqual([expect.objectContaining({ currentValue: "default" })]);
  });

  it("drops an emptied defaults map when clearValue removes the last stored value", async () => {
    const store = await mockPinnedStore({
      poolside: {
        default_config_options: { permission_mode: "bypass" },
        pinned_config_options: ["permission_mode"],
      },
    });
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside"], "poolside");

    await repo.unpinDefaultConfigOption("poolside", "permission_mode", { clearValue: true });

    // Both maps emptied out: dropped entirely rather than persisted as {}/[].
    expect(store.stored.poolside.default_config_options).toBeUndefined();
    expect(store.stored.poolside.pinned_config_options).toBeUndefined();
  });

  it("restores the optimistic pin mirrors when the persist fails", async () => {
    const { camberAcpNavListAgentServers, camberAcpNavSetAgentServers } = await import(
      "@camber/helperapi"
    );
    vi.mocked(camberAcpNavListAgentServers).mockResolvedValue({
      agentServers: { poolside: {} },
    });
    vi.mocked(camberAcpNavSetAgentServers).mockRejectedValue(new Error("save failed"));
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside"], "poolside");

    const pending = repo.setPinnedDefaultConfigOption("poolside", "model", "opus");
    expect(repo.isPinnedConfigOption("poolside", "model")).toBe(true);

    await expect(pending).rejects.toThrow("save failed");
    expect(repo.isPinnedConfigOption("poolside", "model")).toBe(false);
    expect(repo.defaultConfigOptionsFor("poolside")).toEqual({});
  });

  it("skips the last-used follow for a pinned key, read fresh from the store at dequeue", async () => {
    const { camberAcpNavSetAgentServers } = await import("@camber/helperapi");
    const store = await mockPinnedStore({
      poolside: { default_config_options: { model: "opus" }, pinned_config_options: ["model"] },
    });
    // The in-memory mirror is seeded from a STALE snapshot that predates the
    // pin: only the fresh list read inside the queued job can see it, which
    // is exactly what makes a pin that lands while a write sits queued win.
    appState.update((state) => ({
      ...state,
      userSettings: {
        ...state.userSettings,
        acpAgentServers: { poolside: { default_config_options: { model: "opus" } } },
      },
    }));
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside"], "poolside");

    repo.recordUserConfigSelection("poolside", "model", "sonnet");
    await flushMicrotasks();

    // Nothing was written: the pinned key keeps its value on disk...
    expect(camberAcpNavSetAgentServers).not.toHaveBeenCalled();
    expect(store.stored.poolside.default_config_options).toEqual({ model: "opus" });
    // ...while the in-memory per-run selection still recorded.
    expect(repo.userConfigSelectionsFor("poolside").get("model")).toBe("sonnet");

    // The queue is not wedged, and unpinned keys still follow last use.
    repo.recordUserConfigSelection("poolside", "effort", "high");
    await vi.waitFor(() =>
      expect(store.stored.poolside.default_config_options).toEqual({
        model: "opus",
        effort: "high",
      }),
    );
    expect(store.stored.poolside.pinned_config_options).toEqual(["model"]);
  });

  it("preserves the pinned list from the fresh store when a settings save lands", async () => {
    const store = await mockPinnedStore({
      poolside: { default_config_options: { model: "opus" }, pinned_config_options: ["model"] },
    });
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside"], "poolside");
    // The panel's snapshot is stale: no defaults, no pins.
    const hostSet = vi.fn(async (agentServers: ACPAgentServers) => {
      store.stored = agentServers as PinnedStore["stored"];
    });

    const saved = await repo.saveAgentServers({ poolside: { command: "custom" } }, hostSet);

    const expected = {
      poolside: {
        command: "custom",
        default_config_options: { model: "opus" },
        pinned_config_options: ["model"],
      },
    };
    expect(saved).toEqual(expected);
    expect(store.stored).toEqual(expected);
    expect(repo.isPinnedConfigOption("poolside", "model")).toBe(true);
  });

  it("pins and unpins the default agent through the queue with the store's pin param", async () => {
    const store = await mockPinnedStore({ poolside: {}, "claude-acp": {} });
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside", "claude-acp"], "poolside");

    const pending = repo.setPinnedDefaultAgentServer("claude-acp");
    // Optimistic and immediate.
    expect(repo.defaultAgentServer).toBe("claude-acp");
    expect(repo.defaultAgentServerPinned).toBe(true);
    await pending;
    expect(store.storedDefault).toBe("claude-acp");
    expect(store.storedPinned).toBe(true);

    // A plain last-used write while the pin holds is skipped at dequeue
    // against the store's fresh flag: the pinned default stays put, and the
    // mirrors settle back on it.
    await repo.setDefaultAgentServer("poolside");
    expect(store.storedDefault).toBe("claude-acp");
    expect(store.storedPinned).toBe(true);
    expect(repo.defaultAgentServer).toBe("claude-acp");
    expect(repo.defaultAgentServerPinned).toBe(true);

    // Unpinning clears only the flag; the default agent itself is unchanged.
    const unpin = repo.unpinDefaultAgentServer();
    expect(repo.defaultAgentServerPinned).toBe(false);
    await unpin;
    expect(store.storedPinned).toBe(false);
    expect(store.storedDefault).toBe("claude-acp");
    expect(repo.defaultAgentServer).toBe("claude-acp");

    // With the pin released, the last-used follow lands again — omitting the
    // pin param, which the store preserves (still unpinned).
    await repo.setDefaultAgentServer("poolside");
    expect(store.storedDefault).toBe("poolside");
    expect(store.storedPinned).toBe(false);
    expect(repo.defaultAgentServer).toBe("poolside");
  });

  it("skips a queued last-used agent write when the store's pin was set behind the mirror's back", async () => {
    const { camberAcpNavSetAgentServers } = await import("@camber/helperapi");
    const store = await mockPinnedStore({ poolside: {}, "claude-acp": {} });
    // Another window pinned claude-acp; this repository's mirror never saw
    // it, so the caller-side gate (rememberLastUsedAgent) cannot help.
    store.storedDefault = "claude-acp";
    store.storedPinned = true;
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside", "claude-acp"], "claude-acp");
    expect(repo.defaultAgentServerPinned).toBe(false);

    const res = await repo.setDefaultAgentServer("poolside");

    // Nothing was written: the pinned default stays put on disk...
    expect(camberAcpNavSetAgentServers).not.toHaveBeenCalled();
    expect(store.storedDefault).toBe("claude-acp");
    // ...and the stale mirrors heal to the store's fresh state.
    expect(repo.defaultAgentServer).toBe("claude-acp");
    expect(repo.defaultAgentServerPinned).toBe(true);
    expect(res).toEqual({ agentServers: store.stored, defaultAgentServer: "claude-acp" });

    // Explicit pin and unpin writes proceed regardless of the stored flag —
    // they are the deliberate acts the pin protects.
    await repo.setPinnedDefaultAgentServer("poolside");
    expect(store.storedDefault).toBe("poolside");
    expect(store.storedPinned).toBe(true);
    await repo.unpinDefaultAgentServer();
    expect(store.storedPinned).toBe(false);
    expect(store.storedDefault).toBe("poolside");
  });

  it("restores the default-agent mirrors when the pin persist fails", async () => {
    const { camberAcpNavListAgentServers, camberAcpNavSetAgentServers } = await import(
      "@camber/helperapi"
    );
    vi.mocked(camberAcpNavListAgentServers).mockResolvedValue({
      agentServers: { poolside: {}, "claude-acp": {} },
    });
    vi.mocked(camberAcpNavSetAgentServers).mockRejectedValue(new Error("save failed"));
    const repo = new ACPAgentRepository();
    repo.configureAgentServers(["poolside", "claude-acp"], "poolside");

    const pending = repo.setPinnedDefaultAgentServer("claude-acp");
    // Optimistic and immediate...
    expect(repo.defaultAgentServer).toBe("claude-acp");
    expect(repo.defaultAgentServerPinned).toBe(true);

    // ...rolled back together when the store refuses the write.
    await expect(pending).rejects.toThrow("save failed");
    expect(repo.defaultAgentServer).toBe("poolside");
    expect(repo.defaultAgentServerPinned).toBe(false);

    // The unpin direction rolls back the same way.
    repo.defaultAgentServerPinned = true;
    const unpin = repo.unpinDefaultAgentServer();
    expect(repo.defaultAgentServerPinned).toBe(false);
    await expect(unpin).rejects.toThrow("save failed");
    expect(repo.defaultAgentServerPinned).toBe(true);
    expect(repo.defaultAgentServer).toBe("poolside");
  });

  it("mirrors the pin flag through configureAgentServers only when given explicitly", () => {
    const repo = new ACPAgentRepository();

    repo.configureAgentServers(["poolside"], "poolside", true);
    expect(repo.defaultAgentServerPinned).toBe(true);

    // Callers that don't know the pin state must not clear it.
    repo.configureAgentServers(["poolside", "claude-acp"], "poolside");
    expect(repo.defaultAgentServerPinned).toBe(true);

    repo.configureAgentServers(["poolside", "claude-acp"], "poolside", false);
    expect(repo.defaultAgentServerPinned).toBe(false);
  });

  it("logs out only when the agent advertises logout support", async () => {
    const logout = vi.fn().mockResolvedValue({});
    const repo = new ACPAgentRepository();
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: { logout },
        initializeResponse: {
          protocolVersion: 1,
          agentCapabilities: { auth: { logout: {} } },
          authMethods: [{ id: "login", name: "Login" }],
        },
      }),
    });
    repo.handleAuthenticateUpdate({ authUri: "https://example.com/device" }, "codex-acp");

    await repo.logout("codex-acp");

    expect(logout).toHaveBeenCalledWith({});
    expect(repo.supportsLogout("codex-acp")).toBe(true);
    expect(repo.authRequiredForAgent("codex-acp")).toBe(true);
    expect(repo.authUriForAgent("codex-acp")).toBeNull();
  });

  it("does not call logout when the capability is omitted", async () => {
    const logout = vi.fn().mockResolvedValue({});
    const repo = new ACPAgentRepository();
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: { logout },
        initializeResponse: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [{ id: "login", name: "Login" }],
        },
      }),
    });

    await repo.logout("codex-acp");

    expect(logout).not.toHaveBeenCalled();
    expect(repo.supportsLogout("codex-acp")).toBe(false);
    expect(repo.authRequiredForAgent("codex-acp")).toBe(false);
  });

  it("recognizes native Claude and Codex steering but not Pool", () => {
    const repo = new ACPAgentRepository();
    repo.initializeResponses = {
      "codex-acp": {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
        _meta: { steering: { supported: true } },
      },
      "claude-acp": {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
        _meta: { steering: { supported: true } },
      },
      poolside: {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      },
      other: {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      },
    };

    expect(repo.supportsSteering("codex-acp")).toBe(true);
    expect(repo.steeringTransport("codex-acp")).toEqual({ kind: "extension" });
    expect(repo.supportsSteering("claude-acp")).toBe(true);
    expect(repo.steeringTransport("poolside")).toBeNull();
    expect(repo.supportsSteering("poolside")).toBe(false);
    expect(repo.supportsSteering("other")).toBe(false);
  });

  it("clears auth-required state using normalized agent names", () => {
    const repo = new ACPAgentRepository();

    repo.markAuthRequired("default");
    repo.handleAuthenticateUpdate({ authUri: "https://example.com/device" }, "default");
    repo.clearAuthRequired("default");

    expect(repo.authRequiredForAgent("poolside")).toBe(false);
    expect(repo.authUriForAgent("poolside")).toBeNull();
  });

  it("quietly keeps polling when an auth probe still requires authentication", async () => {
    const authenticate = vi.fn().mockRejectedValue(
      new ACPError({
        code: ACP_AUTH_REQUIRED_ERROR_CODE,
        message: "Authentication required",
      }),
    );
    const repo = new ACPAgentRepository();
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: { authenticate },
        initializeResponse: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [{ id: "login", name: "Login" }],
        },
      }),
    });
    repo.markAuthRequired("poolside");

    await expect(repo.probeAuthentication("login", "poolside")).resolves.toBe("pending");

    expect(authenticate).toHaveBeenCalledWith({ methodId: "login" });
    expect(repo.authRequiredForAgent("poolside")).toBe(true);
    expect(repo.nonSessionErrorFor("poolside")).toBeNull();
  });

  it("clears auth-required state when an auth probe succeeds", async () => {
    const authenticate = vi.fn().mockResolvedValue({});
    const repo = new ACPAgentRepository();
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: { authenticate },
        initializeResponse: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [{ id: "login", name: "Login" }],
        },
      }),
    });
    repo.markAuthRequired("poolside");

    await expect(repo.probeAuthentication("login", "poolside")).resolves.toBe("authenticated");

    expect(repo.authRequiredForAgent("poolside")).toBe(false);
    expect(repo.nonSessionErrorFor("poolside")).toBeNull();
  });

  it("prefers the live agentInfo version over the cached one", async () => {
    const repo = new ACPAgentRepository();
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: {},
        initializeResponse: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
          agentInfo: { name: "pool", title: "Camber", version: "0.3.20" },
        },
      }),
    });
    repo.configCacheByAgentServer = {
      poolside: {
        agentServer: "poolside",
        configOptions: [],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: { name: "pool", version: "0.3.19" },
        cachedAt: "2026-06-22T00:00:00.000Z",
      },
    };

    expect(repo.installedVersionFor("default")).toBe("0.3.19");
    await repo.connectServer("poolside");
    expect(repo.installedVersionFor("default")).toBe("0.3.20");
  });

  it("returns null when no agentInfo version is known", () => {
    const repo = new ACPAgentRepository();
    expect(repo.installedVersionFor("poolside")).toBeNull();
  });

  it("persists agentInfo on refresh and serves it from the store in a fresh repository", async () => {
    const { camberAcpNavGetConfigCache, camberAcpNavUpsertConfigCache } = await import(
      "@camber/helperapi"
    );
    const repo = new ACPAgentRepository();
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: {
          newSession: vi.fn().mockResolvedValue({ sessionId: "probe-session", configOptions: [] }),
        },
        initializeResponse: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
          agentInfo: { name: "pool", title: "Camber", version: "0.3.20" },
        },
      }),
    });
    vi.mocked(camberAcpNavUpsertConfigCache).mockImplementationOnce(async (params) => ({
      entry: { ...params, cachedAt: "2026-07-10T00:00:00.000Z" },
    }));

    await repo.refreshCachedConfig("poolside", "/");

    expect(camberAcpNavUpsertConfigCache).toHaveBeenCalledWith(
      expect.objectContaining({
        agentServer: "poolside",
        agentInfo: { name: "pool", title: "Camber", version: "0.3.20" },
      }),
    );

    const persisted = vi.mocked(camberAcpNavUpsertConfigCache).mock.calls[0][0];
    vi.mocked(camberAcpNavGetConfigCache).mockResolvedValueOnce({
      entry: { ...persisted, cachedAt: "2026-07-10T00:00:00.000Z" },
    });

    const fresh = new ACPAgentRepository();
    await fresh.loadCachedConfigFromStore("poolside");
    expect(fresh.installedVersionFor("poolside")).toBe("0.3.20");
  });

  it("re-probes a stale config probe and closes the superseded probe session after a drain delay", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const { camberAcpSessionClose } = await import("@camber/helperapi");
      const newSession = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "probe-1", configOptions: [] })
        .mockResolvedValueOnce({ sessionId: "probe-2", configOptions: [] });
      const repo = new ACPAgentRepository();
      repo.setConnectionPool({
        connect: vi.fn().mockResolvedValue({
          conn: { newSession },
          initializeResponse: {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: { close: {}, resume: {} } },
            authMethods: [],
          },
        }),
      });

      await repo.ensureConfigProbe("poolside", "/");
      await repo.ensureConfigProbe("poolside", "/");
      expect(newSession).toHaveBeenCalledTimes(1);
      expect(camberAcpSessionClose).not.toHaveBeenCalled();

      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      await repo.ensureConfigProbe("poolside", "/");
      expect(newSession).toHaveBeenCalledTimes(2);
      expect(repo.configProbeSessionIdsByAgentServer.poolside).toBe("probe-2");
      // The close waits out the drain window for in-flight probe-bound RPCs.
      expect(camberAcpSessionClose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60 * 1000);
      expect(camberAcpSessionClose).toHaveBeenCalledWith({
        agentServer: "poolside",
        sessionId: "probe-1",
      });

      await repo.ensureConfigProbe("poolside", "/");
      expect(newSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the first probe for agents that cannot close-and-reopen sessions", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const newSession = vi.fn().mockResolvedValue({ sessionId: "probe-1", configOptions: [] });
      const repo = new ACPAgentRepository();
      repo.setConnectionPool({
        connect: vi.fn().mockResolvedValue({
          conn: { newSession },
          initializeResponse: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
        }),
      });

      await repo.ensureConfigProbe("poolside", "/");
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      // Rotation would strand probe-1 agent-side (helper close no-ops
      // without close+reopen), so staleness must not trigger a re-probe.
      await repo.ensureConfigProbe("poolside", "/");
      expect(newSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("markAgentConfigFresh defers the next TTL re-probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const newSession = vi.fn().mockResolvedValue({ sessionId: "probe-1", configOptions: [] });
      const repo = new ACPAgentRepository();
      repo.setConnectionPool({
        connect: vi.fn().mockResolvedValue({
          conn: { newSession },
          initializeResponse: {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: { close: {}, resume: {} } },
            authMethods: [],
          },
        }),
      });

      await repo.ensureConfigProbe("poolside", "/");
      expect(newSession).toHaveBeenCalledTimes(1);

      // A real session/new reports the same config a probe would; recording
      // it (SessionPrompting does this) must reset the staleness clock.
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      repo.markAgentConfigFresh("poolside");
      await repo.ensureConfigProbe("poolside", "/");
      expect(newSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-probes a restarted agent even while its last report is fresh", async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: "probe-1", configOptions: [] });
    const repo = new ACPAgentRepository();
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: { newSession },
        initializeResponse: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
      }),
    });

    await repo.ensureConfigProbe("poolside", "/");
    expect(newSession).toHaveBeenCalledTimes(1);
    expect(repo.isAgentConfigFresh("poolside")).toBe(true);

    // Restarting the agent drops the probe and its freshness together, so the
    // next ensure re-probes: auth-required state is runtime-only and must be
    // rediscovered even though the config report is minutes old.
    repo.clearRuntimeFor("poolside");
    expect(repo.isAgentConfigFresh("poolside")).toBe(false);
    await repo.ensureConfigProbe("poolside", "/");
    expect(newSession).toHaveBeenCalledTimes(2);
  });

  it("closes a forgotten probe session so a raced recovery cannot leak it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const { camberAcpSessionClose } = await import("@camber/helperapi");
      const newSession = vi.fn().mockResolvedValue({ sessionId: "probe-1", configOptions: [] });
      const repo = new ACPAgentRepository();
      repo.setConnectionPool({
        connect: vi.fn().mockResolvedValue({
          conn: { newSession },
          initializeResponse: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
        }),
      });

      await repo.ensureConfigProbe("poolside", "/");
      repo.forgetConfigProbe("poolside");
      expect(repo.configProbeSessionIdsByAgentServer.poolside).toBeUndefined();

      // Drained first: another surface may still be mid-RPC on this id.
      expect(camberAcpSessionClose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60 * 1000);
      expect(camberAcpSessionClose).toHaveBeenCalledWith({
        agentServer: "poolside",
        sessionId: "probe-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses non-auth probe errors for quiet background refreshes", async () => {
    const repo = new ACPAgentRepository();
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: { newSession: vi.fn().mockRejectedValue(new Error("agent exploded")) },
        initializeResponse: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
      }),
    });

    await repo.ensureConfigProbe("poolside", "/", { quiet: true });
    expect(repo.nonSessionErrorFor("poolside")).toBeNull();

    await repo.refreshCachedConfig("poolside", "/", { fresh: true });
    expect(repo.nonSessionErrorFor("poolside")).not.toBeNull();
  });

  it("keeps a concurrent cache write instead of clobbering it with a stale upsert echo", async () => {
    const { camberAcpNavUpsertConfigCache } = await import("@camber/helperapi");
    let releaseEcho = () => {};
    vi.mocked(camberAcpNavUpsertConfigCache).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseEcho = () => resolve({});
        }),
    );
    const repo = new ACPAgentRepository();

    const pending = repo.upsertCachedConfig("poolside", {
      configOptions: [],
      availableCommands: [],
      modes: null,
    });
    const concurrent = {
      agentServer: "poolside",
      configOptions: [],
      availableCommands: [{ name: "newer", description: "Newer write" }],
      modes: null,
      promptCapabilities: null,
      agentInfo: null,
      cachedAt: "2026-08-04T12:00:00.000Z",
    };
    repo.configCacheByAgentServer = { poolside: concurrent };
    releaseEcho();
    await pending;

    expect(repo.configCacheByAgentServer.poolside).toBe(concurrent);
  });

  it("keeps freshly probed definitions when a picker write lands mid-persist", async () => {
    const { camberAcpNavUpsertConfigCache } = await import("@camber/helperapi");
    const modelOption = (currentValue: string, values: string[]) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: values.map((value) => ({ name: value, value })),
      currentValue,
    });
    let releaseEcho = () => {};
    vi.mocked(camberAcpNavUpsertConfigCache).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseEcho = () => resolve({});
        }),
    );
    const repo = new ACPAgentRepository();

    // The probe read a newly released model off the wire.
    const pending = repo.upsertCachedConfig("poolside", {
      configOptions: [modelOption("sonnet", ["sonnet", "new-model"])],
      availableCommands: [],
      modes: null,
      authoritativeDefinitions: true,
    });
    // Mid-persist the user picks in a draft, republishing that draft's older
    // definitions (no new-model) along with the selection.
    repo.configCacheByAgentServer = {
      poolside: {
        agentServer: "poolside",
        configOptions: [modelOption("opus", ["sonnet", "opus"])],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-08-04T12:00:00.000Z",
      },
    };
    releaseEcho();
    await pending;

    // The agent's definitions survive; the user's selection is dropped only
    // because the fresh definitions no longer offer it.
    const entry = repo.configCacheByAgentServer.poolside;
    expect(entry.configOptions).toEqual([
      expect.objectContaining({
        id: "model",
        options: [
          { name: "sonnet", value: "sonnet" },
          { name: "new-model", value: "new-model" },
        ],
      }),
    ]);
  });

  it("keeps a concurrent picker selection when reasserting probed definitions", async () => {
    const { camberAcpNavUpsertConfigCache } = await import("@camber/helperapi");
    const modelOption = (currentValue: string, values: string[]) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: values.map((value) => ({ name: value, value })),
      currentValue,
    });
    let releaseEcho = () => {};
    vi.mocked(camberAcpNavUpsertConfigCache).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseEcho = () => resolve({});
        }),
    );
    const repo = new ACPAgentRepository();

    const pending = repo.upsertCachedConfig("poolside", {
      configOptions: [modelOption("sonnet", ["sonnet", "opus", "new-model"])],
      availableCommands: [],
      modes: null,
      authoritativeDefinitions: true,
    });
    repo.configCacheByAgentServer = {
      poolside: {
        agentServer: "poolside",
        configOptions: [modelOption("opus", ["sonnet", "opus"])],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-08-04T12:00:00.000Z",
      },
    };
    releaseEcho();
    await pending;

    const entry = repo.configCacheByAgentServer.poolside;
    expect(entry.configOptions).toEqual([
      expect.objectContaining({
        id: "model",
        currentValue: "opus",
        options: [
          { name: "sonnet", value: "sonnet" },
          { name: "opus", value: "opus" },
          { name: "new-model", value: "new-model" },
        ],
      }),
    ]);
  });

  it("preserves the user's explicit selections and mode across a re-probe", async () => {
    const repo = new ACPAgentRepository();
    // The user picked opus and plan; reasoning was never touched.
    repo.recordUserConfigSelection("poolside", "model", "opus");
    repo.recordUserConfigSelection("poolside", "reasoning", "ultra");
    repo.recordUserModeSelection("poolside", "plan");
    repo.configCacheByAgentServer = {
      poolside: {
        agentServer: "poolside",
        configOptions: [
          {
            id: "model",
            type: "select",
            name: "Model",
            category: "model",
            options: [
              { name: "Sonnet", value: "sonnet" },
              { name: "Opus", value: "opus" },
            ],
            currentValue: "opus",
          },
          {
            id: "reasoning",
            type: "select",
            name: "Reasoning",
            options: [{ name: "Ultra", value: "ultra" }],
            currentValue: "ultra",
          },
        ],
        availableCommands: [],
        modes: {
          currentModeId: "plan",
          availableModes: [
            { id: "build", name: "Build" },
            { id: "plan", name: "Plan" },
          ],
        },
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-08-04T00:00:00.000Z",
      },
    };
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: {
          newSession: vi.fn().mockResolvedValue({
            sessionId: "probe-2",
            configOptions: [
              {
                id: "model",
                type: "select",
                name: "Model",
                category: "model",
                options: [
                  { name: "Sonnet", value: "sonnet" },
                  { name: "Opus", value: "opus" },
                  { name: "New Model", value: "new-model" },
                ],
                currentValue: "sonnet",
              },
              {
                id: "reasoning",
                type: "select",
                name: "Reasoning",
                options: [{ name: "Standard", value: "standard" }],
                currentValue: "standard",
              },
            ],
            modes: {
              currentModeId: "build",
              availableModes: [
                { id: "build", name: "Build" },
                { id: "plan", name: "Plan" },
              ],
            },
          }),
        },
        initializeResponse: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
      }),
    });

    await repo.refreshCachedConfig("poolside", "/");

    const entry = repo.configCacheByAgentServer.poolside;
    // Fresh definitions (the new model) with the user's still-valid selection.
    expect(entry.configOptions).toEqual([
      expect.objectContaining({
        id: "model",
        currentValue: "opus",
        options: [
          { name: "Sonnet", value: "sonnet" },
          { name: "Opus", value: "opus" },
          { name: "New Model", value: "new-model" },
        ],
      }),
      // The cached value vanished from the agent's definitions; the agent's
      // default wins.
      expect.objectContaining({ id: "reasoning", currentValue: "standard" }),
    ]);
    expect(entry.modes).toEqual({
      currentModeId: "plan",
      availableModes: [
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
      ],
    });
  });

  it("adopts a changed agent default for options the user never chose", async () => {
    const repo = new ACPAgentRepository();
    const modelOption = (currentValue: string) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: [
        { name: "Sonnet", value: "sonnet" },
        { name: "New Model", value: "new-model" },
      ],
      currentValue,
    });
    // Cached from an earlier probe, when the agent defaulted to sonnet. The
    // user never opened the picker, so nothing is recorded as their choice.
    repo.configCacheByAgentServer = {
      poolside: {
        agentServer: "poolside",
        configOptions: [modelOption("sonnet")],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-08-04T00:00:00.000Z",
      },
    };
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: {
          newSession: vi.fn().mockResolvedValue({
            sessionId: "probe-2",
            // The lab shipped a model and made it the default.
            configOptions: [modelOption("new-model")],
          }),
        },
        initializeResponse: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
      }),
    });

    await repo.refreshCachedConfig("poolside", "/");

    expect(repo.configCacheByAgentServer.poolside.configOptions).toEqual([
      expect.objectContaining({ id: "model", currentValue: "new-model" }),
    ]);
  });

  it("does not let a probe's mode push override the user's chosen mode", () => {
    const repo = new ACPAgentRepository();
    repo.configProbeSessionIds.set("poolside", "probe-1");
    repo.recordUserModeSelection("poolside", "plan");
    repo.configCacheByAgentServer = {
      poolside: {
        agentServer: "poolside",
        configOptions: [],
        availableCommands: [],
        modes: { currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan" }] },
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-08-04T00:00:00.000Z",
      },
    };

    const handled = repo.handleConfigProbeSessionUpdate("poolside", {
      sessionId: "probe-1",
      update: { sessionUpdate: "current_mode_update", currentModeId: "build" },
    } as SessionNotification);

    expect(handled).toBe(true);
    expect(repo.configCacheByAgentServer.poolside.modes?.currentModeId).toBe("plan");
  });

  it("backs off after a failed probe instead of retrying on every focus", async () => {
    const newSession = vi.fn().mockRejectedValue(new Error("agent offline"));
    const repo = new ACPAgentRepository();
    repo.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn: { newSession },
        initializeResponse: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
      }),
    });

    await repo.ensureConfigProbe("poolside", "/", { quiet: true });
    await repo.ensureConfigProbe("poolside", "/", { quiet: true });
    await repo.ensureConfigProbe("poolside", "/", { quiet: true });

    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it("does not let a loud caller reuse an in-flight quiet refresh", async () => {
    const repo = new ACPAgentRepository();
    let releaseFirst = () => {};
    const core = vi
      .spyOn(
        repo as unknown as {
          refreshCachedConfigCore: (a: string, c: string, q?: boolean) => Promise<void>;
        },
        "refreshCachedConfigCore",
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const quiet = repo.refreshCachedConfig("local", "/", { quiet: true });
    // The user opens a new conversation while the background probe is still
    // in flight. Reusing the quiet refresh would swallow a failure they need
    // to see, so a loud probe is chained behind it instead.
    const loud = repo.refreshCachedConfig("local", "/");

    await flushMicrotasks();
    expect(core).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([quiet, loud]);

    expect(core).toHaveBeenCalledTimes(2);
    expect(core.mock.calls[0][2]).toBe(true);
    expect(core.mock.calls[1][2]).toBe(false);
  });

  it("lets a quiet caller ride along on an in-flight quiet refresh", async () => {
    const repo = new ACPAgentRepository();
    let releaseFirst = () => {};
    const core = vi
      .spyOn(
        repo as unknown as { refreshCachedConfigCore: (a: string, c: string) => Promise<void> },
        "refreshCachedConfigCore",
      )
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      );

    const first = repo.refreshCachedConfig("local", "/", { quiet: true });
    const second = repo.refreshCachedConfig("local", "/", { quiet: true });

    await flushMicrotasks();
    releaseFirst();
    await Promise.all([first, second]);
    // Background focus bursts share one probe rather than stacking.
    expect(core).toHaveBeenCalledTimes(1);
  });

  it("reports config cache refreshes using normalized agent names", () => {
    const repo = new ACPAgentRepository();
    repo.configCacheRefreshes.set("poolside", Promise.resolve());

    expect(repo.isConfigCacheRefreshInFlightFor("default")).toBe(true);
    expect(repo.isConfigCacheRefreshInFlightFor("codex-acp")).toBe(false);
  });

  it("returns the in-flight refresh instead of starting another", async () => {
    const repo = new ACPAgentRepository();
    let releaseFirst = () => {};
    const core = vi
      .spyOn(
        repo as unknown as { refreshCachedConfigCore: (a: string, c: string) => Promise<void> },
        "refreshCachedConfigCore",
      )
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      );

    const first = repo.refreshCachedConfig("local", "/");
    const second = repo.refreshCachedConfig("local", "/");

    await flushMicrotasks();
    expect(core).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(core).toHaveBeenCalledTimes(1);
    expect(repo.isConfigCacheRefreshInFlightFor("local")).toBe(false);
  });

  it("chains a fresh refresh behind an in-flight one", async () => {
    const repo = new ACPAgentRepository();
    let releaseFirst = () => {};
    const core = vi
      .spyOn(
        repo as unknown as { refreshCachedConfigCore: (a: string, c: string) => Promise<void> },
        "refreshCachedConfigCore",
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const first = repo.refreshCachedConfig("local", "/");
    const second = repo.refreshCachedConfig("local", "/", { fresh: true });

    await flushMicrotasks();
    // The fresh refresh waits for the in-flight probe to finish.
    expect(core).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(core).toHaveBeenCalledTimes(2);
    expect(repo.isConfigCacheRefreshInFlightFor("local")).toBe(false);
  });

  it("merges downloaded local inference models into the cached model config option", async () => {
    const { camberAcpNavUpsertConfigCache } = await import("@camber/helperapi");
    const repo = new ACPAgentRepository();
    repo.configCacheByAgentServer = {
      local: {
        agentServer: "local",
        configOptions: [
          {
            id: "mode",
            type: "select",
            name: "Mode",
            category: "mode",
            options: [{ name: "Default", value: "default" }],
            currentValue: "default",
          },
          {
            id: "model",
            type: "select",
            name: "Model",
            category: "model",
            options: [{ name: "old-model", value: "old-model" }],
            currentValue: "old-model",
          },
        ],
        availableCommands: [{ name: "help", description: "Help" }],
        modes: { currentModeId: "default", availableModes: [] },
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-06-22T00:00:00.000Z",
      },
    };

    await repo.upsertLocalInferenceModelConfigOptions(
      "local",
      localInferenceState([
        localInferenceModel({
          id: "mlx-community/Laguna-XS-2.1-4bit",
          name: "Laguna XS 2.1 4-bit",
          downloaded: true,
          recommended: true,
          default: true,
        }),
        localInferenceModel({
          id: "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit",
          name: "Qwen3.6 35B A3B OptiQ 4-bit",
          downloaded: true,
          recommended: true,
        }),
        localInferenceModel({
          id: "custom/Downloaded-From-Search-4bit",
          name: "Downloaded From Search 4bit",
          downloaded: true,
          recommended: false,
        }),
        localInferenceModel({
          id: "custom/Disabled-4bit",
          name: "Disabled 4bit",
          downloaded: true,
          disabled: true,
        }),
        localInferenceModel({
          id: "mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit",
          name: "Gemma 4 E4B IT QAT OptiQ 4-bit",
          downloaded: false,
          recommended: true,
        }),
      ]),
    );

    expect(repo.configCacheByAgentServer.local.configOptions).toEqual([
      expect.objectContaining({ id: "mode", currentValue: "default" }),
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit",
        options: [
          {
            name: "mlx-community/Laguna-XS-2.1-4bit",
            value: "mlx-community/Laguna-XS-2.1-4bit",
            description: "mlx-community/Laguna-XS-2.1-4bit",
          },
          {
            name: "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit",
            value: "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit",
            description: "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit",
          },
          {
            name: "custom/Downloaded-From-Search-4bit",
            value: "custom/Downloaded-From-Search-4bit",
            description: "custom/Downloaded-From-Search-4bit",
          },
        ],
      },
    ]);
    expect(camberAcpNavUpsertConfigCache).toHaveBeenCalledWith(
      expect.objectContaining({
        agentServer: "local",
        configOptions: [
          expect.objectContaining({ id: "mode", currentValue: "default" }),
          expect.objectContaining({
            id: "model",
            currentValue: "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit",
          }),
        ],
      }),
    );
  });

  it("removes stale local model config options when no models are downloaded", async () => {
    const repo = new ACPAgentRepository();
    repo.configCacheByAgentServer = {
      local: {
        agentServer: "local",
        configOptions: [
          {
            id: "mode",
            type: "select",
            name: "Mode",
            category: "mode",
            options: [{ name: "Default", value: "default" }],
            currentValue: "default",
          },
          {
            id: "model",
            type: "select",
            name: "Model",
            category: "model",
            options: [{ name: "old-model", value: "old-model" }],
            currentValue: "old-model",
          },
        ],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-06-22T00:00:00.000Z",
      },
    };

    await repo.upsertLocalInferenceModelConfigOptions(
      "local",
      localInferenceState([
        localInferenceModel({
          id: "custom/Not-Downloaded-4bit",
          name: "Not Downloaded 4bit",
          downloaded: false,
        }),
      ]),
    );

    expect(repo.configCacheByAgentServer.local.configOptions).toEqual([
      expect.objectContaining({ id: "mode" }),
    ]);
  });

  it("syncs config-probe mode updates into cached mode config options", async () => {
    const { camberAcpNavUpsertConfigCache } = await import("@camber/helperapi");
    const repo = new ACPAgentRepository();
    repo.configProbeSessionIds.set("poolside", "probe-session");
    repo.configCacheByAgentServer = {
      poolside: {
        agentServer: "poolside",
        configOptions: [
          {
            id: "mode",
            type: "select",
            name: "Mode",
            category: "mode",
            options: [
              { name: "Default", value: "default" },
              { name: "Plan", value: "plan" },
            ],
            currentValue: "default",
          },
        ],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-06-22T00:00:00.000Z",
      },
    };

    const handled = repo.handleConfigProbeSessionUpdate("poolside", {
      sessionId: "probe-session",
      update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
    } as SessionNotification);

    expect(handled).toBe(true);
    expect(repo.configCacheByAgentServer.poolside.configOptions).toEqual([
      expect.objectContaining({ id: "mode", currentValue: "plan" }),
    ]);
    expect(repo.configCacheByAgentServer.poolside.modes).toEqual({
      currentModeId: "plan",
      availableModes: [],
    });
    expect(camberAcpNavUpsertConfigCache).toHaveBeenCalledWith(
      expect.objectContaining({
        agentServer: "poolside",
        configOptions: [expect.objectContaining({ id: "mode", currentValue: "plan" })],
        modes: { currentModeId: "plan", availableModes: [] },
      }),
    );
  });
});

function localInferenceState(catalog: LocalInferenceModel[]): LocalInferenceState {
  return {
    catalog,
    modelsDirectory: "/tmp/models",
    runtime: {
      supported: true,
      status: "running",
      agentServer: "local",
      defaultModelId: "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit",
    },
  };
}

function localInferenceModel(
  model: Partial<LocalInferenceModel> & { id: string },
): LocalInferenceModel {
  return {
    id: model.id,
    repoId: model.repoId ?? model.id,
    name: model.name ?? model.id,
    provider: model.provider ?? "provider",
    downloaded: model.downloaded ?? false,
    recommended: model.recommended,
    default: model.default,
    disabled: model.disabled,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}
