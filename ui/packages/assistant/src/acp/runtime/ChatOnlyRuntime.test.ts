import { appState, initializeACPHostRpc } from "@camber/features/acp";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatOnlyRuntime } from "./ChatOnlyRuntime.svelte";
import type { Runtime } from "./shared/types";

describe("ChatOnlyRuntime", () => {
  beforeEach(() => {
    const initial = get(appState);
    appState.set({
      ...initial,
      defaultCwd: "/fallback",
      workspaces: [{ path: "/workspace", name: "workspace", index: 0 }],
      environment: {
        ...initial.environment,
        assistantHost: "vscode",
      },
    });
    vi.stubGlobal("acquireVsCodeApi", () => ({ setState: vi.fn() }));
    window.CAMBER_INITIAL_ACP_CHAT_STATE = undefined;
    initializeACPHostRpc(vi.fn().mockResolvedValue(undefined));
  });

  it("asks the host to open a new ACP chat panel", async () => {
    const hostSender = vi.fn().mockResolvedValue(undefined);
    initializeACPHostRpc(hostSender);
    const runtime = new ChatOnlyRuntime(createCore(), undefined);

    await runtime.handleNewConversation();

    expect(hostSender).toHaveBeenCalledWith("openAcpChat", [{}]);
  });

  it("adds a selected project as an IDE pending conversation", async () => {
    const hostSender = vi.fn().mockImplementation((method: string) => {
      if (method === "selectProjectFolder") {
        return Promise.resolve({ path: "/new-project", name: "New project" });
      }
      return Promise.resolve(undefined);
    });
    initializeACPHostRpc(hostSender);
    const core = createCore();
    const runtime = new ChatOnlyRuntime(core, undefined);

    await runtime.handleAddProject();

    expect(hostSender).toHaveBeenCalledWith("selectProjectFolder", []);
    expect(core.acpConversationRepo.refresh).toHaveBeenCalledTimes(1);
    expect(core.acpAgentServers.refresh).toHaveBeenCalledTimes(1);
    expect(core.acpConversationRepo.createPendingConversation).toHaveBeenCalledWith(
      "IDE",
      "/new-project",
      "codex",
      ["/new-project"],
    );
    expect(core.acpRepo.createSession).toHaveBeenCalledWith("/new-project", "codex", "pending-1", {
      isPendingConversationPersisted: true,
    });
    expect(core.activeConversationId).toBe("conversation-1");
    expect(runtime.addingProject).toBe(false);
  });

  it("falls back to the Camber agent when no default agent is configured", async () => {
    const hostSender = vi.fn().mockResolvedValue({ path: "/new-project", name: "New project" });
    initializeACPHostRpc(hostSender);
    const core = createCore({ defaultAgentServer: "" });
    const runtime = new ChatOnlyRuntime(core, undefined);

    await runtime.handleAddProject();

    expect(core.acpConversationRepo.createPendingConversation).toHaveBeenCalledWith(
      "IDE",
      "/new-project",
      "poolside",
      ["/new-project"],
    );
  });

  it("does not mutate repos when project selection is cancelled", async () => {
    const hostSender = vi.fn().mockResolvedValue(null);
    initializeACPHostRpc(hostSender);
    const core = createCore();
    const runtime = new ChatOnlyRuntime(core, undefined);

    await runtime.handleAddProject();

    expect(core.acpConversationRepo.refresh).not.toHaveBeenCalled();
    expect(core.acpAgentServers.refresh).not.toHaveBeenCalled();
    expect(core.acpConversationRepo.createPendingConversation).not.toHaveBeenCalled();
    expect(core.acpRepo.createSession).not.toHaveBeenCalled();
    expect(runtime.addingProject).toBe(false);
  });

  it("opens ACP agent server settings in the host", () => {
    const hostSender = vi.fn().mockResolvedValue(undefined);
    initializeACPHostRpc(hostSender);
    const runtime = new ChatOnlyRuntime(createCore(), undefined);

    runtime.handleShowAgentSettings();

    expect(hostSender).toHaveBeenCalledWith("openSettings", ["camber.agentServers"]);
  });
});

function createCore({ defaultAgentServer = "codex" }: { defaultAgentServer?: string } = {}) {
  let nextConversation = 1;
  const core = {
    target: "chat-only",
    activeConversationId: null as string | null,
    acpAgentServers: {
      state: { status: "success" },
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    acpConversationRepo: {
      refresh: vi.fn().mockResolvedValue(undefined),
      createPendingConversation: vi.fn().mockResolvedValue({
        id: "pending-1",
        agentServer: defaultAgentServer || "poolside",
      }),
    },
    acpProjectRepo: {
      projects: [],
    },
    acpRepo: {
      emitter: new EventTarget(),
      agents: {
        defaultAgentServer,
        isConfigCacheLoadingFor: vi.fn().mockReturnValue(false),
        authRequiredForAgent: vi.fn().mockReturnValue(false),
        nonSessionErrorFor: vi.fn().mockReturnValue(null),
      },
      getSessionByConversationId: vi.fn().mockReturnValue(null),
      createSession: vi.fn(
        (cwd: string, agentServer: string, pendingConversationId: string | null) => {
          const conversationId = `conversation-${nextConversation++}`;
          core.activeConversationId = conversationId;
          return { conversationId, cwd, agentServer, pendingConversationId };
        },
      ),
    },
  };

  return core as unknown as Runtime & typeof core;
}
