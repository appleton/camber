import { appState, initializeACPHostRpc, type ACPNavProject } from "@camber/features/acp";
import { initializeStatefulModule as initializeHelperApi } from "@camber/helperapi";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopRuntime } from "./DesktopRuntime.svelte";
import type { Runtime } from "./shared/types";

describe("DesktopRuntime", () => {
  beforeEach(() => {
    window.localStorage.clear();
    const initial = get(appState);
    appState.set({
      ...initial,
      defaultCwd: "/fallback",
      workspaces: [],
      environment: {
        ...initial.environment,
        assistantHost: "desktop",
      },
    });
    initializeACPHostRpc(vi.fn().mockResolvedValue(undefined));
    initializeHelperApi({
      jsonrpcCall: vi.fn().mockResolvedValue({ path: "/state/camber/chat" }),
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("opens a draft conversation and surfaces it in the sidebar immediately", async () => {
    const core = createCore({ projects: [project("/repo")] });
    const runtime = new DesktopRuntime(core);

    await runtime.handleNewConversation("/repo/packages/app");

    expect(core.acpAgentServers.refresh).not.toHaveBeenCalled();
    expect(core.acpConversationRepo.createPendingConversation).not.toHaveBeenCalled();
    expect(core.acpRepo.createSession).toHaveBeenCalledWith("/repo/packages/app", "codex", null);
    // Persisted on create (not on first keystroke), so the draft shows right away.
    expect(
      core.acpRepo.getSessionByConversationId("conversation-1")!.persistPendingConversation,
    ).toHaveBeenCalled();
    // Ready to type: the prompt editor is asked to grab focus.
    expect(
      core.acpRepo.getSessionByConversationId("conversation-1")!.requestPromptFocus,
    ).toHaveBeenCalled();
    expect(core.activeConversationId).toBe("conversation-1");
  });

  it("reuses the open empty draft when requesting a new conversation in the same cwd", async () => {
    const core = createCore({ projects: [project("/repo")] });
    const runtime = new DesktopRuntime(core);

    const firstId = await runtime.handleNewConversation("/repo");
    expect(core.acpRepo.createSession).toHaveBeenCalledTimes(1);

    const secondId = await runtime.handleNewConversation("/repo");

    expect(secondId).toBe(firstId);
    expect(core.acpRepo.createSession).toHaveBeenCalledTimes(1);
    expect(
      core.acpRepo.getSessionByConversationId(firstId!)!.requestPromptFocus,
    ).toHaveBeenCalledTimes(2);
  });

  it("creates a new session when explicitly requesting new conversation in a different cwd", async () => {
    const core = createCore({ projects: [project("/repo")] });
    const runtime = new DesktopRuntime(core);

    await runtime.handleNewConversation("/repo/packages/app");
    expect(core.acpRepo.createSession).toHaveBeenCalledWith("/repo/packages/app", "codex", null);
    expect(core.activeConversationId).toBe("conversation-1");

    await runtime.handleNewConversation("/other/cwd");
    expect(core.acpRepo.createSession).toHaveBeenCalledWith("/other/cwd", "codex", null);
    expect(core.acpRepo.createSession).toHaveBeenCalledTimes(2);
  });

  it("creates a standalone chat in helper-managed state storage", async () => {
    const jsonrpcCall = vi.fn().mockResolvedValue({ path: "/state/camber/chat-1" });
    initializeHelperApi({
      jsonrpcCall,
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const core = createCore({ projects: [project("/repo")] });
    const runtime = new DesktopRuntime(core);

    const conversationId = await runtime.handleNewChat();

    expect(conversationId).toMatch(/^conversation:/);
    expect(jsonrpcCall).toHaveBeenCalledWith("camber/acpNav/createChat", {
      sessionId: conversationId,
    });
    expect(core.acpRepo.createSession).toHaveBeenCalledWith(
      "/state/camber/chat-1",
      "codex",
      conversationId,
      { isChat: true },
    );
    expect(
      core.acpRepo.getSessionByConversationId(conversationId)!.persistPendingConversation,
    ).toHaveBeenCalled();
    expect(core.activeConversationId).toBe(conversationId);
  });

  it("opens another draft immediately while the current agent session is loading", async () => {
    const core = createCore({ projects: [project("/repo")] });
    const old = core.acpRepo.createSession("/repo/old", "codex", "old");
    old.loadState = { status: "loading" };
    core.activeConversationId = old.conversationId;
    // Even an indefinitely delayed refresh must not gate a known configured agent.
    core.acpAgentServers.refresh.mockImplementation(() => new Promise(() => {}));
    const runtime = new DesktopRuntime(core);
    const result = await runtime.handleNewConversation("/repo/new");
    expect(result).not.toBe(old.conversationId);
    expect(core.activeConversationId).toBe(result);
    expect(core.acpAgentServers.refresh).not.toHaveBeenCalled();
    old.loadState = {
      status: "success",
      value: {
        sessionId: "old",
        agentServer: "codex",
        sessionInfo: null,
        events: [],
        plan: null,
        configOptions: [],
        availableCommands: [],
        modes: null,
      },
    };
    expect(core.activeConversationId).toBe(result);
  });

  it.each(["conversation", "settings"] as const)(
    "preserves a later %s selection when a new chat directory arrives",
    async (destination) => {
      const directory = deferred<{ path: string }>();
      initializeHelperApi({
        jsonrpcCall: vi.fn().mockReturnValue(directory.promise),
        jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
      });
      const core = createCore({ projects: [project("/repo")] });
      const onNavigationChange = vi.fn();
      const runtime = new DesktopRuntime(core, { onNavigationChange });
      core.activeConversationId = "original";
      const pending = runtime.handleNewChat();

      if (destination === "conversation") runtime.openConversation("selected-later");
      else runtime.showSettings();
      onNavigationChange.mockClear();
      directory.resolve({ path: "/state/camber/stale-chat" });

      expect(await pending).toBeNull();
      expect(runtime.view).toBe(destination === "settings" ? "settings" : "chat");
      expect(core.activeConversationId).toBe(
        destination === "conversation" ? "selected-later" : "original",
      );
      expect(core.acpRepo.createSession).not.toHaveBeenCalled();
      expect(core.acpAgentServers.refresh).not.toHaveBeenCalled();
      expect(onNavigationChange).not.toHaveBeenCalled();
    },
  );

  it.each(["conversation", "settings"] as const)(
    "preserves a later %s selection when agent discovery finishes",
    async (destination) => {
      const discovery = deferred<void>();
      const core = createCore({ projects: [project("/repo")] });
      core.acpAgentServers.state = { status: "loading" };
      core.acpAgentServers.refresh.mockReturnValue(discovery.promise);
      const onNavigationChange = vi.fn();
      const runtime = new DesktopRuntime(core, { onNavigationChange });
      core.activeConversationId = "original";
      const pending = runtime.handleNewConversation("/repo/new");

      if (destination === "conversation") runtime.openConversation("selected-later");
      else runtime.showSettings();
      onNavigationChange.mockClear();
      core.acpAgentServers.state = { status: "success", value: {} };
      discovery.resolve();

      expect(await pending).toBeNull();
      expect(runtime.view).toBe(destination === "settings" ? "settings" : "chat");
      expect(core.activeConversationId).toBe(
        destination === "conversation" ? "selected-later" : "original",
      );
      expect(core.acpRepo.createSession).not.toHaveBeenCalled();
      expect(onNavigationChange).not.toHaveBeenCalled();
    },
  );

  it("preserves a different project's settings while a chat directory is pending", async () => {
    const directory = deferred<{ path: string }>();
    initializeHelperApi({
      jsonrpcCall: vi.fn().mockReturnValue(directory.promise),
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const core = createCore({ projects: [project("/repo")] });
    const runtime = new DesktopRuntime(core);
    runtime.showProjectSettings("/repo");
    const pending = runtime.handleNewChat();
    runtime.showProjectSettings("/other");
    directory.resolve({ path: "/state/camber/stale-chat" });

    expect(await pending).toBeNull();
    expect(runtime.view).toBe("project-settings");
    expect(runtime.projectSettingsPath).toBe("/other");
    expect(core.acpRepo.createSession).not.toHaveBeenCalled();
  });

  it.each(["older first", "newer first"] as const)(
    "honors the newest chat request when directories finish %s",
    async (order) => {
      const older = deferred<{ path: string }>();
      const newer = deferred<{ path: string }>();
      initializeHelperApi({
        jsonrpcCall: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise),
        jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
      });
      const core = createCore({ projects: [project("/repo")] });
      const runtime = new DesktopRuntime(core);
      const first = runtime.handleNewChat();
      const second = runtime.handleNewChat();

      if (order === "older first") {
        older.resolve({ path: "/state/camber/older" });
        expect(await first).toBeNull();
        expect(core.acpRepo.createSession).not.toHaveBeenCalled();
      }
      newer.resolve({ path: "/state/camber/newer" });
      const selected = await second;
      if (order === "newer first") {
        older.resolve({ path: "/state/camber/older" });
        expect(await first).toBeNull();
      }

      expect(selected).not.toBeNull();
      expect(core.activeConversationId).toBe(selected);
      expect(core.acpRepo.createSession).toHaveBeenCalledTimes(1);
      expect(core.acpRepo.getSessionByConversationId(selected)!.cwd).toBe("/state/camber/newer");
    },
  );

  it.each(["older first", "newer first"] as const)(
    "honors the newest conversation request when discovery finishes %s",
    async (order) => {
      const older = deferred<void>();
      const newer = deferred<void>();
      const core = createCore({ projects: [project("/repo")] });
      core.acpAgentServers.state = { status: "loading" };
      core.acpAgentServers.refresh
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise);
      const runtime = new DesktopRuntime(core);
      const first = runtime.handleNewConversation("/repo/older");
      const second = runtime.handleNewConversation("/repo/newer");

      if (order === "older first") {
        older.resolve();
        expect(await first).toBeNull();
        expect(core.acpRepo.createSession).not.toHaveBeenCalled();
      }
      core.acpAgentServers.state = { status: "success", value: {} };
      newer.resolve();
      const selected = await second;
      if (order === "newer first") {
        older.resolve();
        expect(await first).toBeNull();
      }

      expect(selected).not.toBeNull();
      expect(core.activeConversationId).toBe(selected);
      expect(core.acpRepo.createSession).toHaveBeenCalledTimes(1);
      expect(core.acpRepo.getSessionByConversationId(selected)!.cwd).toBe("/repo/newer");
    },
  );

  it("still opens an explicitly requested chat from Settings after both prerequisites finish", async () => {
    const directory = deferred<{ path: string }>();
    const discovery = deferred<void>();
    initializeHelperApi({
      jsonrpcCall: vi.fn().mockReturnValue(directory.promise),
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const core = createCore({ projects: [project("/repo")] });
    core.acpAgentServers.state = { status: "loading" };
    core.acpAgentServers.refresh.mockReturnValue(discovery.promise);
    const runtime = new DesktopRuntime(core);
    runtime.showSettings();
    const pending = runtime.handleNewChat();
    directory.resolve({ path: "/state/camber/requested" });
    await vi.waitFor(() => expect(core.acpAgentServers.refresh).toHaveBeenCalledTimes(1));
    core.acpAgentServers.state = { status: "success", value: {} };
    discovery.resolve();

    const selected = await pending;
    expect(selected).not.toBeNull();
    expect(runtime.view).toBe("chat");
    expect(core.activeConversationId).toBe(selected);
    const session = core.acpRepo.getSessionByConversationId(selected)!;
    expect(session.cwd).toBe("/state/camber/requested");
    expect(session.persistPendingConversation).toHaveBeenCalledTimes(1);
    expect(session.requestPromptFocus).toHaveBeenCalledTimes(1);
  });

  it("ignores new conversation requests while conversations are loading", async () => {
    const core = createCore({
      conversationRefreshState: { status: "loading" },
    });
    const runtime = new DesktopRuntime(core);

    await runtime.handleNewConversation("/repo");

    expect(core.acpAgentServers.refresh).not.toHaveBeenCalled();
    expect(core.acpConversationRepo.createPendingConversation).not.toHaveBeenCalled();
    expect(core.acpRepo.createSession).not.toHaveBeenCalled();
    expect(core.activeConversationId).toBeNull();
  });

  it("seeds a replacement empty session when deselecting the active chat outside desktop project gating", () => {
    const initial = get(appState);
    appState.set({
      ...initial,
      defaultCwd: "/fallback",
      workspaces: [{ path: "/workspace", name: "workspace", index: 0 }],
      environment: {
        ...initial.environment,
        assistantHost: "visualstudio",
      },
    });
    const core = createCore({ projects: [project("/repo")] });
    core.activeConversationId = "conversation-existing";
    const runtime = new DesktopRuntime(core);

    runtime.handleActiveConversationIdChange(null);

    expect(core.acpRepo.createSession).toHaveBeenCalledWith("/workspace", "codex", null);
    expect(core.activeConversationId).toBe("conversation-1");
  });

  it("selects an existing conversation id without creating another session", () => {
    const core = createCore();
    const runtime = new DesktopRuntime(core);

    runtime.handleActiveConversationIdChange("conversation-existing");

    expect(core.activeConversationId).toBe("conversation-existing");
    expect(core.acpRepo.createSession).not.toHaveBeenCalled();
  });

  it("opens a conversation from the host, leaving any settings view for the chat", () => {
    const core = createCore();
    const runtime = new DesktopRuntime(core);
    runtime.showSettings();

    runtime.openConversation("conversation-notified");

    expect(runtime.view).toBe("chat");
    expect(core.activeConversationId).toBe("conversation-notified");
    expect(core.acpRepo.createSession).not.toHaveBeenCalled();
  });

  it("scopes right sidebar and bottom panel visibility per conversation while left sidebar stays global", () => {
    const core = createCore();
    const runtime = new DesktopRuntime(core);

    core.activeConversationId = "conversation-a";
    runtime.setSidebarCollapsed(true);
    runtime.setDesktopRightSidebarVisible(true);
    runtime.setDesktopBottomPanelVisible(true);

    core.activeConversationId = "conversation-b";

    expect(runtime.sidebarCollapsed).toBe(true);
    expect(runtime.desktopRightSidebarVisible).toBe(false);
    expect(runtime.desktopBottomPanelVisible).toBe(false);

    runtime.setDesktopBottomPanelVisible(true);

    core.activeConversationId = "conversation-a";

    expect(runtime.sidebarCollapsed).toBe(true);
    expect(runtime.desktopRightSidebarVisible).toBe(true);
    expect(runtime.desktopBottomPanelVisible).toBe(true);

    const restoredRuntime = new DesktopRuntime(core);
    expect(restoredRuntime.desktopRightSidebarVisible).toBe(true);
    expect(restoredRuntime.desktopBottomPanelVisible).toBe(true);

    core.activeConversationId = "conversation-b";

    expect(restoredRuntime.desktopRightSidebarVisible).toBe(false);
    expect(restoredRuntime.desktopBottomPanelVisible).toBe(true);
  });

  it("adds a selected desktop project and opens a draft conversation", async () => {
    const hostSender = vi.fn().mockImplementation((method: string) => {
      if (method === "selectProjectFolder") {
        return Promise.resolve({ path: "/new-project", name: "New project" });
      }
      return Promise.resolve(undefined);
    });
    initializeACPHostRpc(hostSender);
    const core = createCore();
    const runtime = new DesktopRuntime(core);
    runtime.showSettings();

    await runtime.handleAddProject();

    expect(hostSender).toHaveBeenCalledWith("selectProjectFolder", []);
    expect(core.acpProjectRepo.upsertProject).toHaveBeenCalledWith({
      path: "/new-project",
      name: "New project",
    });
    expect(core.acpConversationRepo.refresh).toHaveBeenCalledTimes(1);
    expect(core.acpAgentServers.refresh).not.toHaveBeenCalled();
    expect(core.acpConversationRepo.createPendingConversation).not.toHaveBeenCalled();
    expect(core.acpRepo.createSession).toHaveBeenCalledWith("/new-project", "codex", null);
    expect(
      core.acpRepo.getSessionByConversationId("conversation-1")!.persistPendingConversation,
    ).toHaveBeenCalled();
    // Adding a project lands in a ready-to-type conversation: prompt focus requested.
    expect(
      core.acpRepo.getSessionByConversationId("conversation-1")!.requestPromptFocus,
    ).toHaveBeenCalled();
    expect(core.activeConversationId).toBe("conversation-1");
    expect(runtime.view).toBe("chat");
    expect(runtime.addingProject).toBe(false);
  });

  it("does not mutate repos when project selection is cancelled", async () => {
    const hostSender = vi.fn().mockResolvedValue(null);
    initializeACPHostRpc(hostSender);
    const core = createCore();
    const runtime = new DesktopRuntime(core);

    await runtime.handleAddProject();

    expect(hostSender).toHaveBeenCalledWith("selectProjectFolder", []);
    expect(core.acpProjectRepo.upsertProject).not.toHaveBeenCalled();
    expect(core.acpConversationRepo.refresh).not.toHaveBeenCalled();
    expect(core.acpAgentServers.refresh).not.toHaveBeenCalled();
    expect(core.acpConversationRepo.createPendingConversation).not.toHaveBeenCalled();
    expect(core.acpRepo.createSession).not.toHaveBeenCalled();
    expect(runtime.addingProject).toBe(false);
  });

  it("settles the initial screen only after navigation and the new session terminate", () => {
    const core = createCore({
      projects: [project("/repo")],
      projectRefreshState: { status: "loading" },
    });
    const runtime = new DesktopRuntime(core);

    expect(runtime.initialScreenSettled).toBe(false);

    core.acpProjectRepo.refreshState = { status: "success", value: core.acpProjectRepo.projects };
    expect(runtime.initialScreenSettled).toBe(false);

    const session = core.acpRepo.createSession("/repo", "codex", null);
    core.activeConversationId = session.conversationId;
    session.loadState = { status: "loading" };
    expect(runtime.initialScreenSettled).toBe(false);

    session.loadState = { status: "failure", error: new Error("load failed") };
    expect(runtime.initialScreenSettled).toBe(true);
  });

  it("tracks agent readiness separately from a locally available conversation", () => {
    const core = createCore({ projects: [project("/repo")] });
    const runtime = new DesktopRuntime(core);
    core.activeConversationId = core.acpRepo.createSession("/repo", "codex", null).conversationId;
    core.acpRepo.agents.isConfigCacheLoadingFor.mockReturnValue(true);
    expect(runtime.initialScreenSettled).toBe(true);
    expect(runtime.initialAgentReady).toBe(false);
    core.acpRepo.agents.isConfigCacheLoadingFor.mockReturnValue(false);
    expect(runtime.initialAgentReady).toBe(true);
    core.acpRepo.agents.authRequiredForAgent.mockReturnValue(true);
    expect(runtime.initialAgentReady).toBe(false);
  });

  it("treats an initial navigation failure as settled", () => {
    const core = createCore({
      projectRefreshState: { status: "failure" },
    });

    expect(new DesktopRuntime(core).initialScreenSettled).toBe(true);
  });

  it("reports the initial-screen gate inputs in the diagnostics snapshot", () => {
    const core = createCore({ projects: [project("/repo")] });
    // A selected conversation with no loaded session is the stuck state the
    // snapshot exists to expose: not settled, and nothing left to load it.
    core.activeConversationId = "conversation-missing";
    const runtime = new DesktopRuntime(core);

    expect(runtime.startupDiagnosticsSnapshot()).toMatchObject({
      initialScreenSettled: false,
      view: "chat",
      projectStatus: "success",
      conversationStatus: "success",
      agentServersStatus: "success",
      projectCount: 1,
      conversationCount: 0,
      isDesktop: true,
      activeConversationId: "conversation-missing",
      hasActiveSession: false,
      activeSessionLoadState: null,
      agentServer: "codex",
      defaultAgentServer: "codex",
      authRequired: false,
      configCacheLoading: false,
      sessionError: null,
    });

    const session = core.acpRepo.createSession("/repo", "codex", null);
    core.activeConversationId = session.conversationId;

    expect(runtime.startupDiagnosticsSnapshot()).toMatchObject({
      initialScreenSettled: true,
      hasActiveSession: true,
      activeSessionLoadState: "idle",
    });
  });
});

type Session = {
  conversationId: string;
  sessionId: string | null;
  agentServer: string;
  cwd: string;
  pendingCwd?: string;
  pendingConversationId?: string | null;
  persistPendingConversation: ReturnType<typeof vi.fn>;
  requestPromptFocus: ReturnType<typeof vi.fn>;
  loadState: { status: "idle" | "loading" | "success" | "failure"; error?: unknown };
  events: unknown[];
  isSending: boolean;
};

function createCore({
  projects = [],
  conversationRefreshState = { status: "success" },
  projectRefreshState = { status: "success" },
}: {
  projects?: ACPNavProject[];
  conversationRefreshState?: { status: "loading" | "success" | "failure" };
  projectRefreshState?: { status: "loading" | "success" | "failure" };
} = {}) {
  const sessions = new Map<string, Session>();
  let nextConversation = 1;
  let currentConversationId = $state<string | null>(null);

  const core = {
    target: "desktop",
    get activeConversationId() {
      return currentConversationId;
    },
    set activeConversationId(value: string | null) {
      currentConversationId = value;
    },
    acpAgentServers: {
      state: { status: "success" },
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    acpConversationRepo: {
      emitter: new EventTarget(),
      refreshState: conversationRefreshState,
      sessions: [],
      refresh: vi.fn().mockResolvedValue(undefined),
      createPendingConversation: vi.fn().mockResolvedValue({
        id: "pending-1",
        agentServer: "codex",
      }),
    },
    acpProjectRepo: {
      projects,
      refreshState: projectRefreshState,
      upsertProject: vi.fn().mockResolvedValue(undefined),
    },
    acpRepo: {
      emitter: new EventTarget(),
      agents: {
        defaultAgentServer: "codex",
        isConfigCacheLoadingFor: vi.fn().mockReturnValue(false),
        authRequiredForAgent: vi.fn().mockReturnValue(false),
        authInProgressForAgent: vi.fn().mockReturnValue(false),
        nonSessionErrorFor: vi.fn().mockReturnValue(null),
      },
      getSessionByConversationId: vi.fn((conversationId: string | null) =>
        conversationId ? (sessions.get(conversationId) ?? null) : null,
      ),
      createSession: vi.fn(
        (
          cwd: string,
          agentServer: string,
          pendingConversationId: string | null,
          _options?: { isChat?: boolean },
        ) => {
          const conversationId = pendingConversationId ?? `conversation-${nextConversation++}`;
          const session: Session = {
            conversationId,
            sessionId: null,
            agentServer,
            cwd,
            pendingCwd: cwd,
            pendingConversationId,
            persistPendingConversation: vi.fn(),
            requestPromptFocus: vi.fn(),
            loadState: { status: "idle" },
            events: [],
            isSending: false,
          };
          sessions.set(conversationId, session);
          return session;
        },
      ),
    },
  };

  return core as unknown as Runtime & typeof core;
}

function project(path: string): ACPNavProject {
  return {
    path,
    name: path.split("/").filter(Boolean).at(-1) ?? path,
    isWorktree: false,
    collapsed: false,
    displayOrder: 0,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
