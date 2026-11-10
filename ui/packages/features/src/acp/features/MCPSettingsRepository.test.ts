import type { MCPServerInputs } from "@camber/helperapi/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACPMCPSettingsRepositoryWriter } from "./MCPSettingsRepository.svelte";

vi.mock("../hostRpc", () => ({
  rpc: {
    jsonrpc: vi.fn(),
  },
}));

import { rpc as acpHostRpc } from "../hostRpc";

const rawACPHostRpc = acpHostRpc as unknown as {
  jsonrpc: ReturnType<typeof vi.fn>;
};

function createMockServer(overrides: Partial<MCPServerInputs> = {}): MCPServerInputs {
  return {
    serverID: "server-1",
    serverName: "Test Server",
    serverURL: "https://mcp.example.com",
    variables: [],
    requiresOAuth: false,
    isAuthenticated: false,
    disabled: false,
    ...overrides,
  };
}

function createACPContext(overrides: Record<string, any> = {}) {
  const { agents: agentOverrides, ...contextOverrides } = overrides;
  const defaultAgents = {
    defaultAgentServer: "pool",
    configProbeSessionIdsByAgentServer: {},
    ensureConfigProbe: vi.fn().mockResolvedValue(undefined),
    initializeResponses: {
      pool: {
        agentCapabilities: {
          _meta: { "camber/mcp_settings": true },
        },
      },
    },
  };
  const agents = {
    ...defaultAgents,
    ...(agentOverrides ?? {}),
  };
  agents.capabilitiesFor ??= (agentServer: string) =>
    agents.initializeResponses[agentServer]?.agentCapabilities ?? null;
  return {
    ...contextOverrides,
    agents,
  } as any;
}

