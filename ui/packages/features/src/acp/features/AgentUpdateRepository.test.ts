import type { ACPAgentServers } from "@camber/rpc";
import { get, writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ACPRegistryAgent } from "../agentRegistry";
import { appState, type AppState, type AppStore } from "../hostAdapter";
import type { AcpAgentRegistryRepository } from "./AgentRegistryRepository.svelte";
import { ACPAgentUpdateRepository } from "./AgentUpdateRepository.svelte";
import type { ACPSessionRepositoryWriter } from "./SessionRepository.svelte";

vi.mock("@camber/helperapi", () => ({
  camberAcpNavInstallAgentServer: vi.fn(async () => ({ installed: true })),
}));

vi.mock("../hostRpc", () => ({
  rpc: {
    setACPAgentServers: vi.fn(async () => undefined),
  },
}));

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

function createRepo(
  agentServers: ACPAgentServers,
  agents: ACPRegistryAgent[] = [camberAgent("1.0.5")],
) {
  const appStore = createAppStore({
    userSettings: { acpAgentServers: agentServers },
  });
  const registryRepo = {
    agents,
  } as AcpAgentRegistryRepository;
  const sessionRepo = {
    hasActiveConversationsForAgent: vi.fn(() => false),
    agents: {
      isConnectedTo: vi.fn(() => false),
      getInitializeResponse: vi.fn(() => null),
      restart: vi.fn(async () => undefined),
      refreshCachedConfig: vi.fn(async () => undefined),
    },
  } as unknown as ACPSessionRepositoryWriter;

  return {
    appStore,
    registryRepo,
    sessionRepo,
    repo: new ACPAgentUpdateRepository({
      appState: appStore,
      registryRepo,
      sessionRepo,
    }),
  };
}

function camberAgent(version: string): ACPRegistryAgent {
  return {
    id: "poolside",
    name: "Camber",
    version,
    description: "Camber ACP agent",
    distribution: {
      binary: {
        "darwin-aarch64": {
          archive: `https://downloads.poolside.ai/pool/v${version}/pool-darwin-arm64.tar.gz`,
          cmd: "./pool-darwin-arm64",
          args: ["acp"],
        },
      },
    },
  };
}

function npxAgent(id: string, name: string, pkg: string): ACPRegistryAgent {
  return {
    id,
    name,
    version: "1.0.0",
    description: `${name} ACP agent`,
    distribution: {
      npx: {
        package: pkg,
      },
    },
  };
}

function camberConfig(version: string): ACPAgentServers {
  return {
    poolside: {
      type: "registry",
      command: "",
      args: [],
      env: {},
      binary: {
        "darwin-aarch64": {
          archive: `https://downloads.poolside.ai/pool/v${version}/pool-darwin-arm64.tar.gz`,
          cmd: "./pool-darwin-arm64",
          args: ["acp"],
        },
      },
      default_config_options: {
        mode: "always-allow",
      },
    },
  };
}

