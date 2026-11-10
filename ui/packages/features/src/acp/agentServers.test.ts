import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_SERVER,
  LEGACY_DEFAULT_AGENT_SERVER,
  LOCAL_AGENT_SERVER,
  agentServerNames,
  normalizeAgentServerName,
  resolveAgentServers,
} from "./agentServers";

describe("resolveAgentServers", () => {
  it("adds the default Camber registry server to custom config", () => {
    const servers = resolveAgentServers({
      echo: {
        command: "node",
        args: ["echo-acp.mjs"],
      },
    });

    expect(servers[DEFAULT_AGENT_SERVER]).toEqual({
      command: "",
      args: undefined,
    });
    expect(servers).not.toHaveProperty(LOCAL_AGENT_SERVER);
    expect(servers.echo).toEqual({
      command: "node",
      args: ["echo-acp.mjs"],
    });
  });

  it("preserves configured Camber entries", () => {
    const servers = resolveAgentServers({
      [DEFAULT_AGENT_SERVER]: {
        command: "pool",
        args: ["custom-acp"],
        default_config_options: { mode: "plan" },
      },
      echo: {
        command: "node",
      },
    });

    expect(servers[DEFAULT_AGENT_SERVER]).toEqual({
      command: "pool",
      args: ["custom-acp"],
      default_config_options: { mode: "plan" },
    });
    expect(Object.keys(servers)).toEqual([DEFAULT_AGENT_SERVER, "echo"]);
  });

  it("replaces legacy self placeholders for Camber entries", () => {
    for (const command of ["{{SELF}}", "{{$SELF}}"]) {
      const servers = resolveAgentServers({
        [DEFAULT_AGENT_SERVER]: {
          command,
          args: ["acp"],
          default_config_options: { mode: "plan" },
        },
      });

      expect(servers[DEFAULT_AGENT_SERVER]).toEqual({
        command: "",
        args: undefined,
        default_config_options: { mode: "plan" },
      });
    }
  });

  it("treats legacy default as an alias for Camber", () => {
    const servers = resolveAgentServers({
      [LEGACY_DEFAULT_AGENT_SERVER]: {
        command: "pool",
        args: ["custom-acp"],
      },
    });

    expect(Object.keys(servers)).toEqual([DEFAULT_AGENT_SERVER]);
    expect(normalizeAgentServerName(LEGACY_DEFAULT_AGENT_SERVER)).toBe(DEFAULT_AGENT_SERVER);
    expect(agentServerNames({ [LEGACY_DEFAULT_AGENT_SERVER]: { command: "pool" } })).toEqual([
      DEFAULT_AGENT_SERVER,
    ]);
  });

  it("preserves the Desktop-managed local agent when the helper advertises it", () => {
    const servers = resolveAgentServers({
      [LOCAL_AGENT_SERVER]: { type: "local" },
    });

    expect(servers[LOCAL_AGENT_SERVER]).toEqual({
      type: "local",
      command: "",
      args: undefined,
    });
  });
});
