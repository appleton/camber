import { isFailure, isSuccess } from "@camber/lib/async-state";
import { get, writable } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appState, type AppState, type AppStore } from "../hostAdapter";
import { ACPAgentServersRepository } from "./AgentServersRepository.svelte";
import type { ACPSessionRepositoryWriter } from "./SessionRepository.svelte";

vi.mock("@camber/helperapi", () => ({
  camberAcpNavListAgentServers: vi.fn(),
}));

beforeEach(async () => {
  const { camberAcpNavListAgentServers } = await import("@camber/helperapi");
  vi.mocked(camberAcpNavListAgentServers).mockReset();
});

type AppStateInput = Omit<Partial<AppState>, "environment" | "userSettings"> & {
  environment?: Partial<AppState["environment"]>;
  userSettings?: Partial<AppState["userSettings"]>;
};

function createAppStore(state: AppStateInput): AppStore {
  const initial = get(appState);
  return writable({
    ...initial,
    ...state,
    environment: {
      ...initial.environment,
      ...state.environment,
    },
    userSettings: {
      ...initial.userSettings,
      ...state.userSettings,
    },
  });
}

function createRepo(appStore: AppStore) {
  const sessionRepo = {
    sessionId: null,
    agents: {
      defaultAgentServer: "poolside",
      defaultAgentServerPinned: false,
      configureAgentServers: vi.fn(() => ({
        changed: true,
        removedAgentServers: new Set<string>(),
      })),
      setDefaultAgentServer: vi.fn(async function (
        this: { defaultAgentServer: string },
        agentServer,
      ) {
        this.defaultAgentServer = agentServer;
        return {
          agentServers: get(appStore).userSettings.acpAgentServers,
          defaultAgentServer: agentServer,
        };
      }),
      setPinnedDefaultAgentServer: vi.fn(async function (
        this: { defaultAgentServer: string; defaultAgentServerPinned: boolean },
        agentServer,
      ) {
        this.defaultAgentServer = agentServer;
        this.defaultAgentServerPinned = true;
        return {
          agentServers: get(appStore).userSettings.acpAgentServers,
          defaultAgentServer: agentServer,
        };
      }),
      unpinDefaultAgentServer: vi.fn(async function (this: {
        defaultAgentServer: string;
        defaultAgentServerPinned: boolean;
      }) {
        this.defaultAgentServerPinned = false;
        return {
          agentServers: get(appStore).userSettings.acpAgentServers,
          defaultAgentServer: this.defaultAgentServer,
        };
      }),
    },
    reconcileAgentServerConfiguration: vi.fn(),
  } as unknown as ACPSessionRepositoryWriter;

  return {
    repo: new ACPAgentServersRepository({
      appState: appStore,
      sessionRepo,
    }),
    sessionRepo,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ACPAgentServersRepository", () => {
  it("keeps ready chats usable during background refreshes and transient failures", async () => {
    const appStore = createAppStore({});
    const { repo } = createRepo(appStore);
    const { camberAcpNavListAgentServers } = await import("@camber/helperapi");
    const installed = { "codex-acp": { command: "npx" } };
    vi.mocked(camberAcpNavListAgentServers).mockResolvedValueOnce({ agentServers: installed });
    await repo.refresh();
    const ready = repo.state;

    let rejectRefresh!: (error: Error) => void;
    vi.mocked(camberAcpNavListAgentServers).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRefresh = reject;
        }),
    );
    const refreshing = repo.refresh({ background: true });
    await flushPromises();
    expect(repo.state).toBe(ready);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      rejectRefresh(new Error("helper transport closed"));
      await refreshing;
      expect(repo.state).toBe(ready);
      expect(get(appStore).userSettings.acpAgentServers).toEqual(installed);

      const updated = { "codex-acp": { command: "codex-acp" } };
      vi.mocked(camberAcpNavListAgentServers).mockResolvedValueOnce({ agentServers: updated });
      await repo.refresh({ background: true });
      expect(repo.agentServers).toEqual(updated);
      expect(get(appStore).userSettings.acpAgentServers).toEqual(updated);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("configures ACP sessions from pool config-backed ACP agent servers", () => {
    const appStore = createAppStore({
      environment: { assistantHost: "vscode" },
      userSettings: {
        acpAgentServers: { "codex-acp": { command: "npx" } },
        agentServers: { "settings-only": { command: "node" } },
      },
    });
    const { repo, sessionRepo } = createRepo(appStore);

    repo.configureSessionRepo();

    // No list read has happened yet, so the pin mirror is still unknown
    // (undefined) — configureAgentServers must not clear a pin it never saw.
    expect(sessionRepo.agents.configureAgentServers).toHaveBeenCalledWith(
      ["poolside", "codex-acp"],
      undefined,
      undefined,
    );
    expect(sessionRepo.reconcileAgentServerConfiguration).toHaveBeenCalledWith({
      changed: true,
      removedAgentServers: expect.any(Set),
    });
  });

  it("refreshes pool config-backed agent servers once when ready", async () => {
    const appStore = createAppStore({
      environment: { assistantHost: "vscode" },
      userSettings: {
        acpAgentServers: {},
        agentServers: { "settings-only": { command: "node" } },
      },
    });
    const { camberAcpNavListAgentServers } = await import("@camber/helperapi");
    vi.mocked(camberAcpNavListAgentServers).mockResolvedValue({
      agentServers: { "codex-acp": { command: "npx" } },
    });
    const { repo, sessionRepo } = createRepo(appStore);

    repo.refreshWhenReady();
    await vi.waitFor(() => expect(isSuccess(repo.state)).toBe(true));

    expect(camberAcpNavListAgentServers).toHaveBeenCalledWith({});
    expect(get(appStore).userSettings.acpAgentServers).toEqual({
      "codex-acp": { command: "npx" },
    });
    expect(isSuccess(repo.state) ? repo.state.value : undefined).toEqual({
      "codex-acp": { command: "npx" },
    });
    expect(repo.agentServers).toEqual({
      "codex-acp": { command: "npx" },
    });
    // The list carried no pin flag, which means unpinned (Go omits false).
    expect(sessionRepo.agents.configureAgentServers).toHaveBeenCalledWith(
      ["poolside", "codex-acp"],
      undefined,
      false,
    );

    repo.refreshWhenReady();
    await flushPromises();
    expect(camberAcpNavListAgentServers).toHaveBeenCalledTimes(1);
  });

  it("explicitly refreshes pool config-backed agent servers on demand", async () => {
    const appStore = createAppStore({
      environment: { assistantHost: "vscode" },
      userSettings: {
        acpAgentServers: {},
      },
    });
    const { camberAcpNavListAgentServers } = await import("@camber/helperapi");
    vi.mocked(camberAcpNavListAgentServers)
      .mockResolvedValueOnce({
        agentServers: { "codex-acp": { command: "npx" } },
      })
      .mockResolvedValueOnce({
        agentServers: { "gemini-acp": { command: "node" } },
      });
    const { repo } = createRepo(appStore);

    await repo.refresh();
    await repo.refresh();

    expect(camberAcpNavListAgentServers).toHaveBeenCalledTimes(2);
    expect(get(appStore).userSettings.acpAgentServers).toEqual({
      "gemini-acp": { command: "node" },
    });
  });

  it("exposes config parse failures without logging an expected error", async () => {
    const appStore = createAppStore({
      environment: { assistantHost: "vscode" },
      userSettings: {
        acpAgentServers: { "codex-acp": { command: "npx" } },
      },
    });
    const error = new Error("assistant config: parsing assistant.json: invalid character");
    const { camberAcpNavListAgentServers } = await import("@camber/helperapi");
    vi.mocked(camberAcpNavListAgentServers).mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { repo } = createRepo(appStore);

    try {
      await repo.refresh();

      expect(isFailure(repo.state)).toBe(true);
      expect(repo.state).toEqual({ status: "failure", error });
      expect(get(appStore).userSettings.acpAgentServers).toEqual({
        "codex-acp": { command: "npx" },
      });
      expect(consoleError).not.toHaveBeenCalled();

      repo.refreshWhenReady();
      await flushPromises();
      expect(camberAcpNavListAgentServers).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs unexpected agent server load failures", async () => {
    const appStore = createAppStore({
      environment: { assistantHost: "vscode" },
      userSettings: {
        acpAgentServers: { "codex-acp": { command: "npx" } },
      },
    });
    const error = new Error("helper transport closed");
    const { camberAcpNavListAgentServers } = await import("@camber/helperapi");
    vi.mocked(camberAcpNavListAgentServers).mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { repo } = createRepo(appStore);

    try {
      await repo.refresh();

      expect(isFailure(repo.state)).toBe(true);
      expect(consoleError).toHaveBeenCalledWith("Failed to load ACP agent servers", error);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps the pool config-backed default agent in sync with the session repo", async () => {
    const appStore = createAppStore({
      environment: { assistantHost: "vscode" },
      userSettings: {
        acpAgentServers: { "codex-acp": { command: "npx" } },
      },
    });
    const { repo, sessionRepo } = createRepo(appStore);

    await repo.setDefaultAgentServer("codex-acp");
    repo.configureSessionRepo();

    expect(sessionRepo.agents.setDefaultAgentServer).toHaveBeenCalledWith("codex-acp");
    expect(repo.defaultAgentServer).toBe("codex-acp");
    // The pin mirror synced from the session repo's agents (unpinned here).
    expect(sessionRepo.agents.configureAgentServers).toHaveBeenLastCalledWith(
      ["poolside", "codex-acp"],
      "codex-acp",
      false,
    );
    expect(sessionRepo.reconcileAgentServerConfiguration).toHaveBeenCalledWith({
      changed: true,
      removedAgentServers: expect.any(Set),
    });
  });

  it("mirrors agent pin and unpin through the session repo", async () => {
    const appStore = createAppStore({
      environment: { assistantHost: "vscode" },
      userSettings: {
        acpAgentServers: { "codex-acp": { command: "npx" } },
      },
    });
    const { repo, sessionRepo } = createRepo(appStore);

    await repo.setPinnedDefaultAgentServer("codex-acp");
    expect(sessionRepo.agents.setPinnedDefaultAgentServer).toHaveBeenCalledExactlyOnceWith(
      "codex-acp",
    );
    expect(repo.defaultAgentServer).toBe("codex-acp");
    expect(repo.defaultAgentServerPinned).toBe(true);
    expect(sessionRepo.reconcileAgentServerConfiguration).toHaveBeenCalled();

    await repo.unpinDefaultAgentServer();
    expect(sessionRepo.agents.unpinDefaultAgentServer).toHaveBeenCalledTimes(1);
    expect(repo.defaultAgentServer).toBe("codex-acp");
    expect(repo.defaultAgentServerPinned).toBe(false);
  });

  it("keeps the local agent when the Desktop helper advertises it", async () => {
    const appStore = createAppStore({
      environment: { assistantHost: "desktop" },
      userSettings: { acpAgentServers: {} },
    });
    const { camberAcpNavListAgentServers } = await import("@camber/helperapi");
    vi.mocked(camberAcpNavListAgentServers).mockResolvedValue({
      agentServers: { local: { type: "local" } },
    });
    const { repo, sessionRepo } = createRepo(appStore);

    await repo.refresh();

    expect(sessionRepo.agents.configureAgentServers).toHaveBeenCalledWith(
      ["poolside", "local"],
      undefined,
      false,
    );
  });
});