describe("ACPAgentUpdateRepository", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("detects registry updates for the bundled Camber agent", () => {
    const { repo } = createRepo(camberConfig("1.0.4"));

    repo.refresh();

    expect(repo.updateFor("poolside")?.agent.version).toBe("1.0.5");
    expect(repo.hasUpdate("poolside")).toBe(true);
  });

  function runningAgent(version = "1.0.4") {
    const context = createRepo(camberConfig("1.0.5"));
    vi.mocked(context.sessionRepo.agents.isConnectedTo).mockReturnValue(true);
    vi.mocked(context.sessionRepo.agents.getInitializeResponse).mockReturnValue({
      protocolVersion: 1,
      agentInfo: { name: "poolside", version },
    });
    context.repo.refresh();
    return context;
  }

  it("offers restart when the installed release is newer than the connected agent", () => {
    const { repo } = runningAgent();
    expect(repo.updateFor("poolside")?.kind).toBe("restart");
  });

  it("detects an older Codex process even when another window installed a release ahead of the registry cache", () => {
    const { repo, sessionRepo } = createRepo(
      {
        "codex-acp": {
          type: "registry",
          command: "npx",
          args: ["-y", "@agentclientprotocol/codex-acp@1.13.1"],
        },
      },
      [npxAgent("codex-acp", "Codex", "@agentclientprotocol/codex-acp@1.12.0")],
    );
    vi.mocked(sessionRepo.agents.isConnectedTo).mockReturnValue(true);
    vi.mocked(sessionRepo.agents.getInitializeResponse).mockReturnValue({
      protocolVersion: 1,
      agentInfo: { name: "codex-acp", version: "1.12.0" },
    });
    repo.refresh();
    expect(repo.updateFor("codex-acp")).toMatchObject({
      kind: "restart",
      agent: { version: "1.13.1" },
    });
  });

  it.each(["1.0.5", "v1.0.5+build.2", "1.0.6", "dev", "1.0.5-beta.1"])(
    "does not request restart for an equal, newer, or unknown running version: %s",
    (version) => {
      expect(runningAgent(version).repo.hasUpdate("poolside")).toBe(false);
    },
  );

  it("ignores a disconnected agent's previous initialize response", () => {
    const { repo, sessionRepo } = runningAgent();
    vi.mocked(sessionRepo.agents.isConnectedTo).mockReturnValue(false);
    repo.refresh();
    expect(repo.hasUpdate("poolside")).toBe(false);
  });

  it("does not offer a downgrade from an older cached registry", () => {
    const { repo } = createRepo(camberConfig("1.0.6"));
    repo.refresh();
    expect(repo.hasUpdate("poolside")).toBe(false);
  });

  it("restarts an installed update without reinstalling and refreshes models afterwards", async () => {
    const { camberAcpNavInstallAgentServer } = await import("@camber/helperapi");
    const { repo, sessionRepo } = runningAgent();
    vi.mocked(sessionRepo.agents.refreshCachedConfig).mockImplementationOnce(async () => {
      expect(sessionRepo.agents.restart).toHaveBeenCalledWith("poolside");
      vi.mocked(sessionRepo.agents.getInitializeResponse).mockReturnValue({
        protocolVersion: 1,
        agentInfo: { name: "poolside", version: "1.0.5" },
      });
    });
    await repo.update("poolside");
    expect(camberAcpNavInstallAgentServer).not.toHaveBeenCalled();
    expect(sessionRepo.agents.refreshCachedConfig).toHaveBeenCalledWith("poolside", "/", {
      fresh: true,
    });
    expect(repo.hasUpdate("poolside")).toBe(false);
  });

  it("keeps a failed restart actionable after its old connection is cleared", async () => {
    const { repo, sessionRepo } = runningAgent();
    vi.mocked(sessionRepo.agents.restart).mockImplementationOnce(async () => {
      vi.mocked(sessionRepo.agents.isConnectedTo).mockReturnValue(false);
      vi.mocked(sessionRepo.agents.getInitializeResponse).mockReturnValue(null);
      throw new Error("agent failed to start");
    });
    await expect(repo.update("poolside")).rejects.toThrow("agent failed to start");
    repo.refresh();
    expect(repo.updateFor("poolside")?.kind).toBe("restart");
  });

  it("does not restart an agent with running conversations", async () => {
    const { repo, sessionRepo } = runningAgent();
    vi.mocked(sessionRepo.hasActiveConversationsForAgent).mockReturnValue(true);
    await expect(repo.update("poolside")).rejects.toThrow("running conversations");
    expect(sessionRepo.agents.restart).not.toHaveBeenCalled();
  });

  it("does not prompt install for the bundled Camber agent when nothing is configured", () => {
    const { repo } = createRepo({});

    repo.refresh();

    expect(repo.hasUpdate("poolside")).toBe(false);
  });

  it("does not prompt install for the bundled Camber agent when only default config options are set", () => {
    const { repo } = createRepo({
      poolside: {
        command: "",
        default_config_options: {
          mode: "always-allow",
        },
      },
    });

    repo.refresh();

    expect(repo.hasUpdate("poolside")).toBe(false);
  });

  it("detects registry agents that are enabled but not installed locally", () => {
    const { repo } = createRepo({
      poolside: {
        type: "registry",
        command: "",
      },
    });

    repo.refresh();

    expect(repo.updateFor("poolside")).toEqual(
      expect.objectContaining({
        kind: "install",
        agentServer: "poolside",
      }),
    );
  });

  it("does not flag installed binary registry agents when command is omitted", () => {
    const { repo } = createRepo({
      poolside: {
        type: "registry",
        binary: {
          "darwin-aarch64": {
            archive: "https://downloads.poolside.ai/pool/v1.0.5/pool-darwin-arm64.tar.gz",
            cmd: "./pool-darwin-arm64",
            args: ["acp"],
          },
        },
      },
    });

    repo.refresh();

    expect(repo.hasUpdate("poolside")).toBe(false);
  });

  it("detects non-default registry agents that are enabled but not installed locally", () => {
    const { repo } = createRepo(
      {
        "claude-acp": {
          type: "registry",
        },
        "codex-acp": {
          type: "registry",
        },
        cursor: {
          type: "registry",
        },
      },
      [
        npxAgent("claude-acp", "Claude", "@zed-industries/claude-code-acp@1.0.0"),
        npxAgent("codex-acp", "Codex", "@zed-industries/codex-acp@1.0.0"),
        npxAgent("cursor", "Cursor", "@zed-industries/cursor-agent@1.0.0"),
      ],
    );

    repo.refresh();

    expect(repo.updateFor("claude-acp")).toEqual(
      expect.objectContaining({
        kind: "install",
        agentServer: "claude-acp",
      }),
    );
    expect(repo.updateFor("codex-acp")).toEqual(
      expect.objectContaining({
        kind: "install",
        agentServer: "codex-acp",
      }),
    );
    expect(repo.updateFor("cursor")).toEqual(
      expect.objectContaining({
        kind: "install",
        agentServer: "cursor",
      }),
    );
  });

  it.each(["@zed-industries/codex-acp@0.15.3", "@agentclientprotocol/codex-acp@1.0.0"])(
    "offers a regular update for legacy Codex package %s",
    (packageReference) => {
      const { repo } = createRepo(
        {
          "codex-acp": {
            type: "custom",
            command: "npx",
            args: ["-y", packageReference],
            default_config_options: {
              mode: "full-access",
            },
          },
        },
        [npxAgent("codex-acp", "Codex", "@agentclientprotocol/codex-acp@1.1.4")],
      );

      repo.refresh();

      expect(repo.updateFor("codex-acp")).toEqual(
        expect.objectContaining({
          kind: "update",
          agentServer: "codex-acp",
          currentConfig: expect.objectContaining({
            args: ["-y", packageReference],
          }),
          nextConfig: expect.objectContaining({
            args: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
          }),
        }),
      );
    },
  );

  it("offers regular updates for other legacy registry-shaped npm agents", () => {
    const { repo } = createRepo(
      {
        "claude-acp": {
          type: "custom",
          command: "npx",
          args: ["-y", "@zed-industries/claude-code-acp@0.9.0"],
        },
      },
      [npxAgent("claude-acp", "Claude", "@zed-industries/claude-code-acp@1.0.0")],
    );

    repo.refresh();

    expect(repo.updateFor("claude-acp")).toEqual(
      expect.objectContaining({
        kind: "update",
        agentServer: "claude-acp",
      }),
    );
  });

  it.each([
    {
      name: "a different npm package",
      config: {
        type: "custom" as const,
        command: "npx",
        args: ["-y", "example-codex-wrapper@0.15.3"],
      },
    },
    {
      name: "custom package arguments",
      config: {
        type: "custom" as const,
        command: "npx",
        args: ["-y", "@zed-industries/codex-acp@0.15.3", "--custom-flag"],
      },
    },
    {
      name: "custom environment variables",
      config: {
        type: "custom" as const,
        command: "npx",
        args: ["-y", "@zed-industries/codex-acp@0.15.3"],
        env: { CUSTOM_SETTING: "true" },
      },
    },
    {
      name: "the current registry package",
      config: {
        type: "custom" as const,
        command: "npx",
        args: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
      },
    },
  ])("does not update $name for a custom Codex agent", ({ config }) => {
    const { repo } = createRepo({ "codex-acp": config }, [
      npxAgent("codex-acp", "Codex", "@agentclientprotocol/codex-acp@1.1.4"),
    ]);

    repo.refresh();

    expect(repo.hasUpdate("codex-acp")).toBe(false);
  });

  it("updates a legacy Codex agent to the current registry config", async () => {
    const { camberAcpNavInstallAgentServer } = await import("@camber/helperapi");
    const { rpc } = await import("../hostRpc");
    const { repo, appStore, sessionRepo } = createRepo(
      {
        "codex-acp": {
          type: "custom",
          command: "npx",
          args: ["-y", "@zed-industries/codex-acp@0.15.3"],
          default_config_options: {
            mode: "full-access",
          },
        },
      },
      [npxAgent("codex-acp", "Codex", "@agentclientprotocol/codex-acp@1.1.4")],
    );

    repo.refresh();
    const update = repo.update("codex-acp");
    await vi.advanceTimersByTimeAsync(500);
    await update;

    const expectedConfig = expect.objectContaining({
      type: "registry",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
      default_config_options: {
        mode: "full-access",
      },
    });
    expect(camberAcpNavInstallAgentServer).toHaveBeenCalledWith({
      agentServer: "codex-acp",
      config: expect.objectContaining({
        type: "registry",
        args: ["-y", "@agentclientprotocol/codex-acp@1.1.4"],
      }),
    });
    expect(rpc.setACPAgentServers).toHaveBeenCalledWith({
      "codex-acp": expectedConfig,
    });
    expect(get(appStore).userSettings.acpAgentServers?.["codex-acp"]).toEqual(expectedConfig);
    expect(sessionRepo.agents.refreshCachedConfig).toHaveBeenCalledWith("codex-acp");
    expect(repo.hasUpdate("codex-acp")).toBe(false);
  });

  it("updates through helper install and preserves local default config options", async () => {
    const { camberAcpNavInstallAgentServer } = await import("@camber/helperapi");
    const { rpc } = await import("../hostRpc");
    const { repo, appStore, sessionRepo } = createRepo(camberConfig("1.0.4"));

    repo.refresh();
    const update = repo.update("poolside");
    await vi.advanceTimersByTimeAsync(500);
    await update;

    expect(camberAcpNavInstallAgentServer).toHaveBeenCalledWith({
      agentServer: "poolside",
      config: expect.objectContaining({
        binary: expect.objectContaining({
          "darwin-aarch64": expect.objectContaining({
            archive: expect.stringContaining("/v1.0.5/"),
          }),
        }),
      }),
    });
    expect(rpc.setACPAgentServers).toHaveBeenCalledWith({
      poolside: expect.objectContaining({
        type: "registry",
        binary: expect.objectContaining({
          "darwin-aarch64": expect.objectContaining({
            archive: expect.stringContaining("/v1.0.5/"),
          }),
        }),
        default_config_options: {
          mode: "always-allow",
        },
      }),
    });
    expect(
      get(appStore).userSettings.acpAgentServers?.poolside?.binary?.["darwin-aarch64"]?.archive ??
        "",
    ).toContain("/v1.0.5/");
    expect(sessionRepo.agents.restart).toHaveBeenCalledWith("poolside");
    expect(sessionRepo.agents.refreshCachedConfig).toHaveBeenCalledWith("poolside");
    expect(repo.hasUpdate("poolside")).toBe(false);
  });

  it("preserves diagnostic messages from serialized helper errors", async () => {
    const { camberAcpNavInstallAgentServer } = await import("@camber/helperapi");
    const message =
      "invalid request params: unexpected property config.binary.darwin-aarch64.sha256";
    vi.mocked(camberAcpNavInstallAgentServer).mockRejectedValueOnce({
      code: -32602,
      message,
    });
    const { repo } = createRepo(camberConfig("1.0.4"));

    repo.refresh();

    await expect(repo.update("poolside")).rejects.toMatchObject({ message });
    expect(repo.error).toBe(message);
  });
});