describe("ACPMCPSettingsRepositoryWriter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the active ACP session when one is available", async () => {
    const repo = new ACPMCPSettingsRepositoryWriter(createACPContext(), {
      getActiveSession: () => ({ agentServer: "pool", sessionId: "session-1" }),
    });
    const mockServers = [createMockServer()];

    rawACPHostRpc.jsonrpc.mockResolvedValue({
      mcpServers: mockServers,
      allowCustomMCPServers: true,
      hasLocalMCPServers: false,
      localMCPServerNames: [],
    });

    await repo.fetchSettings();

    expect(rawACPHostRpc.jsonrpc).toHaveBeenCalledWith("camber/acp/_poolside/mcp/settings", {
      agentServer: "pool",
      sessionId: "session-1",
    });
    expect(repo.servers).toEqual(mockServers);
    expect(repo.activeSessionAllowsCustomMCPServers()).toBe(true);
  });

  it("exposes the active session's custom MCP policy but not a config probe's", async () => {
    const activeRepo = new ACPMCPSettingsRepositoryWriter(createACPContext(), {
      getActiveSession: () => ({ agentServer: "pool", sessionId: "session-1" }),
    });
    const probeRepo = new ACPMCPSettingsRepositoryWriter(
      createACPContext({
        agents: {
          configProbeSessionIdsByAgentServer: { pool: "config-session-1" },
        },
      }),
    );
    rawACPHostRpc.jsonrpc.mockResolvedValue({
      mcpServers: [],
      allowCustomMCPServers: false,
    });

    await activeRepo.fetchSettings();
    await probeRepo.fetchSettings();

    expect(activeRepo.activeSessionAllowsCustomMCPServers()).toBe(false);
    expect(probeRepo.activeSessionAllowsCustomMCPServers()).toBeNull();
  });

  it("uses the ACP config probe when no active session exists", async () => {
    const repo = new ACPMCPSettingsRepositoryWriter(
      createACPContext({
        agents: {
          defaultAgentServer: "pool",
          configProbeSessionIdsByAgentServer: { pool: "config-session-1" },
          initializeResponses: {
            pool: {
              agentCapabilities: {
                _meta: { "camber/mcp_settings": true },
              },
            },
          },
        },
      }),
    );
    const mockServers = [createMockServer()];

    rawACPHostRpc.jsonrpc.mockResolvedValue({
      mcpServers: mockServers,
      allowCustomMCPServers: true,
      hasLocalMCPServers: false,
      localMCPServerNames: [],
    });

    await repo.fetchSettings();

    expect(rawACPHostRpc.jsonrpc).toHaveBeenCalledWith("camber/acp/_poolside/mcp/settings", {
      agentServer: "pool",
      sessionId: "config-session-1",
    });
    expect(repo.servers).toEqual(mockServers);
  });

  it("ensures a Pool ACP config probe with a dummy cwd", async () => {
    const ensureConfigProbe = vi.fn().mockResolvedValue(undefined);
    const repo = new ACPMCPSettingsRepositoryWriter(
      createACPContext({
        agents: {
          defaultAgentServer: "poolside",
          configProbeSessionIdsByAgentServer: {},
          ensureConfigProbe,
          initializeResponses: {},
        },
      }),
    );

    await repo.ensureSettingsSession();

    expect(ensureConfigProbe).toHaveBeenCalledWith("poolside", "/");
  });

  it("does not ensure a third-party ACP config probe without the MCP capability", async () => {
    const ensureConfigProbe = vi.fn().mockResolvedValue(undefined);
    const repo = new ACPMCPSettingsRepositoryWriter(
      createACPContext({
        agents: {
          defaultAgentServer: "third-party",
          configProbeSessionIdsByAgentServer: {},
          ensureConfigProbe,
          initializeResponses: {},
        },
      }),
    );

    await repo.ensureSettingsSession();

    expect(ensureConfigProbe).not.toHaveBeenCalled();
  });

  it("does not call active-session ACP MCP methods while no settings session is available", async () => {
    const repo = new ACPMCPSettingsRepositoryWriter(createACPContext());
    rawACPHostRpc.jsonrpc.mockResolvedValue({});

    await repo.setVariableValue(
      { serverName: "server-1", serverID: "server-1", serverURL: "https://example.com" } as never,
      "API_KEY",
      "secret",
    );

    expect(rawACPHostRpc.jsonrpc).not.toHaveBeenCalled();
  });

  it("applies connector toggles globally and to the active conversation", async () => {
    const repo = new ACPMCPSettingsRepositoryWriter(createACPContext(), {
      getActiveSession: () => ({ agentServer: "pool", sessionId: "session-1" }),
    });
    rawACPHostRpc.jsonrpc.mockResolvedValue({});

    await repo.persistServerDisabled("Linear", false);

    expect(rawACPHostRpc.jsonrpc).toHaveBeenNthCalledWith(
      1,
      "camber/mcpServers/setPoolServerDisabled",
      { serverName: "Linear", disabled: false },
    );
    expect(rawACPHostRpc.jsonrpc).toHaveBeenNthCalledWith(
      2,
      "camber/acp/_poolside/mcp/set_server_disabled",
      {
        agentServer: "pool",
        sessionId: "session-1",
        serverName: "Linear",
        disabled: false,
      },
    );
    expect(repo.disabledState.Linear).toBe(false);
  });

  it("rolls back the global toggle when the active conversation update fails", async () => {
    const repo = new ACPMCPSettingsRepositoryWriter(createACPContext(), {
      getActiveSession: () => ({ agentServer: "pool", sessionId: "session-1" }),
    });
    repo.servers = [createMockServer({ serverName: "Linear", disabled: true })];
    rawACPHostRpc.jsonrpc
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("session unavailable"))
      .mockResolvedValueOnce({});

    await expect(repo.persistServerDisabled("Linear", false)).rejects.toThrow(
      "session unavailable",
    );

    expect(rawACPHostRpc.jsonrpc).toHaveBeenNthCalledWith(
      3,
      "camber/mcpServers/setPoolServerDisabled",
      { serverName: "Linear", disabled: true },
    );
    expect(repo.disabledState.Linear).toBeUndefined();
    expect(repo.isServerDisabled(repo.servers[0]!)).toBe(true);
  });
});
