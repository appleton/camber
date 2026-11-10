import type {
  ClientSideConnection,
  InitializeResponse,
  PromptResponse,
  RequestPermissionRequest,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { initializeStatefulModule as initializeHelperApi } from "@camber/helperapi";
import { isLoading, isSuccess } from "@camber/lib/async-state";
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElicitationRepository } from "../../elicitation/ElicitationRepository.svelte";
import { DEFAULT_AGENT_SERVER } from "../agentServers";
import type { ACPConnectionPool } from "../ConnectionPool";
import { ACP_DEBUG_DUMP_LOADED_EVENT, type ACPDebugDumpLoadedEventDetail } from "../debugDump";
import { ACPError } from "../errors";
import { appState } from "../hostAdapter";
import { ACP_PERMISSION_OVERRIDE_RULES_META_KEY } from "../permissionMeta";
import { buildSessionInfo } from "../sessionInfo";
import { ACPConversationStatusRepositoryWriter } from "./ConversationStatusRepository.svelte";
import {
  ACP_PENDING_CONVERSATION_AGENT_EVENT,
  ACP_SESSION_NEW_EVENT,
  ACP_SESSION_TURN_COMPLETED_EVENT,
} from "./Session.svelte";
import { HANDOFF_CONTEXT_RESOURCE_URI_PREFIX } from "./session/handoffContext";
import { HOST_CONTEXT_RESOURCE_URI, hostContextBlock } from "./session/hostContext";
import { ACPSessionRepositoryWriter as BaseACPSessionRepositoryWriter } from "./SessionRepository.svelte";
import SessionRepositoryRouteHarness from "./SessionRepositoryRoute.test.svelte";

let helperJsonrpcCall: ReturnType<typeof vi.fn>;
const createdRepos: BaseACPSessionRepositoryWriter[] = [];

// Every repository created in this file is tracked automatically so tests that
// claim a conversation cannot leak the real idle-sweep interval.
class ACPSessionRepositoryWriter extends BaseACPSessionRepositoryWriter {
  constructor(...args: ConstructorParameters<typeof BaseACPSessionRepositoryWriter>) {
    super(...args);
    createdRepos.push(this);
  }
}

beforeEach(() => {
  helperJsonrpcCall = vi.fn().mockResolvedValue({ entry: null });
  initializeHelperApi({
    jsonrpcCall: helperJsonrpcCall,
    jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  // Repositories whose tests claimed a conversation started the real
  // idle-sweep interval; dispose so it cannot leak across the test run.
  for (const repo of createdRepos.splice(0)) {
    repo.dispose();
  }
});

function mockConnection(overrides: Partial<ClientSideConnection> = {}): ClientSideConnection {
  return {
    initialize: vi.fn().mockResolvedValue({}),
    newSession: vi.fn().mockResolvedValue({ sessionId: "s-new" }),
    loadSession: vi.fn().mockResolvedValue({}),
    resumeSession: vi.fn().mockResolvedValue({}),
    prompt: vi.fn().mockResolvedValue({}),
    request: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue({}),
    setSessionMode: vi.fn().mockResolvedValue({}),
    setSessionConfigOption: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as ClientSideConnection;
}

async function connectRepo(
  repo: ACPSessionRepositoryWriter,
  conn: ClientSideConnection = mockConnection(),
  initializeResponse: InitializeResponse = {
    protocolVersion: 1,
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {} },
    },
  } as InitializeResponse,
  agentServer = DEFAULT_AGENT_SERVER,
): Promise<ClientSideConnection> {
  repo.agents.setConnectionPool({
    connect: vi.fn().mockResolvedValue({ conn, initializeResponse, transport: {} }),
  } as unknown as ACPConnectionPool);
  const result = await repo.agents.activate(agentServer);
  expect(result).toBe(conn);
  return conn;
}

function sessionNotification(text: string, sessionId = "s-loaded"): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  } as SessionNotification;
}

function textBlock(text: string) {
  return { type: "text" as const, text };
}

function toolNotification(sessionId = "s-loaded"): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Edit",
      kind: "edit",
      rawInput: { path: "/repo/src/app.ts" },
    },
  } as SessionNotification;
}

async function loadNamedSession(repo: ACPSessionRepositoryWriter, conversationId: string) {
  const session = await repo.loadSessionRecord(
    `session-${conversationId}`,
    "/repo",
    [],
    { conversationId },
    DEFAULT_AGENT_SERVER,
  );
  expect(session).not.toBeNull();
  return session!;
}

function permissionRequest(
  overrides: Partial<RequestPermissionRequest> = {},
): RequestPermissionRequest {
  return {
    sessionId: "s-loaded",
    toolCall: {
      toolCallId: "tool-1",
      title: "Run test command",
      kind: "execute",
      rawInput: { cmd: "touch test.txt" },
    },
    options: [
      { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
      { optionId: "reject-once", kind: "reject_once", name: "Deny" },
    ],
    ...overrides,
  };
}

describe("ACPSessionRepositoryWriter", () => {
  it("routes compaction updates by session id rather than compaction id", () => {
    const repo = new ACPSessionRepositoryWriter();
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-compaction");
    session.sessionId = "session-1";

    repo.handleCompactionUpdate(DEFAULT_AGENT_SERVER, {
      sessionId: "session-1",
      id: "compaction-1",
      phase: "started",
    });
    expect(session.compacting).toBe(true);

    repo.handleCompactionUpdate(DEFAULT_AGENT_SERVER, {
      sessionId: "session-1",
      id: "compaction-1",
      phase: "completed",
    });
    expect(session.compacting).toBe(false);
  });

  it("routes legacy compaction updates to the only prompting session", () => {
    const repo = new ACPSessionRepositoryWriter();
    const prompting = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-prompting");
    prompting.sessionId = "session-prompting";
    prompting.isPrompting = true;
    const idle = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-idle");
    idle.sessionId = "session-idle";

    repo.handleCompactionUpdate(DEFAULT_AGENT_SERVER, {
      id: "compaction-legacy",
      phase: "started",
    });

    expect(prompting.compacting).toBe(true);
    expect(idle.compacting).toBe(false);
  });

  it("clears compaction for a remote-origin turn when the helper ends it", () => {
    const repo = new ACPSessionRepositoryWriter();
    const remote = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-remote");
    remote.sessionId = "session-remote";

    repo.handleCompactionUpdate(DEFAULT_AGENT_SERVER, {
      sessionId: "session-remote",
      id: "compaction-remote",
      phase: "started",
    });
    expect(remote.isPromptActive).toBe(false);
    expect(remote.compacting).toBe(true);

    repo.handleTurnEnded(DEFAULT_AGENT_SERVER, { sessionId: "session-remote" });

    expect(remote.compacting).toBe(false);
  });

  it("stages an idle conversation and sends its handoff with the next user prompt", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    repo.agents.agentServerNames = [DEFAULT_AGENT_SERVER, "codex-acp"];
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
      },
    } as InitializeResponse);
    const source = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-handoff");
    const pendingAgentChange = vi.fn();
    repo.emitter.addEventListener(ACP_PENDING_CONVERSATION_AGENT_EVENT, pendingAgentChange);
    source.sessionId = "source-session";
    source.sessionInfo = {
      ...buildSessionInfo("source-session", "/repo", "native_session"),
      title: "Finish the migration",
    };
    source.seedHandoffHistory(
      [
        {
          eventKind: "user_message",
          messageId: null,
          content: [{ type: "text", text: "Earlier agent context" }],
        },
      ],
      [],
      null,
      {
        eventKind: "handoff",
        sourceAgentServer: "earlier-acp",
        sourceSessionId: "earlier-session",
        targetAgentServer: DEFAULT_AGENT_SERVER,
        createdAt: "2026-07-16T09:00:00.000Z",
      },
    );
    source.addUserMessage("Please finish the migration and run the focused tests.");
    source.applySessionUpdate(sessionNotification("I updated the schema.", "source-session"));

    const pendingBootstrap = vi.fn(() => {
      repo.createSession("/repo", "codex-acp", "conv-handoff", {
        isPendingConversationPersisted: true,
      });
    });
    render(SessionRepositoryRouteHarness, {
      props: {
        repo: repo.publicAPI(),
        conversationId: "conv-handoff",
        onIdleSession: pendingBootstrap,
      },
    });
    expect(screen.getByTestId("routed-agent")).toHaveTextContent(DEFAULT_AGENT_SERVER);
    expect(screen.getByTestId("scoped-agent")).toHaveTextContent(DEFAULT_AGENT_SERVER);

    const target = await repo.handoffSession("conv-handoff", "codex-acp");
    await tick();

    expect(target).toBe(repo.getSessionByConversationId("conv-handoff"));
    expect(target).not.toBe(source);
    expect(target.agentServer).toBe("codex-acp");
    expect(screen.getByTestId("routed-agent")).toHaveTextContent("codex-acp");
    expect(screen.getByTestId("scoped-agent")).toHaveTextContent("codex-acp");
    expect(target.sessionId).toBeNull();
    expect(target.pendingHandoff).toEqual(
      expect.objectContaining({
        sourceAgentServer: DEFAULT_AGENT_SERVER,
        sourceSessionId: "source-session",
        targetAgentServer: "codex-acp",
      }),
    );
    expect(pendingBootstrap).not.toHaveBeenCalled();
    expect(target.sessionInfo).toBeNull();
    expect(target.isPendingConversationPersisted).toBe(true);
    target.persistPendingConversation();
    target.dispatchPendingConversationAgentChange();
    expect(pendingAgentChange).not.toHaveBeenCalled();
    expect(target.events.map((event) => event.eventKind)).toEqual([
      "user_message",
      "handoff",
      "user_message",
      "agent_message",
      "handoff",
    ]);
    expect(conn.newSession).not.toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: expect.objectContaining({ "camber/conversation_id": "conv-handoff" }),
      }),
    );
    expect(conn.prompt).not.toHaveBeenCalled();
    expect(helperJsonrpcCall).not.toHaveBeenCalledWith(
      expect.stringContaining("prepareConversationHandoff"),
      expect.anything(),
    );

    await target.serialize((gen) =>
      target.sendCore(
        gen,
        "Use the new schema and finish the migration.",
        undefined,
        undefined,
        "/repo",
        [textBlock("Use the new schema and finish the migration.")],
      ),
    );

    expect(target.sessionId).toBe("s-new");
    expect(target.pendingHandoff).toBeNull();
    expect(target.sessionInfo?.title).toBe("Finish the migration");
    expect(target.events.at(-1)).toEqual(
      expect.objectContaining({
        eventKind: "user_message",
        content: [{ type: "text", text: "Use the new schema and finish the migration." }],
      }),
    );
    expect(conn.newSession).toHaveBeenCalledWith({
      cwd: "/repo",
      mcpServers: [],
      _meta: {
        "camber/conversation_id": "conv-handoff",
        "camber/handoff": {
          sourceAgentServer: DEFAULT_AGENT_SERVER,
          sourceSessionId: "source-session",
        },
        "camber/handoff_id": expect.stringMatching(/^handoff:/),
        enabled_tools: [],
      },
    });
    expect(helperJsonrpcCall).toHaveBeenCalledWith(
      expect.stringContaining("prepareConversationHandoff"),
      expect.objectContaining({
        conversationId: "conv-handoff",
        sourceAgentServer: DEFAULT_AGENT_SERVER,
        sourceSessionId: "source-session",
        targetAgentServer: "codex-acp",
        events: [
          expect.objectContaining({ eventKind: "user_message" }),
          expect.objectContaining({ eventKind: "agent_message" }),
        ],
        turns: [],
        plan: null,
      }),
    );
    expect(conn.prompt).toHaveBeenCalledWith({
      sessionId: "s-new",
      prompt: [
        {
          type: "text",
          text: "Use the new schema and finish the migration.",
        },
        expect.objectContaining({
          type: "resource",
          resource: expect.objectContaining({
            uri: expect.stringMatching(new RegExp(`^${HANDOFF_CONTEXT_RESOURCE_URI_PREFIX}`)),
            text: expect.stringContaining("Please finish the migration"),
          }),
        }),
        expect.objectContaining({
          type: "resource",
          resource: expect.objectContaining({ uri: HOST_CONTEXT_RESOURCE_URI }),
        }),
      ],
    });

    repo.handleSessionUpdate("codex-acp", sessionNotification("target agent continued", "s-new"));
    expect(target.events.at(-1)).toEqual(
      expect.objectContaining({
        eventKind: "agent_message",
        content: [expect.objectContaining({ text: "target agent continued" })],
      }),
    );

    repo.handleSessionUpdate(
      DEFAULT_AGENT_SERVER,
      sessionNotification("late source update", "source-session"),
    );
    expect(target.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: [expect.objectContaining({ text: "late source update" })],
        }),
      ]),
    );
  });

  it("re-probes config for agents backing sessionless drafts, skipping auth-required agents", async () => {
    const repo = new ACPSessionRepositoryWriter();
    repo.agents.agentServerNames = [DEFAULT_AGENT_SERVER, "codex-acp", "claude-acp"];
    const refreshedEntry = {
      agentServer: DEFAULT_AGENT_SERVER,
      configOptions: [],
      availableCommands: [],
      modes: null,
      promptCapabilities: null,
      agentInfo: null,
      cachedAt: "2026-08-04T12:00:00.000Z",
    };
    const ensureConfigProbe = vi
      .spyOn(repo.agents, "ensureConfigProbe")
      .mockImplementation(async (agentServer = DEFAULT_AGENT_SERVER) => {
        // Each probe writes a fresh entry object, as upsertCachedConfig does.
        repo.agents.configCacheByAgentServer = {
          ...repo.agents.configCacheByAgentServer,
          [agentServer]: { ...refreshedEntry },
        };
      });
    vi.spyOn(repo.agents, "loadOrInitCachedConfig").mockResolvedValue(undefined);
    vi.spyOn(repo.agents, "authRequiredForAgent").mockImplementation(
      (agentServer) => agentServer === "codex-acp",
    );
    const applyCached = vi.spyOn(repo, "applyCachedConfigToLocalSessionsForAgent");

    repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-draft-a");
    repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-draft-b");
    repo.createSession("/repo", "codex-acp", "conv-needs-auth");
    const live = repo.createSession("/repo", "claude-acp", "conv-live");
    live.sessionId = "live-session";
    // Let createSession's own background probe chains settle, then count only
    // the focus-driven refresh.
    await Promise.resolve();
    await Promise.resolve();
    ensureConfigProbe.mockClear();
    applyCached.mockClear();

    repo.refreshStaleConfigForLocalSessions();

    // The refresh changed the cache, so drafts re-apply — preserving their
    // own selections.
    await vi.waitFor(() =>
      expect(applyCached).toHaveBeenCalledWith(DEFAULT_AGENT_SERVER, undefined, {
        preserveSelections: true,
      }),
    );
    // One probe for the two drafts sharing an agent; none for the
    // auth-required agent or the agent with only a live session. Quiet: a
    // background failure must not paint error banners.
    expect(ensureConfigProbe).toHaveBeenCalledTimes(1);
    expect(ensureConfigProbe).toHaveBeenCalledWith(DEFAULT_AGENT_SERVER, "/repo", { quiet: true });

    // A focus while the config is still fresh leaves drafts untouched.
    ensureConfigProbe.mockImplementation(async () => {});
    applyCached.mockClear();
    repo.refreshStaleConfigForLocalSessions();
    await Promise.resolve();
    await Promise.resolve();
    expect(applyCached).not.toHaveBeenCalled();
  });

  it("preserves a draft's own selections when re-applying refreshed config", async () => {
    const repo = new ACPSessionRepositoryWriter();
    vi.spyOn(repo.agents, "loadOrInitCachedConfig").mockResolvedValue(undefined);
    vi.spyOn(repo.agents, "ensureConfigProbe").mockResolvedValue(undefined);
    const modelOption = (currentValue: string, values: string[]) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: values.map((value) => ({ name: value, value })),
      currentValue,
    });
    repo.agents.configCacheByAgentServer = {
      [DEFAULT_AGENT_SERVER]: {
        agentServer: DEFAULT_AGENT_SERVER,
        configOptions: [modelOption("sonnet", ["sonnet", "opus"])],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-08-04T00:00:00.000Z",
      },
    };
    // The remembered last-used value differs from what they picked on the draft.
    repo.agents.defaultConfigOptionsByAgentServer = {
      [DEFAULT_AGENT_SERVER]: { model: "sonnet" },
    };
    const draft = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-draft");
    draft.configOptions = [modelOption("opus", ["sonnet", "opus"])];
    // The user picked opus here; only user-chosen options are preserved.
    draft.userSelectedConfigIds = new Set(["model"]);

    // A re-probe lands new definitions (a released model) with the agent's
    // default as currentValue.
    repo.agents.configCacheByAgentServer = {
      [DEFAULT_AGENT_SERVER]: {
        ...repo.agents.configCacheByAgentServer[DEFAULT_AGENT_SERVER],
        configOptions: [modelOption("sonnet", ["sonnet", "opus", "new-model"])],
      },
    };
    repo.applyCachedConfigToLocalSessionsForAgent(DEFAULT_AGENT_SERVER, undefined, {
      preserveSelections: true,
    });

    expect(draft.configOptions).toEqual([
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

    // Without preservation the remembered default clobbers the pick — the
    // behavior background refreshes must avoid.
    repo.applyCachedConfigToLocalSessionsForAgent(DEFAULT_AGENT_SERVER);
    expect(draft.configOptions).toEqual([
      expect.objectContaining({ id: "model", currentValue: "sonnet" }),
    ]);
  });

  it("lets an untouched draft follow a newly remembered default", async () => {
    const repo = new ACPSessionRepositoryWriter();
    vi.spyOn(repo.agents, "loadOrInitCachedConfig").mockResolvedValue(undefined);
    vi.spyOn(repo.agents, "ensureConfigProbe").mockResolvedValue(undefined);
    const modelOption = (currentValue: string) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: [
        { name: "sonnet", value: "sonnet" },
        { name: "opus", value: "opus" },
      ],
      currentValue,
    });
    repo.agents.configCacheByAgentServer = {
      [DEFAULT_AGENT_SERVER]: {
        agentServer: DEFAULT_AGENT_SERVER,
        configOptions: [modelOption("sonnet")],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-08-04T00:00:00.000Z",
      },
    };
    const draft = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-draft");
    expect(draft.configOptions).toEqual([
      expect.objectContaining({ id: "model", currentValue: "sonnet" }),
    ]);

    // Opus becomes the remembered default (e.g. picked in another draft)
    // without touching this draft's picker; a background re-apply must adopt
    // it rather than pin sonnet.
    repo.agents.defaultConfigOptionsByAgentServer = {
      [DEFAULT_AGENT_SERVER]: { model: "opus" },
    };
    repo.applyCachedConfigToLocalSessionsForAgent(DEFAULT_AGENT_SERVER, undefined, {
      preserveSelections: true,
    });

    expect(draft.configOptions).toEqual([
      expect.objectContaining({ id: "model", currentValue: "opus" }),
    ]);
  });

  it("skips the focus refresh for an agent with a turn in flight", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const ensureConfigProbe = vi
      .spyOn(repo.agents, "ensureConfigProbe")
      .mockResolvedValue(undefined);
    vi.spyOn(repo.agents, "loadOrInitCachedConfig").mockResolvedValue(undefined);

    repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-draft");
    const busy = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-busy");
    busy.sessionId = "busy-session";
    busy.isSending = true;
    await Promise.resolve();
    await Promise.resolve();
    ensureConfigProbe.mockClear();

    repo.refreshStaleConfigForLocalSessions();

    // A probe would run the helper's readiness preflight, which can restart
    // the shared agent process and kill the running turn.
    expect(ensureConfigProbe).not.toHaveBeenCalled();
  });

  it("keeps a staged handoff retryable when target session creation fails", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      newSession: vi.fn().mockRejectedValue(new Error("target unavailable")),
    });
    repo.agents.agentServerNames = [DEFAULT_AGENT_SERVER, "codex-acp"];
    await connectRepo(repo, conn);
    const source = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-handoff");
    source.sessionId = "source-session";
    source.sessionInfo = buildSessionInfo("source-session", "/repo", "native_session");
    source.addUserMessage("Keep this transcript.");
    source.materializer.startTurn("2026-07-16T10:00:00.000Z");
    source.materializer.completeOpenToolCalls("2026-07-16T10:00:01.000Z");

    const target = await repo.handoffSession("conv-handoff", "codex-acp");

    expect(conn.newSession).not.toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: expect.objectContaining({ "camber/conversation_id": "conv-handoff" }),
      }),
    );
    await target.serialize((gen) =>
      target.sendCore(gen, "Try the target agent now.", undefined, undefined, "/repo", [
        textBlock("Try the target agent now."),
      ]),
    );

    expect(repo.getSessionByConversationId("conv-handoff")).toBe(target);
    expect(target.sessionId).toBeNull();
    expect(target.pendingHandoff).not.toBeNull();
    expect(target.loadState).toEqual(
      expect.objectContaining({ status: "failure", error: expect.anything() }),
    );
    expect(source.agentServer).toBe(DEFAULT_AGENT_SERVER);
    expect(source.sessionId).toBe("source-session");
    expect(source.events).toEqual([
      expect.objectContaining({
        eventKind: "user_message",
        content: [{ type: "text", text: "Keep this transcript." }],
      }),
    ]);
    expect(source.handoffTargetAgentServer).toBeNull();
    expect(conn.prompt).not.toHaveBeenCalled();
    expect(helperJsonrpcCall).toHaveBeenCalledWith(
      expect.stringContaining("prepareConversationHandoff"),
      expect.objectContaining({
        handoffId: expect.stringMatching(/^handoff:/),
        turns: [],
      }),
    );
    expect(helperJsonrpcCall).toHaveBeenCalledWith(
      expect.stringContaining("abortConversationHandoff"),
      expect.objectContaining({ handoffId: expect.stringMatching(/^handoff:/) }),
    );

    const restored = await repo.handoffSession("conv-handoff", DEFAULT_AGENT_SERVER);
    expect(restored).toBe(source);
    expect(repo.getSessionByConversationId("conv-handoff")).toBe(source);
    expect(restored.sessionId).toBe("source-session");
    expect(restored.events).toEqual([
      expect.objectContaining({
        eventKind: "user_message",
        content: [{ type: "text", text: "Keep this transcript." }],
      }),
    ]);
  });

  it("redirects a staged handoff to another target without committing the first target", async () => {
    const repo = new ACPSessionRepositoryWriter();
    repo.agents.agentServerNames = [DEFAULT_AGENT_SERVER, "codex-acp", "claude-acp"];
    const source = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-handoff");
    source.sessionId = "source-session";
    source.sessionInfo = buildSessionInfo("source-session", "/repo", "native_session");
    source.addUserMessage("Keep this transcript.");

    const firstTarget = await repo.handoffSession("conv-handoff", "codex-acp");
    const secondTarget = await repo.handoffSession("conv-handoff", "claude-acp");

    expect(secondTarget).not.toBe(firstTarget);
    expect(secondTarget.agentServer).toBe("claude-acp");
    expect(secondTarget.pendingHandoff).toEqual(
      expect.objectContaining({
        sourceAgentServer: DEFAULT_AGENT_SERVER,
        sourceSessionId: "source-session",
        targetAgentServer: "claude-acp",
        sourceSession: source,
        prepareParams: expect.objectContaining({ targetAgentServer: "claude-acp" }),
      }),
    );
    expect(secondTarget.events).toEqual([
      expect.objectContaining({ eventKind: "user_message" }),
      expect.objectContaining({
        eventKind: "handoff",
        sourceAgentServer: DEFAULT_AGENT_SERVER,
        targetAgentServer: "claude-acp",
      }),
    ]);
    expect(helperJsonrpcCall).not.toHaveBeenCalledWith(
      expect.stringContaining("prepareConversationHandoff"),
      expect.anything(),
    );
  });

  it("generates a normal title when the handoff source is untitled", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    repo.agents.agentServerNames = [DEFAULT_AGENT_SERVER, "codex-acp"];
    await connectRepo(repo, conn);
    const source = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-handoff");
    source.sessionId = "source-session";
    source.sessionInfo = buildSessionInfo("source-session", "/repo", "native_session");

    const target = await repo.handoffSession("conv-handoff", "codex-acp");
    await target.serialize((gen) =>
      target.sendCore(gen, "Finish the migration", undefined, undefined, "/repo"),
    );

    expect(target.sessionInfo?.title).toBe("Finish the migration");
  });

  it("refuses to hand off while the source session is working", async () => {
    const repo = new ACPSessionRepositoryWriter();
    repo.agents.agentServerNames = [DEFAULT_AGENT_SERVER, "codex-acp"];
    const source = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-handoff");
    source.sessionId = "source-session";
    source.isPrompting = true;

    await expect(repo.handoffSession("conv-handoff", "codex-acp")).rejects.toThrow(
      "Wait for the current turn",
    );

    source.isPrompting = false;
    source.steeringRequestsInFlight = 1;
    await expect(repo.handoffSession("conv-handoff", "codex-acp")).rejects.toThrow(
      "Wait for the current turn",
    );
  });

  it("resumes sessions to refresh their MCP servers without replaying history", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      resumeSession: vi.fn().mockResolvedValue({
        configOptions: [],
        modes: null,
      }),
    });
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
      },
    } as InitializeResponse);
    const session = await loadNamedSession(repo, "active");
    vi.mocked(conn.loadSession).mockClear();

    await repo.refreshMCPServersForAllSessions();

    expect(conn.resumeSession).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      cwd: "/repo",
      mcpServers: [],
    });
    expect(conn.loadSession).not.toHaveBeenCalled();
  });

  it("restores the session model and mode when an MCP refresh resumes with agent defaults", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const selectedConfigOptions = [
      {
        id: "model",
        type: "select" as const,
        category: "model" as const,
        name: "Model",
        currentValue: "opus",
        options: [
          { value: "fable", name: "Fable" },
          { value: "opus", name: "Opus" },
        ],
      },
    ];
    const availableModes = [
      { id: "auto", name: "Auto" },
      { id: "manual", name: "Manual" },
    ];
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: selectedConfigOptions,
        modes: { currentModeId: "manual", availableModes },
      }),
      resumeSession: vi.fn().mockResolvedValue({
        configOptions: selectedConfigOptions.map((option) => ({
          ...option,
          currentValue: "fable",
        })),
        modes: { currentModeId: "auto", availableModes },
      }),
    });
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
      },
    } as InitializeResponse);
    const session = await loadNamedSession(repo, "active");
    vi.mocked(conn.loadSession).mockClear();

    await repo.refreshMCPServersForAllSessions();

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      configId: "model",
      value: "opus",
    });
    expect(conn.setSessionMode).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      modeId: "manual",
    });
    expect(session.configOptions).toEqual(selectedConfigOptions);
    expect(session.modes?.currentModeId).toBe("manual");
    expect(conn.loadSession).not.toHaveBeenCalled();
  });

  it("restores boolean config options when an MCP refresh resumes with agent defaults", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const thinkingOption = (currentValue: boolean) => ({
      id: "thinking",
      type: "boolean" as const,
      name: "Extended thinking",
      currentValue,
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({ configOptions: [thinkingOption(true)] }),
      resumeSession: vi.fn().mockResolvedValue({ configOptions: [thinkingOption(false)] }),
    });
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
      },
    } as InitializeResponse);
    const session = await loadNamedSession(repo, "active");
    vi.mocked(conn.loadSession).mockClear();

    await repo.refreshMCPServersForAllSessions();

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      configId: "thinking",
      value: true,
      type: "boolean",
    });
    expect(session.configOptions).toEqual([thinkingOption(true)]);
    expect(conn.loadSession).not.toHaveBeenCalled();
  });

  it("keeps the agent's default instead of re-applying a selection the agent no longer offers", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const modelOption = (currentValue: string, values: string[]) => ({
      id: "model",
      type: "select" as const,
      category: "model" as const,
      name: "Model",
      currentValue,
      options: values.map((value) => ({ value, name: value })),
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [modelOption("opus", ["fable", "opus"])],
      }),
      // The refreshed session dropped "opus" entirely.
      resumeSession: vi.fn().mockResolvedValue({
        configOptions: [modelOption("fable", ["fable"])],
      }),
    });
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
      },
    } as InitializeResponse);
    const session = await loadNamedSession(repo, "active");
    vi.mocked(conn.loadSession).mockClear();

    await repo.refreshMCPServersForAllSessions();

    expect(conn.setSessionConfigOption).not.toHaveBeenCalled();
    expect(session.configOptions).toEqual([modelOption("fable", ["fable"])]);
    expect(conn.loadSession).not.toHaveBeenCalled();
  });

  it("falls back to reloading the session when re-applying config after resume fails", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const modelOption = (currentValue: string) => ({
      id: "model",
      type: "select" as const,
      category: "model" as const,
      name: "Model",
      currentValue,
      options: [
        { value: "fable", name: "Fable" },
        { value: "opus", name: "Opus" },
      ],
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({ configOptions: [modelOption("opus")] }),
      resumeSession: vi.fn().mockResolvedValue({ configOptions: [modelOption("fable")] }),
      setSessionConfigOption: vi.fn().mockRejectedValue(new Error("model is busy")),
    });
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
      },
    } as InitializeResponse);
    const session = await loadNamedSession(repo, "active");
    vi.mocked(conn.loadSession).mockClear();

    await repo.refreshMCPServersForAllSessions();

    expect(conn.loadSession).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      cwd: "/repo",
      mcpServers: [],
    });
  });

  it("keeps a config change the user made while an MCP refresh resume was in flight", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const modelOption = (currentValue: string) => ({
      id: "model",
      type: "select" as const,
      category: "model" as const,
      name: "Model",
      currentValue,
      options: [
        { value: "fable", name: "Fable" },
        { value: "opus", name: "Opus" },
      ],
    });
    let resolveResume: (value: unknown) => void = () => {};
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({ configOptions: [modelOption("opus")] }),
      resumeSession: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveResume = resolve;
          }),
      ),
    });
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
      },
    } as InitializeResponse);
    const session = await loadNamedSession(repo, "active");

    const refresh = repo.refreshMCPServersForAllSessions();
    await vi.waitFor(() => expect(conn.resumeSession).toHaveBeenCalled());
    await session.setConfigOption("model", "fable");
    vi.mocked(conn.setSessionConfigOption).mockClear();
    resolveResume({ configOptions: [modelOption("opus")] });
    await refresh;

    expect(session.configOptions).toEqual([modelOption("fable")]);
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      configId: "model",
      value: "fable",
    });
    expect(conn.setSessionConfigOption).not.toHaveBeenCalledWith(
      expect.objectContaining({ value: "opus" }),
    );
  });

  it("keeps showing the session's selections while a resume restore is in flight", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const modelOption = (currentValue: string) => ({
      id: "model",
      type: "select" as const,
      category: "model" as const,
      name: "Model",
      currentValue,
      options: [
        { value: "fable", name: "Fable" },
        { value: "opus", name: "Opus" },
      ],
    });
    let resolveSet: (value: unknown) => void = () => {};
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({ configOptions: [modelOption("opus")] }),
      resumeSession: vi.fn().mockResolvedValue({ configOptions: [modelOption("fable")] }),
      setSessionConfigOption: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSet = resolve;
          }),
      ),
    });
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
      },
    } as InitializeResponse);
    const session = await loadNamedSession(repo, "active");

    const refresh = repo.refreshMCPServersForAllSessions();
    await vi.waitFor(() => expect(conn.setSessionConfigOption).toHaveBeenCalled());
    // The resume response carried the agent default (fable); the picker must
    // keep showing the session's selection while it is re-applied.
    expect(session.configOptions).toEqual([modelOption("opus")]);
    resolveSet({});
    await refresh;

    expect(session.configOptions).toEqual([modelOption("opus")]);
  });

  it("reloads every live session to refresh MCP servers when resume is unavailable", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo);
    const first = await loadNamedSession(repo, "first");
    const second = await loadNamedSession(repo, "second");
    vi.mocked(conn.loadSession).mockClear();

    await repo.refreshMCPServersForAllSessions();

    expect(conn.resumeSession).not.toHaveBeenCalled();
    expect(conn.loadSession).toHaveBeenCalledWith({
      sessionId: first.sessionId,
      cwd: "/repo",
      mcpServers: [],
    });
    expect(conn.loadSession).toHaveBeenCalledWith({
      sessionId: second.sessionId,
      cwd: "/repo",
      mcpServers: [],
    });
  });

  it("coalesces bursts of MCP server refreshes into one sweep", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo);
    await loadNamedSession(repo, "active");
    vi.mocked(conn.loadSession).mockClear();

    // The local repository listener and the helper broadcast both fire for
    // one mutation; they must share a single sweep.
    const sweeps = [repo.refreshMCPServersForAllSessions(), repo.refreshMCPServersForAllSessions()];
    await Promise.all(sweeps);

    expect(conn.loadSession).toHaveBeenCalledOnce();
  });

  it("falls back to loading when an advertised session resume is rejected", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      resumeSession: vi.fn().mockRejectedValue(new Error("session is already active")),
    });
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
      },
    } as InitializeResponse);
    await loadNamedSession(repo, "active");
    vi.mocked(conn.loadSession).mockClear();

    await repo.refreshMCPServersForAllSessions();

    expect(conn.resumeSession).toHaveBeenCalledOnce();
    expect(conn.loadSession).toHaveBeenCalledOnce();
  });

  it("keeps the three most recently used inactive sessions", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const visible = await loadNamedSession(repo, "visible");
    const releaseVisible = repo.claimVisibleConversation(visible.conversationId);
    const oldest = await loadNamedSession(repo, "inactive-1");
    await loadNamedSession(repo, "inactive-2");
    await loadNamedSession(repo, "inactive-3");
    await loadNamedSession(repo, "inactive-4");

    expect(repo.getSessionByConversationId(oldest.conversationId)).toBeNull();
    expect(repo.getSessionByConversationId("inactive-2")).not.toBeNull();
    expect(repo.getSessionByConversationId("inactive-3")).not.toBeNull();
    expect(repo.getSessionByConversationId("inactive-4")).not.toBeNull();
    expect(repo.getSessionByConversationId(visible.conversationId)).toBe(visible);

    releaseVisible();

    expect(repo.getSessionByConversationId("inactive-2")).toBeNull();
    expect(repo.getSessionByConversationId(visible.conversationId)).toBe(visible);
  });

  it("reloads an evicted conversation through the normal agent history path", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const evicted = await loadNamedSession(repo, "inactive-1");
    await loadNamedSession(repo, "inactive-2");
    await loadNamedSession(repo, "inactive-3");
    await loadNamedSession(repo, "inactive-4");
    expect(repo.getSessionByConversationId(evicted.conversationId)).toBeNull();

    const reloaded = await loadNamedSession(repo, evicted.conversationId);

    expect(reloaded).not.toBe(evicted);
    expect(conn.loadSession).toHaveBeenCalledTimes(6);
    expect(repo.getSessionByConversationId(evicted.conversationId)).toBe(reloaded);
    expect(repo.getSessionByConversationId("inactive-2")).toBeNull();
  });

  it("never evicts live work, drafts, approvals, or sessions from non-claiming hosts", async () => {
    const headlessRepo = new ACPSessionRepositoryWriter();
    await connectRepo(headlessRepo);
    for (let index = 1; index <= 5; index++) {
      await loadNamedSession(headlessRepo, `headless-${index}`);
    }
    expect(headlessRepo.getSessionByConversationId("headless-1")).not.toBeNull();

    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const working = await loadNamedSession(repo, "working");
    working.isPrompting = true;
    const localDraft = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "local-draft", {
      isPendingConversationPersisted: true,
    });
    const queuedDraft = await loadNamedSession(repo, "queued-draft");
    queuedDraft.pendingDraftSend = {
      text: "unsent draft",
      content: [textBlock("unsent draft")],
      cwd: "/repo",
    };
    const awaitingApproval = await loadNamedSession(repo, "awaiting-approval");
    awaitingApproval.pendingPermissionRequests = [
      {
        id: "approval-1",
        agentServer: DEFAULT_AGENT_SERVER,
        sessionId: awaitingApproval.sessionId!,
        toolCall: permissionRequest().toolCall,
        options: [],
      },
    ];
    await loadNamedSession(repo, "inactive-1");
    await loadNamedSession(repo, "inactive-2");
    await loadNamedSession(repo, "inactive-3");
    await loadNamedSession(repo, "inactive-4");

    expect(repo.getSessionByConversationId(working.conversationId)).toBe(working);
    expect(repo.getSessionByConversationId(localDraft.conversationId)).toBe(localDraft);
    expect(repo.getSessionByConversationId(queuedDraft.conversationId)).toBe(queuedDraft);
    expect(repo.getSessionByConversationId(awaitingApproval.conversationId)).toBe(awaitingApproval);
    expect(repo.getSessionByConversationId("inactive-1")).toBeNull();
  });

  it("closes the agent-side session for records evicted from the cache", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const evicted = await loadNamedSession(repo, "inactive-1");
    await loadNamedSession(repo, "inactive-2");
    await loadNamedSession(repo, "inactive-3");
    await loadNamedSession(repo, "inactive-4");

    expect(repo.getSessionByConversationId(evicted.conversationId)).toBeNull();
    expect(helperJsonrpcCall).toHaveBeenCalledWith("camber/acp/session/close", {
      agentServer: DEFAULT_AGENT_SERVER,
      sessionId: evicted.sessionId,
    });
    expect(helperJsonrpcCall).not.toHaveBeenCalledWith(
      "camber/acp/session/close",
      expect.objectContaining({ sessionId: visible.sessionId }),
    );
  });

  const resumeCapableInit = {
    protocolVersion: 1,
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    },
  } as InitializeResponse;

  // Wall-clock anchored: touchSession stamps sessions with Date.now(), so a
  // fixed epoch would make every record look active far in the future.
  const IDLE_SWEEP_T0 = Date.now();
  const IDLE_SWEEP_LATER = IDLE_SWEEP_T0 + 11 * 60 * 1000;

  it("suspends a session idle past the threshold and closes its agent-side resources", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");

    repo.closeIdleSessions(IDLE_SWEEP_T0);
    expect(idle.suspended).toBe(false);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);

    expect(idle.suspended).toBe(true);
    expect(visible.suspended).toBe(false);
    // The warm record stays in memory — only the agent side is released.
    expect(repo.getSessionByConversationId(idle.conversationId)).toBe(idle);
    expect(helperJsonrpcCall).toHaveBeenCalledWith("camber/acp/session/close", {
      agentServer: DEFAULT_AGENT_SERVER,
      sessionId: idle.sessionId,
    });
    expect(helperJsonrpcCall).not.toHaveBeenCalledWith(
      "camber/acp/session/close",
      expect.objectContaining({ sessionId: visible.sessionId }),
    );
  });

  it("does not suspend working sessions or agents without resume support", async () => {
    const noResumeRepo = new ACPSessionRepositoryWriter();
    await connectRepo(noResumeRepo);
    const noResumeVisible = await loadNamedSession(noResumeRepo, "visible");
    noResumeRepo.claimVisibleConversation(noResumeVisible.conversationId);
    const noResumeIdle = await loadNamedSession(noResumeRepo, "idle");
    noResumeRepo.closeIdleSessions(IDLE_SWEEP_T0);
    noResumeRepo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(noResumeIdle.suspended).toBe(false);

    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const working = await loadNamedSession(repo, "working");
    working.isPrompting = true;
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(working.suspended).toBe(false);
    expect(helperJsonrpcCall).not.toHaveBeenCalledWith(
      "camber/acp/session/close",
      expect.anything(),
    );
  });

  it("does not suspend a session another surface reports as busy", async () => {
    const statusWriter = new ACPConversationStatusRepositoryWriter();
    const repo = new ACPSessionRepositoryWriter(statusWriter.publicAPI());
    await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const remote = await loadNamedSession(repo, "remote");
    statusWriter.markWaitingForUser({
      type: "approval",
      sessionId: remote.sessionId!,
      agentServer: DEFAULT_AGENT_SERVER,
    });

    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);

    expect(remote.suspended).toBe(false);
  });

  it("does not suspend a session the helper-pushed status reports as working remotely", async () => {
    const statusWriter = new ACPConversationStatusRepositoryWriter();
    const repo = new ACPSessionRepositoryWriter(statusWriter.publicAPI());
    await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const remote = await loadNamedSession(repo, "remote");
    // A turn driven from another surface arrives only via the helper-pushed
    // liveStatus on conversation summaries — local flags stay false.
    statusWriter.syncRemoteStatuses([
      {
        sessionId: remote.sessionId,
        agentServer: DEFAULT_AGENT_SERVER,
        liveStatus: { working: true, waitingForUser: false, unread: false },
      },
    ]);

    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(remote.suspended).toBe(false);

    // The remote turn ending lifts the protection.
    statusWriter.syncRemoteStatuses([]);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    repo.closeIdleSessions(IDLE_SWEEP_LATER + 11 * 60 * 1000);
    expect(remote.suspended).toBe(true);
  });

  it("reverts the suspended flag when the close RPC fails", async () => {
    const jsonrpcCall = vi.fn().mockImplementation((method: string) => {
      if (method === "camber/acp/session/close") {
        return Promise.reject(new Error("helper unavailable"));
      }
      return Promise.resolve({ entry: null });
    });
    initializeHelperApi({ jsonrpcCall, jsonrpcNotify: vi.fn().mockResolvedValue(undefined) });

    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(idle.suspended).toBe(true);

    // The failed close leaves the agent side live; a stuck suspended flag
    // would exempt the session from every future sweep.
    await vi.waitFor(() => expect(idle.suspended).toBe(false));

    repo.closeIdleSessions(IDLE_SWEEP_LATER + 11 * 60 * 1000);
    expect(idle.suspended).toBe(true);
    expect(
      jsonrpcCall.mock.calls.filter(([method]) => method === "camber/acp/session/close"),
    ).toHaveLength(2);
  });

  it("closes the agent session when evicting a suspended record", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(idle.suspended).toBe(true);
    helperJsonrpcCall.mockClear();

    await loadNamedSession(repo, "inactive-2");
    await loadNamedSession(repo, "inactive-3");
    await loadNamedSession(repo, "inactive-4");

    expect(repo.getSessionByConversationId(idle.conversationId)).toBeNull();
    // A reattach could be in flight when the record is dropped; re-closing an
    // already-gone session is a helper-level no-op, so evict always closes.
    expect(helperJsonrpcCall).toHaveBeenCalledWith("camber/acp/session/close", {
      agentServer: DEFAULT_AGENT_SERVER,
      sessionId: idle.sessionId,
    });
  });

  it("drops the warm record when its agent-side session is closed elsewhere", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const archived = await loadNamedSession(repo, "archived");
    vi.mocked(conn.loadSession).mockClear();

    repo.releaseClosedSession({
      sessionId: archived.sessionId,
      agentServer: DEFAULT_AGENT_SERVER,
      conversationId: archived.conversationId,
    });

    expect(repo.getSessionByConversationId(archived.conversationId)).toBeNull();
    // Reopening goes through the full load path (fresh agent-side session)
    // instead of handing back the stale warm record.
    const reloaded = await loadNamedSession(repo, archived.conversationId);
    expect(reloaded).not.toBe(archived);
    expect(conn.loadSession).toHaveBeenCalled();
  });

  it("does not suspend sessions whose agent lacks the close capability", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection(), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        // resume without close: the helper would no-op the close, so
        // suspending would strand a live subprocess behind a lying flag.
        sessionCapabilities: { list: {}, resume: {} },
      },
    } as InitializeResponse);
    const repoWithClose = new ACPSessionRepositoryWriter();
    await connectRepo(repoWithClose, mockConnection(), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
    } as InitializeResponse);

    for (const [instance, expectSuspended] of [
      [repo, false],
      [repoWithClose, true],
    ] as const) {
      const visible = await loadNamedSession(instance, "visible");
      instance.claimVisibleConversation(visible.conversationId);
      const idle = await loadNamedSession(instance, "idle");
      instance.closeIdleSessions(IDLE_SWEEP_T0);
      instance.closeIdleSessions(IDLE_SWEEP_LATER);
      expect(idle.suspended).toBe(expectSuspended);
    }
  });

  // PE-2460: pool can lose the record binding an ACP session to its backend
  // session. session/load then replays nothing and every prompt collides with
  // the backend session the first turn created, so the conversation is stuck
  // for good unless the client rebinds it to a fresh session.
  const unresumableSessionError = new ACPError({
    code: -32603,
    message: "Internal error",
    data: {
      error:
        'starting conversation: failed to create agent session: API request failed with status 500: {"errors":[{"message":"inserting new agent session: ERROR: duplicate key value violates unique constraint \\"agent_session_pkey\\" (SQLSTATE 23505)"}]}',
    },
  });

  it("promotes history returned by retrying an empty restored session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    let loadCount = 0;
    const conn = await connectRepo(
      repo,
      mockConnection({
        loadSession: vi.fn(async ({ sessionId }: { sessionId: string }) => {
          loadCount++;
          if (loadCount === 2) {
            repo.handleSessionUpdate(
              DEFAULT_AGENT_SERVER,
              sessionNotification("Recovered reply", sessionId),
            );
          }
          return {};
        }),
      }),
    );
    const session = await loadNamedSession(repo, "lost");
    expect(session.restoredWithoutHistory).toBe(true);
    expect(session.events).toEqual([]);

    const restored = await repo.reloadLiveSession(session.sessionId!, session.agentServer);

    expect(restored).toBe(true);
    expect(conn.loadSession).toHaveBeenCalledTimes(2);
    expect(session.events).toEqual([
      expect.objectContaining({
        eventKind: "agent_message",
        content: [expect.objectContaining({ type: "text", text: "Recovered reply" })],
      }),
    ]);
    expect(session.restoredWithoutHistory).toBe(false);
  });

  it("rebinds a conversation the agent cannot resume to a fresh session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(
      repo,
      mockConnection({
        newSession: vi.fn().mockResolvedValue({ sessionId: "s-fresh" }),
        prompt: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
          if (sessionId === "session-lost") throw unresumableSessionError;
          return {} as PromptResponse;
        }),
      }),
    );
    const session = await loadNamedSession(repo, "lost");
    expect(session.restoredWithoutHistory).toBe(true);

    await session.prompting.prompt("carry on");

    expect(conn.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: expect.objectContaining({ "camber/conversation_id": "lost" }),
      }),
    );
    expect(session.sessionId).toBe("s-fresh");
    expect(conn.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "s-fresh" }));
    expect(session.promptError).toBeNull();
    expect(session.restoredWithoutHistory).toBe(false);
    // The prompt shows once: the retry must not re-add the optimistic message.
    expect(session.events.filter((event) => event.eventKind === "user_message")).toHaveLength(1);
  });

  it("keeps a restored conversation's title when rebinding it to a fresh session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(
      repo,
      mockConnection({
        newSession: vi.fn().mockResolvedValue({ sessionId: "s-fresh" }),
        prompt: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
          if (sessionId === "session-lost") throw unresumableSessionError;
          return {} as PromptResponse;
        }),
      }),
    );
    const session = await loadNamedSession(repo, "lost");
    session.sessionInfo = { ...session.sessionInfo!, title: "Original question" };

    await session.prompting.prompt("carry on");

    expect(session.sessionInfo?.title).toBe("Original question");
  });

  it("surfaces an unresumable-session error when there is a transcript to lose", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(
      repo,
      mockConnection({
        loadSession: vi.fn(async () => {
          repo.handleSessionUpdate(
            DEFAULT_AGENT_SERVER,
            sessionNotification("earlier reply", "session-kept"),
          );
          return {};
        }),
        prompt: vi.fn().mockRejectedValue(unresumableSessionError),
      }),
    );
    const session = await loadNamedSession(repo, "kept");
    expect(session.restoredWithoutHistory).toBe(false);

    await session.prompting.prompt("carry on");

    expect(conn.newSession).not.toHaveBeenCalled();
    expect(session.sessionId).toBe("session-kept");
    expect(session.promptError?.prompt).toBe("carry on");
  });

  it("reattaches a suspended session before the next prompt", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(idle.suspended).toBe(true);

    await idle.prompting.prompt("hello again");

    expect(conn.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: idle.sessionId }),
    );
    expect(idle.suspended).toBe(false);
    expect(conn.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: idle.sessionId }),
    );
    const resumeOrder = vi.mocked(conn.resumeSession).mock.invocationCallOrder[0]!;
    const promptOrder = vi.mocked(conn.prompt).mock.invocationCallOrder[0]!;
    expect(resumeOrder).toBeLessThan(promptOrder);
  });

  it("skips suspended records when refreshing MCP servers", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(idle.suspended).toBe(true);
    vi.mocked(conn.resumeSession).mockClear();
    vi.mocked(conn.loadSession).mockClear();

    await repo.refreshMCPServersForAllSessions();

    // Resuming a suspended session just to deliver the connector set would
    // respawn its subprocess (for the next sweep to close again); a reattach
    // picks the current set up from the helper anyway.
    expect(conn.resumeSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: idle.sessionId }),
    );
    expect(idle.suspended).toBe(true);
  });

  it("does not let a queued MCP refresh resurrect a session suspended while it waits", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");
    let releaseBlocker!: () => void;
    const blocker = idle.serialize(
      () =>
        new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        }),
    );
    const refresh = repo.refreshMCPServersForAllSessions();

    // Let the coalesced sweep select this still-live record and queue behind
    // the blocker, then suspend it before the queued refresh can execute.
    await new Promise((resolve) => setTimeout(resolve, 350));
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(idle.suspended).toBe(true);

    releaseBlocker();
    await blocker;
    await refresh;

    expect(conn.resumeSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: idle.sessionId }),
    );
    expect(idle.suspended).toBe(true);
  });

  it("protects a session from idle close and eviction while a refresh is in flight", async () => {
    let resolveResume!: (value: object) => void;
    const conn = mockConnection({
      resumeSession: vi.fn(
        () =>
          new Promise<object>((resolve) => {
            resolveResume = resolve;
          }),
      ),
    });
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, conn, resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const refreshing = await loadNamedSession(repo, "refreshing");
    repo.closeIdleSessions(IDLE_SWEEP_T0);

    const refresh = refreshing.serialize((gen) => refreshing.refreshMCPServers(gen));
    await vi.waitFor(() => expect(conn.resumeSession).toHaveBeenCalled());
    expect(refreshing.refreshInFlight).toBe(true);

    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    await loadNamedSession(repo, "inactive-2");
    await loadNamedSession(repo, "inactive-3");
    await loadNamedSession(repo, "inactive-4");
    await loadNamedSession(repo, "inactive-5");

    expect(refreshing.suspended).toBe(false);
    expect(repo.getSessionByConversationId(refreshing.conversationId)).toBe(refreshing);
    expect(helperJsonrpcCall).not.toHaveBeenCalledWith("camber/acp/session/close", {
      agentServer: DEFAULT_AGENT_SERVER,
      sessionId: refreshing.sessionId,
    });

    resolveResume({});
    await refresh;
    expect(refreshing.refreshInFlight).toBe(false);
  });

  it("reattaches a suspended session before a config change", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");
    idle.configOptions = [
      {
        id: "model",
        type: "select",
        name: "Model",
        currentValue: "fable",
        options: [{ value: "fable", name: "Fable" }],
      },
    ];
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(idle.suspended).toBe(true);

    await idle.setConfigOption("model", "fable");

    expect(conn.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: idle.sessionId }),
    );
    expect(idle.suspended).toBe(false);
    const resumeOrder = vi.mocked(conn.resumeSession).mock.invocationCallOrder[0]!;
    const setOrder = vi.mocked(conn.setSessionConfigOption).mock.invocationCallOrder[0]!;
    expect(resumeOrder).toBeLessThan(setOrder);
  });

  it("shares one reattach across concurrent config queues", async () => {
    let resolveResume!: (value: object) => void;
    const conn = mockConnection({
      resumeSession: vi.fn(
        () =>
          new Promise<object>((resolve) => {
            resolveResume = resolve;
          }),
      ),
    });
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, conn, resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(idle.suspended).toBe(true);

    const modelChange = idle.setConfigOption("model", "fable");
    const thinkingChange = idle.setBooleanConfigOption("thinking", true);
    await vi.waitFor(() => expect(conn.resumeSession).toHaveBeenCalled());
    expect(conn.resumeSession).toHaveBeenCalledTimes(1);

    resolveResume({});
    await Promise.all([modelChange, thinkingChange]);

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: idle.sessionId,
      configId: "model",
      value: "fable",
    });
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: idle.sessionId,
      configId: "thinking",
      value: true,
      type: "boolean",
    });
    expect(idle.suspended).toBe(false);
  });

  it("marks stale config failures suspended so the next change reattaches", async () => {
    const stale = new ACPError({
      code: -32603,
      message: "Internal error",
      data: { detail: "Session not found" },
    });
    const setSessionConfigOption = vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce({});
    const conn = mockConnection({ setSessionConfigOption });
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, conn, resumeCapableInit);
    const session = await loadNamedSession(repo, "config-stale");

    await expect(session.setConfigOption("model", "fable")).rejects.toEqual(stale);
    expect(session.suspended).toBe(true);

    await session.setConfigOption("model", "fable");

    expect(conn.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.sessionId }),
    );
    expect(setSessionConfigOption).toHaveBeenCalledTimes(2);
    expect(session.suspended).toBe(false);
  });

  it("surfaces a retryable prompt error when reattach fails", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(idle.suspended).toBe(true);
    vi.mocked(conn.resumeSession).mockRejectedValue(new Error("agent down"));
    vi.mocked(conn.loadSession).mockRejectedValue(new Error("agent down"));

    await idle.prompting.prompt("do not lose me");

    expect(conn.prompt).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: idle.sessionId }),
    );
    // Silently dropping the typed message would be data loss; the prompt must
    // land in promptError so retry can resend it.
    expect(idle.promptError?.prompt).toBe("do not lose me");
  });

  it("waits for an in-flight close before reattaching", async () => {
    let resolveClose: (() => void) | undefined;
    const jsonrpcCall = vi.fn().mockImplementation((method: string) => {
      if (method === "camber/acp/session/close") {
        return new Promise<object>((resolve) => {
          resolveClose = () => resolve({});
        });
      }
      return Promise.resolve({ entry: null });
    });
    initializeHelperApi({ jsonrpcCall, jsonrpcNotify: vi.fn().mockResolvedValue(undefined) });

    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(idle.suspended).toBe(true);
    expect(resolveClose).toBeDefined();

    const reattach = idle.reattachIfSuspended();
    await Promise.resolve();
    await Promise.resolve();
    // The close RPC has not settled: resuming now could be overtaken and
    // torn down by the late close.
    expect(conn.resumeSession).not.toHaveBeenCalled();

    resolveClose!();
    await reattach;

    expect(conn.resumeSession).toHaveBeenCalled();
    expect(idle.suspended).toBe(false);
  });

  it("reattaches a suspended session when its conversation is claimed", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = await connectRepo(repo, mockConnection(), resumeCapableInit);
    const visible = await loadNamedSession(repo, "visible");
    repo.claimVisibleConversation(visible.conversationId);
    const idle = await loadNamedSession(repo, "idle");
    repo.closeIdleSessions(IDLE_SWEEP_T0);
    repo.closeIdleSessions(IDLE_SWEEP_LATER);
    expect(idle.suspended).toBe(true);

    repo.claimVisibleConversation(idle.conversationId);

    await vi.waitFor(() => expect(idle.suspended).toBe(false));
    expect(conn.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: idle.sessionId }),
    );
  });

  it("connects with the configured transport", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();

    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
    } as InitializeResponse);

    expect(repo.isConnected).toBe(true);
    expect(repo.agents.getInitializeResponse(DEFAULT_AGENT_SERVER)).toMatchObject({
      protocolVersion: 1,
    });
  });

  it("keeps background agent connection failures off the global error surface", async () => {
    const repo = new ACPSessionRepositoryWriter();
    repo.agents.setConnectionPool({
      connect: vi.fn().mockRejectedValue(new Error("third-party failed")),
    } as unknown as ACPConnectionPool);

    await expect(repo.agents.connectServer("third-party")).resolves.toBeNull();
    expect(repo.agents.nonSessionError).toBeNull();

    await expect(
      repo.agents.connectServer("third-party", { surfaceErrors: true }),
    ).resolves.toBeNull();
    expect(repo.agents.nonSessionError?.message).toBe("third-party failed");
  });

  it("connects configured servers around the configured default agent", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const defaultConn = mockConnection();
    const connect = vi.fn(async (agentServer: string) => {
      if (agentServer === DEFAULT_AGENT_SERVER) {
        return {
          conn: defaultConn,
          initializeResponse: {
            protocolVersion: 1,
            authMethods: [],
            agentCapabilities: { loadSession: true },
          },
        };
      }
      throw new Error("third-party failed");
    });
    repo.agents.setConnectionPool({ connect } as unknown as ACPConnectionPool);
    repo.agents.configureAgentServers([DEFAULT_AGENT_SERVER, "third-party"], DEFAULT_AGENT_SERVER);

    await expect(repo.agents.connectConfiguredServers()).resolves.toBe(defaultConn);

    expect(repo.agents.connectionFor(DEFAULT_AGENT_SERVER)).toBe(defaultConn);
    expect(repo.agents.nonSessionError).toBeNull();
  });

  it("includes pending elicitations in published waiting status", () => {
    const conversationStatus = new ACPConversationStatusRepositoryWriter();
    const elicitation = new ElicitationRepository(conversationStatus.publicAPI());
    const repo = new ACPSessionRepositoryWriter(conversationStatus.publicAPI(), elicitation);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "session-1";
    repo.publishLiveStatuses();
    elicitation.register({
      mode: "form",
      elicitationId: "elicitation-1",
      message: "test",
      sessionId: "session-1",
      agentServer: DEFAULT_AGENT_SERVER,
    });

    repo.publishLiveStatuses();

    expect(repo.getConversationStatus("session-1", DEFAULT_AGENT_SERVER)).toEqual({
      working: false,
      waitingForUser: true,
      unread: true,
    });
  });

  it("clears cached connection state when an agent server exits", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const firstConn = mockConnection();
    const secondConn = mockConnection();
    let starts = 0;
    let cached: {
      conn: ClientSideConnection;
      initializeResponse: InitializeResponse;
      transport: {};
    } | null = null;
    const connect = vi.fn(async () => {
      if (cached) return cached;
      starts += 1;
      cached = {
        conn: starts === 1 ? firstConn : secondConn,
        initializeResponse: {
          protocolVersion: 1,
          authMethods: [],
          agentCapabilities: { loadSession: true },
        },
        transport: {},
      };
      return cached;
    });
    const disconnect = vi.fn(() => {
      cached = null;
    });
    repo.agents.setConnectionPool({ connect, disconnect } as unknown as ACPConnectionPool);

    await repo.agents.connect();
    repo.handleAgentServerDidExit(DEFAULT_AGENT_SERVER, "exit status 2");

    expect(repo.isConnected).toBe(false);
    expect(repo.agents.capabilitiesFor(DEFAULT_AGENT_SERVER)).toBeNull();
    expect(repo.agents.nonSessionError?.message).toBe("ACP agent server exited");
    expect(disconnect).toHaveBeenCalledWith(DEFAULT_AGENT_SERVER);

    await expect(repo.agents.connect()).resolves.toBe(secondConn);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("clears in-flight steering and stale goal state when its agent server exits", () => {
    const repo = new ACPSessionRepositoryWriter();
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-active");
    session.sessionId = "s-active";
    session.steeringRequestsInFlight = 1;
    session.goal = {
      source: "codex",
      objective: "Finish the release",
      status: "active",
    };

    repo.handleAgentServerDidExit(DEFAULT_AGENT_SERVER, "exit status 2");

    expect(session.isSteering).toBe(false);
    expect(session.goal).toBeNull();
  });

  it("finishes an active turn as interrupted when its agent server exits", () => {
    const repo = new ACPSessionRepositoryWriter();
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-active");
    session.sessionId = "s-active";
    session.materializer.startTurn("2026-08-02T12:00:00.000Z");
    session.materializer.apply({
      sessionUpdate: "tool_call",
      toolCallId: "subagent-1",
      title: "Start subagent reviewer",
      status: "in_progress",
    } as SessionUpdate);
    session.publishTranscript();

    repo.handleAgentServerDidExit(DEFAULT_AGENT_SERVER, "exit status 2");

    expect(session.events[0]).toMatchObject({ status: "cancelled" });
    expect(session.turns).toEqual([
      expect.objectContaining({
        startIndex: 0,
        endIndex: 0,
        interrupted: true,
      }),
    ]);
  });

  it("creates independent local sessions", async () => {
    const repo = new ACPSessionRepositoryWriter();

    const first = repo.createSession("/repo/a", DEFAULT_AGENT_SERVER, "conv-a");
    const second = repo.createSession("/repo/b", DEFAULT_AGENT_SERVER, "conv-b");

    expect(first.conversationId).not.toBe(second.conversationId);
    expect(repo.getSessionByConversationId(first.conversationId)).toBe(first);
    expect(repo.getSessionByConversationId(second.conversationId)).toBe(second);
    expect(first).toMatchObject({
      sessionId: null,
      cwd: "/repo/a",
      conversationId: "conv-a",
    });
    expect(first.pendingConversationId).toBe("conv-a");
    expect(first.pendingCwd).toBe("/repo/a");
  });

  it("does not carry plan mode into a new draft for the same agent", async () => {
    const repo = new ACPSessionRepositoryWriter();
    vi.spyOn(repo.agents, "loadOrInitCachedConfig").mockResolvedValue(undefined);
    vi.spyOn(repo.agents, "ensureConfigProbe").mockResolvedValue(undefined);
    const modelOption = (currentValue: string) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: [
        { name: "Sonnet", value: "sonnet" },
        { name: "Opus", value: "opus" },
      ],
      currentValue,
    });
    const collaborationOption = (currentValue: string) => ({
      id: "collaboration_mode",
      type: "select" as const,
      name: "Collaboration mode",
      category: "collaboration_mode" as const,
      options: [
        { name: "Build", value: "build" },
        { name: "Plan", value: "plan" },
      ],
      currentValue,
    });
    repo.agents.configCacheByAgentServer = {
      [DEFAULT_AGENT_SERVER]: {
        agentServer: DEFAULT_AGENT_SERVER,
        configOptions: [modelOption("sonnet"), collaborationOption("build")],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-08-04T00:00:00.000Z",
      },
    };

    const first = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-first");
    await first.setConfigOption("model", "opus");
    await first.togglePlanMode();
    expect(first.isPlanModeActive).toBe(true);

    const second = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-second");

    expect(second.isPlanModeActive).toBe(false);
    expect(second.configOptions).toEqual([
      expect.objectContaining({ id: "model", currentValue: "opus" }),
      expect.objectContaining({ id: "collaboration_mode", currentValue: "build" }),
    ]);
    expect(first.isPlanModeActive).toBe(true);
  });

  it("does not carry legacy plan mode into a new draft for the same agent", async () => {
    const repo = new ACPSessionRepositoryWriter();
    vi.spyOn(repo.agents, "loadOrInitCachedConfig").mockResolvedValue(undefined);
    vi.spyOn(repo.agents, "ensureConfigProbe").mockResolvedValue(undefined);
    repo.agents.configCacheByAgentServer = {
      [DEFAULT_AGENT_SERVER]: {
        agentServer: DEFAULT_AGENT_SERVER,
        configOptions: [],
        availableCommands: [],
        modes: {
          currentModeId: "build",
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

    const first = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-first");
    await first.togglePlanMode();
    expect(first.isPlanModeActive).toBe(true);

    const second = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-second");

    expect(second.currentModeId).toBe("build");
    expect(second.isPlanModeActive).toBe(false);
    expect(first.isPlanModeActive).toBe(true);
  });

  it("persists model selections as last-used defaults but never mode-shaped ones", async () => {
    const repo = new ACPSessionRepositoryWriter();
    vi.spyOn(repo.agents, "loadOrInitCachedConfig").mockResolvedValue(undefined);
    vi.spyOn(repo.agents, "ensureConfigProbe").mockResolvedValue(undefined);
    repo.agents.configCacheByAgentServer = {
      [DEFAULT_AGENT_SERVER]: {
        agentServer: DEFAULT_AGENT_SERVER,
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
            currentValue: "sonnet",
          },
          {
            id: "permission_mode",
            type: "select",
            name: "Mode",
            category: "mode",
            options: [
              { name: "Always ask", value: "default" },
              { name: "Bypass permissions", value: "yolo" },
            ],
            currentValue: "default",
          },
          {
            id: "collaboration_mode",
            type: "select",
            name: "Collaboration mode",
            category: "collaboration_mode",
            options: [
              { name: "Build", value: "build" },
              { name: "Plan", value: "plan" },
            ],
            currentValue: "build",
          },
          // Uncategorized "extras" option (e.g. Goose's provider picker): its
          // semantics are unknown to this client, so a pick must not persist.
          {
            id: "provider",
            type: "select",
            name: "Provider",
            options: [
              { name: "OpenAI", value: "openai" },
              { name: "Anthropic", value: "anthropic" },
            ],
            currentValue: "openai",
          },
          // Reserved model-tuning category the picker does not otherwise
          // classify (e.g. temperature): safe to persist by category alone.
          {
            id: "temperature",
            type: "select",
            name: "Temperature",
            category: "model_config",
            options: [
              { name: "0.2", value: "0.2" },
              { name: "1.0", value: "1.0" },
            ],
            currentValue: "0.2",
          },
        ],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: "2026-08-04T00:00:00.000Z",
      },
    };
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-last-used");
    const agentServersWrites = () =>
      helperJsonrpcCall.mock.calls.filter(([method]) => String(method).includes("setAgentServers"));
    const flushPersistQueue = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };

    // Plan toggles and permission-mode picks are behavioral session state:
    // they must cause NO agent-servers store writes, or one bypass-style
    // session would silently become every future conversation's start state.
    await session.togglePlanMode();
    await session.setConfigOption("permission_mode", "yolo");
    await flushPersistQueue();
    expect(agentServersWrites()).toHaveLength(0);
    // Still recorded in memory, so a config probe preserves them for this
    // app run.
    const recorded = repo.agents.userConfigSelectionsFor(DEFAULT_AGENT_SERVER);
    expect(recorded.get("collaboration_mode")).toBe("plan");
    expect(recorded.get("permission_mode")).toBe("yolo");

    // A model selection persists as the agent's last-used default.
    await session.setConfigOption("model", "opus");
    await vi.waitFor(() => expect(agentServersWrites()).toHaveLength(1));
    const [, params] = agentServersWrites()[0] as [
      string,
      { agentServers: Record<string, { default_config_options?: Record<string, string> }> },
    ];
    expect(params.agentServers[DEFAULT_AGENT_SERVER].default_config_options).toEqual({
      model: "opus",
    });

    // An uncategorized "extras" pick (unknown semantics to this client) is
    // recorded in memory only, causing no additional agent-servers write.
    await session.setConfigOption("provider", "anthropic");
    await flushPersistQueue();
    expect(agentServersWrites()).toHaveLength(1);
    expect(repo.agents.userConfigSelectionsFor(DEFAULT_AGENT_SERVER).get("provider")).toBe(
      "anthropic",
    );

    // A pick on a reserved model-tuning category persists even though the
    // option itself isn't one of the classified prompt-surface kinds: exactly
    // one more agent-servers write, on top of the model write above.
    await session.setConfigOption("temperature", "1.0");
    await vi.waitFor(() => expect(agentServersWrites()).toHaveLength(2));
    const [, secondParams] = agentServersWrites()[1] as [
      string,
      { agentServers: Record<string, { default_config_options?: Record<string, string> }> },
    ];
    expect(secondParams.agentServers[DEFAULT_AGENT_SERVER].default_config_options).toEqual({
      temperature: "1.0",
    });
  });

  it("updates an existing pending conversation when its agent changes", () => {
    const repo = new ACPSessionRepositoryWriter();

    const first = repo.createSession("/repo/a", "codex-acp", "conv-a", {
      isPendingConversationPersisted: true,
    });
    const second = repo.createSession("/repo/b", "claude-acp", "conv-a");

    expect(second).toBe(first);
    expect(repo.getSessionByConversationId("conv-a")).toBe(first);
    expect(first).toMatchObject({
      sessionId: null,
      agentServer: "claude-acp",
      cwd: "/repo/b",
      conversationId: "conv-a",
    });
  });

  it("merges local inference models into agent-created sessions' model config option", () => {
    const repo = new ACPSessionRepositoryWriter();
    const modelOption = {
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model",
      options: [{ name: "old-model", value: "old-model" }],
      currentValue: "old-model",
    };
    const live = repo.createSession("/repo", "local", "conv-live");
    live.sessionId = "s-live";
    live.configOptions = [modelOption];
    const pending = repo.createSession("/repo", "local", "conv-pending");
    pending.configOptions = [modelOption];
    const otherAgent = repo.createSession("/repo", "codex-acp", "conv-other");
    otherAgent.sessionId = "s-other";
    otherAgent.configOptions = [modelOption];

    repo.applyLocalInferenceModelConfigToSessionsForAgent("local", {
      modelsDirectory: "/tmp/models",
      catalog: [
        {
          id: "mlx-community/Laguna-XS-2.1-4bit",
          repoId: "mlx-community/Laguna-XS-2.1-4bit",
          name: "Laguna XS 2.1 4-bit",
          provider: "mlx-community",
          downloaded: true,
        },
        {
          id: "custom/Downloaded-From-Search-4bit",
          repoId: "custom/Downloaded-From-Search-4bit",
          name: "Downloaded From Search 4bit",
          provider: "custom",
          downloaded: true,
        },
      ],
      runtime: {
        supported: true,
        status: "running",
        agentServer: "local",
        defaultModelId: "mlx-community/Laguna-XS-2.1-4bit",
      },
    });

    expect(live.configOptions).toEqual([
      expect.objectContaining({
        id: "model",
        currentValue: "mlx-community/Laguna-XS-2.1-4bit",
        options: [
          expect.objectContaining({ value: "mlx-community/Laguna-XS-2.1-4bit" }),
          expect.objectContaining({ value: "custom/Downloaded-From-Search-4bit" }),
        ],
      }),
    ]);
    // Local-only sessions mirror the config cache via applyCachedConfig instead.
    expect(pending.configOptions).toEqual([modelOption]);
    expect(otherAgent.configOptions).toEqual([modelOption]);
  });

  it("pushes a changed local inference model selection to the agent", () => {
    const repo = new ACPSessionRepositoryWriter();
    const modelOption = {
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model",
      options: [{ name: "old-model", value: "old-model" }],
      currentValue: "old-model",
    };
    const live = repo.createSession("/repo", "local", "conv-live");
    live.sessionId = "s-live";
    live.configOptions = [modelOption];
    const setConfigOption = vi.spyOn(live, "setConfigOption").mockResolvedValue(undefined);

    repo.applyLocalInferenceModelConfigToSessionsForAgent("local", {
      modelsDirectory: "/tmp/models",
      catalog: [
        {
          id: "mlx-community/Laguna-XS-2.1-4bit",
          repoId: "mlx-community/Laguna-XS-2.1-4bit",
          name: "Laguna XS 2.1 4-bit",
          provider: "mlx-community",
          downloaded: true,
        },
      ],
      runtime: {
        supported: true,
        status: "running",
        agentServer: "local",
        defaultModelId: "mlx-community/Laguna-XS-2.1-4bit",
      },
    });

    // The old selection was deleted, so the merge picks the only remaining
    // model and the agent must be told, or it keeps serving a model that no
    // longer exists on disk.
    expect(live.configOptions).toEqual([
      expect.objectContaining({ currentValue: "mlx-community/Laguna-XS-2.1-4bit" }),
    ]);
    expect(setConfigOption).toHaveBeenCalledOnce();
    // Machine-driven, so it must not be recorded as a user selection.
    expect(setConfigOption).toHaveBeenCalledWith("model", "mlx-community/Laguna-XS-2.1-4bit", {
      recordSelection: false,
    });
  });

  it("applies the local inference model sync without recording it as a user pick", async () => {
    helperJsonrpcCall.mockImplementation(async (method: unknown, params: unknown) => {
      const name = String(method);
      if (name.includes("listAgentServers")) return { agentServers: { local: {} } };
      if (name.includes("setAgentServers")) {
        return { agentServers: (params as { agentServers: unknown }).agentServers };
      }
      return { entry: null };
    });
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    await connectRepo(
      repo,
      conn,
      {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {},
      } as InitializeResponse,
      "local",
    );
    const live = repo.createSession("/repo", "local", "conv-live");
    live.sessionId = "s-live";
    live.configOptions = [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        options: [{ name: "old-model", value: "old-model" }],
        currentValue: "old-model",
      },
    ];
    const agentServersWrites = () =>
      helperJsonrpcCall.mock.calls.filter(([method]) => String(method).includes("setAgentServers"));

    repo.applyLocalInferenceModelConfigToSessionsForAgent("local", {
      modelsDirectory: "/tmp/models",
      catalog: [
        {
          id: "mlx-community/Laguna-XS-2.1-4bit",
          repoId: "mlx-community/Laguna-XS-2.1-4bit",
          name: "Laguna XS 2.1 4-bit",
          provider: "mlx-community",
          downloaded: true,
        },
        {
          id: "custom/Downloaded-From-Search-4bit",
          repoId: "custom/Downloaded-From-Search-4bit",
          name: "Downloaded From Search 4bit",
          provider: "custom",
          downloaded: true,
        },
      ],
      runtime: {
        supported: true,
        status: "running",
        agentServer: "local",
        defaultModelId: "mlx-community/Laguna-XS-2.1-4bit",
      },
    });

    // The wire call and the local apply still happen...
    await vi.waitFor(() =>
      expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: "s-live",
        configId: "model",
        value: "mlx-community/Laguna-XS-2.1-4bit",
      }),
    );
    // ...but nothing is marked user-touched, recorded, or persisted: the
    // machine changed the effective model, not the user.
    expect(live.userSelectedConfigIds.has("model")).toBe(false);
    expect(repo.agents.userConfigSelectionsFor("local").has("model")).toBe(false);
    expect(agentServersWrites()).toHaveLength(0);

    // An explicit pick on the same session still records and persists.
    await live.setConfigOption("model", "custom/Downloaded-From-Search-4bit");
    expect(live.userSelectedConfigIds.has("model")).toBe(true);
    expect(repo.agents.userConfigSelectionsFor("local").get("model")).toBe(
      "custom/Downloaded-From-Search-4bit",
    );
    await vi.waitFor(() => expect(agentServersWrites()).toHaveLength(1));
    const [, params] = agentServersWrites()[0] as [
      string,
      { agentServers: Record<string, { default_config_options?: Record<string, string> }> },
    ];
    expect(params.agentServers.local.default_config_options).toEqual({
      model: "custom/Downloaded-From-Search-4bit",
    });
  });

  it("does not resend the model selection to the agent when the merge does not change it", () => {
    const repo = new ACPSessionRepositoryWriter();
    const modelOption = {
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model",
      options: [
        { name: "mlx-community/Laguna-XS-2.1-4bit", value: "mlx-community/Laguna-XS-2.1-4bit" },
      ],
      currentValue: "mlx-community/Laguna-XS-2.1-4bit",
    };
    const live = repo.createSession("/repo", "local", "conv-live");
    live.sessionId = "s-live";
    live.configOptions = [modelOption];
    const setConfigOption = vi.spyOn(live, "setConfigOption").mockResolvedValue(undefined);

    repo.applyLocalInferenceModelConfigToSessionsForAgent("local", {
      modelsDirectory: "/tmp/models",
      catalog: [
        {
          id: "mlx-community/Laguna-XS-2.1-4bit",
          repoId: "mlx-community/Laguna-XS-2.1-4bit",
          name: "Laguna XS 2.1 4-bit",
          provider: "mlx-community",
          downloaded: true,
        },
      ],
      runtime: {
        supported: true,
        status: "running",
        agentServer: "local",
        defaultModelId: "mlx-community/Laguna-XS-2.1-4bit",
      },
    });

    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it("reports mid-turn local sessions via promptingSessionsForAgent", () => {
    const repo = new ACPSessionRepositoryWriter();
    const prompting = repo.createSession("/repo", "local", "conv-prompting");
    prompting.sessionId = "s-prompting";
    prompting.isPrompting = true;
    const steering = repo.createSession("/repo", "local", "conv-steering");
    steering.sessionId = "s-steering";
    steering.steeringRequestsInFlight = 1;
    const idle = repo.createSession("/repo", "local", "conv-idle");
    idle.sessionId = "s-idle";
    const otherAgent = repo.createSession("/repo", "poolside", "conv-cloud");
    otherAgent.sessionId = "s-cloud";
    otherAgent.isPrompting = true;

    const sessions = repo.promptingSessionsForAgent("local");

    expect(sessions).toEqual([prompting, steering]);
  });

  it("blocks agent restarts for remote conversations never opened on this surface", () => {
    const status = new ACPConversationStatusRepositoryWriter();
    const repo = new ACPSessionRepositoryWriter(status.publicAPI());
    status.syncRemoteStatuses([
      {
        sessionId: "remote-only",
        agentServer: "codex-acp",
        liveStatus: { working: true, waitingForUser: false, unread: false },
      },
    ]);
    expect(repo.hasActiveConversationsForAgent("codex-acp")).toBe(true);
    expect(repo.hasActiveConversationsForAgent("poolside")).toBe(false);
    status.syncRemoteStatuses([]);
    expect(repo.hasActiveConversationsForAgent("codex-acp")).toBe(false);
  });

  it("blocks agent restarts while local conversations are compacting or sending", () => {
    const repo = new ACPSessionRepositoryWriter();
    const session = repo.createSession("/repo", "poolside", "conv-active");
    session.sessionId = "s-active";
    repo.handleCompactionUpdate("poolside", {
      sessionId: "s-active",
      id: "compact-1",
      phase: "started",
    });
    expect(repo.hasActiveConversationsForAgent("poolside")).toBe(true);
    expect(repo.hasActiveConversationsForAgent("codex-acp")).toBe(false);
    repo.handleCompactionUpdate("poolside", {
      sessionId: "s-active",
      id: "compact-1",
      phase: "completed",
    });
    session.isSending = true;
    expect(repo.hasActiveConversationsForAgent("poolside")).toBe(true);
    session.isSending = false;
    expect(repo.hasActiveConversationsForAgent("poolside")).toBe(false);
  });

  it("reports sessions working on another surface via promptingSessionsForAgent", () => {
    const conversationStatus = new ACPConversationStatusRepositoryWriter();
    const repo = new ACPSessionRepositoryWriter(conversationStatus.publicAPI());
    const working = repo.createSession("/repo", "local", "conv-working");
    working.sessionId = "s-working";
    const idle = repo.createSession("/repo", "local", "conv-idle");
    idle.sessionId = "s-idle";
    conversationStatus.syncLiveSessions([
      {
        agentServer: "local",
        conversationId: "conv-working",
        sessionId: "s-working",
        working: true,
        waitingForUser: false,
      },
      {
        agentServer: "local",
        conversationId: "conv-idle",
        sessionId: "s-idle",
        working: false,
        waitingForUser: false,
      },
    ]);

    expect(repo.promptingSessionsForAgent("local")).toEqual([working]);
  });

  it("does not send a model selection for local-only (sessionId === null) sessions", () => {
    const repo = new ACPSessionRepositoryWriter();
    const modelOption = {
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model",
      options: [{ name: "old-model", value: "old-model" }],
      currentValue: "old-model",
    };
    const pending = repo.createSession("/repo", "local", "conv-pending");
    pending.configOptions = [modelOption];
    const setConfigOption = vi.spyOn(pending, "setConfigOption").mockResolvedValue(undefined);

    repo.applyLocalInferenceModelConfigToSessionsForAgent("local", {
      modelsDirectory: "/tmp/models",
      catalog: [
        {
          id: "mlx-community/Laguna-XS-2.1-4bit",
          repoId: "mlx-community/Laguna-XS-2.1-4bit",
          name: "Laguna XS 2.1 4-bit",
          provider: "mlx-community",
          downloaded: true,
        },
      ],
      runtime: {
        supported: true,
        status: "running",
        agentServer: "local",
        defaultModelId: "mlx-community/Laguna-XS-2.1-4bit",
      },
    });

    // Local-only sessions mirror the config cache instead of getting a live
    // agent notification (see applyCachedConfigToLocalSessionsForAgent).
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it("does not publish draft conversations before first prompt", () => {
    const repo = new ACPSessionRepositoryWriter();
    const listener = vi.fn();
    repo.emitter.addEventListener(ACP_PENDING_CONVERSATION_AGENT_EVENT, listener);

    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER);
    repo.createSession("/repo", "claude-acp", session.conversationId);

    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes persisted pending conversation agent changes", () => {
    const repo = new ACPSessionRepositoryWriter();
    const listener = vi.fn();
    repo.emitter.addEventListener(ACP_PENDING_CONVERSATION_AGENT_EVENT, listener);

    repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-persisted", {
      isPendingConversationPersisted: true,
    });
    repo.createSession("/repo", "claude-acp", "conv-persisted");

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          conversationId: "conv-persisted",
          agentServer: "claude-acp",
          cwd: "/repo",
        }),
      }),
    );
  });

  it("publishes chats under the chat navigation scope", () => {
    const repo = new ACPSessionRepositoryWriter();
    const listener = vi.fn();
    repo.emitter.addEventListener(ACP_PENDING_CONVERSATION_AGENT_EVENT, listener);

    repo.createSession("/state/camber/chat-1", DEFAULT_AGENT_SERVER, "chat-1", {
      isChat: true,
      isPendingConversationPersisted: true,
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          conversationId: "chat-1",
          cwd: "/state/camber/chat-1",
          workspacePath: "CHAT",
        }),
      }),
    );
  });

  it("loads a session record into the collection without selecting it", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      loadSession: vi.fn(async () => {
        repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, sessionNotification("replayed"));
        return {
          configOptions: [
            { id: "mode", type: "select" as const, name: "Mode", options: [], currentValue: "ask" },
          ],
          modes: { currentModeId: "ask", availableModes: [] },
        };
      }),
    });
    await connectRepo(repo, conn);

    const load = repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { title: "Loaded", conversationId: "conv-loaded" },
      DEFAULT_AGENT_SERVER,
    );
    const session = repo.getSessionByConversationId("conv-loaded");

    expect(session).not.toBeNull();
    expect(repo.getSessionById("s-loaded", DEFAULT_AGENT_SERVER)).toBe(session);
    expect(isLoading(session!.loadState)).toBe(true);
    await expect(load).resolves.toBe(session);
    expect(session!.sessionInfo).toMatchObject({ sessionId: "s-loaded", title: "Loaded" });
    expect(session!.events).toHaveLength(1);
    expect(isSuccess(session!.loadState)).toBe(true);
  });

  it("promotes a replayed inline Devin title over the seeded title", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      loadSession: vi.fn(async ({ sessionId }: { sessionId: string }) => {
        repo.handleSessionUpdate(
          "devin",
          sessionNotification("title: Better title\n\nReplayed reply", sessionId),
        );
        return {};
      }),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-devin",
      "/repo",
      [],
      { title: "Initial prompt", conversationId: "conv-devin" },
      "devin",
    );

    expect(session?.sessionInfo?.title).toBe("Better title");
    expect(session?.buildLoadState().sessionInfo?.title).toBe("Better title");
    expect(session?.events).toEqual([
      expect.objectContaining({
        eventKind: "agent_message",
        content: [{ type: "text", text: "Replayed reply" }],
      }),
    ]);
  });

  it("hydrates frozen cross-agent legs before replaying the active session", async () => {
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("getConversationHistory")) {
        return {
          legs: [
            {
              handoffId: "handoff-1",
              ordinal: 0,
              agentServer: "codex-acp",
              sessionId: "source-session",
              targetAgentServer: DEFAULT_AGENT_SERVER,
              targetSessionId: "target-session",
              schemaVersion: 1,
              createdAt: "2026-07-16T10:02:00.000Z",
              events: [
                {
                  eventKind: "user_message",
                  messageId: null,
                  content: [{ type: "text", text: "source question" }],
                },
                {
                  eventKind: "agent_message",
                  messageId: null,
                  content: [{ type: "text", text: "source answer" }],
                },
              ],
              turns: [
                {
                  startedAt: "2026-07-16T10:00:00.000Z",
                  endedAt: "2026-07-16T10:01:00.000Z",
                  startIndex: 0,
                  endIndex: 1,
                },
              ],
              plan: null,
            },
          ],
        };
      }
      return {};
    });
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      loadSession: vi.fn(async () => {
        repo.handleSessionUpdate(
          DEFAULT_AGENT_SERVER,
          sessionNotification("active agent replay", "target-session"),
        );
        return {};
      }),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "target-session",
      "/repo",
      [],
      { conversationId: "conv-handed-off" },
      DEFAULT_AGENT_SERVER,
    );

    expect(session?.events.map((event) => event.eventKind)).toEqual([
      "user_message",
      "agent_message",
      "handoff",
      "agent_message",
    ]);
    expect(session?.events.at(-1)).toEqual(
      expect.objectContaining({
        eventKind: "agent_message",
        content: [{ type: "text", text: "active agent replay" }],
      }),
    );
    expect(session?.turns).toEqual([expect.objectContaining({ startIndex: 0, endIndex: 1 })]);
    expect(helperJsonrpcCall).toHaveBeenCalledWith(
      expect.stringContaining("getConversationHistory"),
      { conversationId: "conv-handed-off" },
    );
  });

  it("publishes replay updates that arrive after session/load resolves", async () => {
    const repo = new ACPSessionRepositoryWriter();
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("acpNav/list")) {
        return {
          projects: [],
          conversations: [
            {
              id: "conv-loaded",
              workspacePath: "/repo",
              agentServer: DEFAULT_AGENT_SERVER,
              sessionId: "s-loaded",
              cwd: "/repo",
              active: true,
              archived: false,
              workingDirectories: ["/repo"],
              metadata: {
                processes: [],
                explored: [],
                edited: [],
                sessionConfig: { selections: { model: "model-b" } },
              },
            },
          ],
        };
      }
      return {};
    });

    const configOptions = [
      {
        id: "model",
        type: "select" as const,
        name: "Model",
        currentValue: "model-a",
        options: [
          { value: "model-a", name: "A" },
          { value: "model-b", name: "B" },
        ],
      },
    ];
    let resolveConfig!: (value: { configOptions: typeof configOptions }) => void;
    const setConfig = new Promise<{ configOptions: typeof configOptions }>((resolve) => {
      resolveConfig = resolve;
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({ configOptions }),
      setSessionConfigOption: vi.fn().mockReturnValue(setConfig),
    });
    await connectRepo(repo, conn);

    const load = repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-loaded" },
      DEFAULT_AGENT_SERVER,
    );
    await vi.waitFor(() => {
      expect(conn.setSessionConfigOption).toHaveBeenCalled();
    });

    // Native helper batching can deliver this replay update after the load
    // response, while persisted config restoration is still in flight.
    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, sessionNotification("delayed replay"));
    resolveConfig({
      configOptions: [{ ...configOptions[0]!, currentValue: "model-b" }],
    });

    const session = await load;
    expect(session?.events).toEqual([
      expect.objectContaining({
        eventKind: "agent_message",
        content: [{ type: "text", text: "delayed replay" }],
      }),
    ]);
  });

  it("syncs backend mode updates into ACP session plan mode state", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "mode",
            type: "select" as const,
            name: "Mode",
            options: [
              { label: "Default", value: "default" },
              { label: "Plan", value: "plan" },
            ],
            currentValue: "default",
          },
        ],
        modes: null,
      }),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-loaded" },
      DEFAULT_AGENT_SERVER,
    );
    expect(session?.isPlanModeActive).toBe(false);

    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, {
      sessionId: "s-loaded",
      update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
    } as SessionNotification);

    expect(session?.currentModeId).toBe("plan");
    expect(session?.isPlanModeActive).toBe(true);
    // Plan-as-permission-mode keeps the banner, not the collaboration chip.
    expect(session?.planModeViaCollaboration).toBe(false);
    expect(session?.configOptions).toEqual([
      expect.objectContaining({ id: "mode", currentValue: "plan" }),
    ]);
  });

  it("reads and toggles plan mode on the collaboration option that owns it", async () => {
    const repo = new ACPSessionRepositoryWriter();
    // Agents that separate the two leave only approval policies on `mode`, so
    // plan has to be read from — and written to — the collaboration option.
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "mode",
            type: "select" as const,
            name: "Mode",
            category: "mode",
            options: [
              { value: "default", name: "Always ask" },
              { value: "always-allow", name: "Allow all" },
            ],
            currentValue: "default",
          },
          {
            id: "agent_mode",
            type: "select" as const,
            name: "Agent mode",
            category: "collaboration_mode",
            options: [
              { value: "build", name: "Build" },
              { value: "plan", name: "Plan" },
            ],
            currentValue: "plan",
          },
        ],
        modes: null,
      }),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-loaded" },
      DEFAULT_AGENT_SERVER,
    );
    expect(session?.canTogglePlanMode).toBe(true);
    expect(session?.isPlanModeActive).toBe(true);
    // Two values, one of them plan: drives the compact plan chip and /plan
    // rather than the plan banner or a picker.
    expect(session?.planModeViaCollaboration).toBe(true);
    expect(session?.collaborationModeSurface).toBe("plan-toggle");
    // The approval option is untouched by the plan state.
    expect(session?.currentModeId).toBe("default");

    await session?.togglePlanMode();

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-loaded",
      configId: "agent_mode",
      value: "build",
    });
    expect(session?.isPlanModeActive).toBe(false);
  });

  it("toggles a category-less collaboration option with an opaque Plan value", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "collaboration_mode",
            type: "select" as const,
            name: "Collaboration mode",
            options: [
              { value: "planning", name: "Plan" },
              { value: "building", name: "Build" },
            ],
            currentValue: "building",
          },
        ],
        modes: null,
      }),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-loaded" },
      DEFAULT_AGENT_SERVER,
    );

    expect(session?.collaborationModeSurface).toBe("plan-toggle");
    expect(session?.canTogglePlanMode).toBe(true);
    expect(session?.isPlanModeActive).toBe(false);

    await session?.togglePlanMode();

    expect(conn.setSessionConfigOption).toHaveBeenLastCalledWith({
      sessionId: "s-loaded",
      configId: "collaboration_mode",
      value: "planning",
    });
    expect(session?.isPlanModeActive).toBe(true);

    await session?.togglePlanMode();

    expect(conn.setSessionConfigOption).toHaveBeenLastCalledWith({
      sessionId: "s-loaded",
      configId: "collaboration_mode",
      value: "building",
    });
    expect(session?.isPlanModeActive).toBe(false);
  });

  it("asks for a picker when the collaboration option offers a third mode", async () => {
    const repo = new ACPSessionRepositoryWriter();
    // A toggle could never reach "review", so the option keeps a full picker
    // instead of riding on /plan and the plan chip.
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "collaboration_mode",
            type: "select" as const,
            name: "Collaboration mode",
            category: "collaboration_mode",
            options: [
              { value: "default", name: "Default" },
              { value: "plan", name: "Plan" },
              { value: "review", name: "Review" },
            ],
            currentValue: "plan",
          },
        ],
        modes: null,
      }),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-loaded" },
      DEFAULT_AGENT_SERVER,
    );

    expect(session?.collaborationModeSurface).toBe("picker");
    // Plan still reads and toggles through the same option; only the surface
    // differs, and the banner stays suppressed either way.
    expect(session?.isPlanModeActive).toBe(true);
    expect(session?.planModeViaCollaboration).toBe(true);
  });

  it("keeps backend mode updates scoped to their ACP session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [],
        modes: { currentModeId: "default", availableModes: [{ id: "plan", name: "Plan" }] },
      }),
    });
    await connectRepo(repo, conn);

    const first = await repo.loadSessionRecord(
      "s-first",
      "/repo/a",
      [],
      { conversationId: "conv-first" },
      DEFAULT_AGENT_SERVER,
    );
    const second = await repo.loadSessionRecord(
      "s-second",
      "/repo/b",
      [],
      { conversationId: "conv-second" },
      DEFAULT_AGENT_SERVER,
    );

    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, {
      sessionId: "s-first",
      update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
    } as SessionNotification);

    expect(first?.isPlanModeActive).toBe(true);
    expect(second?.currentModeId).toBe("default");
    expect(second?.isPlanModeActive).toBe(false);
  });

  it("promotes a session on first send and emits session:new", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    const listener = vi.fn();
    repo.emitter.addEventListener(ACP_SESSION_NEW_EVENT, listener);

    const created = await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(created).toBe("s-new");
    expect(session.sessionId).toBe("s-new");
    expect(repo.getSessionByConversationId("conv-1")).toBe(session);
    expect(session.conversationId).toBe("conv-1");
    expect(conn.newSession).toHaveBeenCalledWith({
      cwd: "/repo",
      mcpServers: [],
      _meta: {
        // Carried so the helper can bind the nav row to the new session id
        // synchronously at session/new.
        "camber/conversation_id": "conv-1",
        enabled_tools: [],
      },
    });
    expect(conn.prompt).toHaveBeenCalledWith({
      sessionId: "s-new",
      prompt: [textBlock("hello")],
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          sessionId: "s-new",
          conversationId: "conv-1",
        }),
      }),
    );
  });

  it("opts Claude sessions into native prompt suggestions", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", "claude-acp", "conv-claude");

    await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(conn.newSession).toHaveBeenCalledWith({
      cwd: "/repo",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: { promptSuggestions: true },
          emitRawSDKMessages: [{ type: "prompt_suggestion" }, { type: "active_goal" }],
        },
        "camber/conversation_id": "conv-claude",
        enabled_tools: [],
      },
    });
  });

  it("stores a Claude prompt suggestion ephemerally on its session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = repo.createSession("/repo", "claude-acp", "conv-claude");
    session.sessionId = "s-claude";

    repo.handlePromptSuggestion("claude-acp", {
      id: "suggestion-1",
      sessionId: "s-claude",
      text: "Run the focused tests",
    });

    expect(session.promptSuggestion?.text).toBe("Run the focused tests");

    repo.handleSessionUpdate("claude-acp", sessionNotification("Starting", "s-claude"));

    expect(session.promptSuggestion).toBeNull();
  });

  it("stores and clears Claude's native goal update on its session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection(), undefined, "claude-acp");
    const session = repo.createSession("/repo", "claude-acp", "conv-claude");
    session.sessionId = "s-claude";

    repo.handleGoalUpdate("claude-acp", {
      sessionId: "s-claude",
      goal: {
        source: "claude",
        objective: "Get the branch ready",
        status: "active",
        iterations: 2,
      },
    });

    expect(session.goal).toMatchObject({
      source: "claude",
      objective: "Get the branch ready",
      iterations: 2,
    });

    repo.handleGoalUpdate("claude-acp", { sessionId: "s-claude", goal: null });
    expect(session.goal).toBeNull();
  });

  it("applies Codex goal snapshots without clearing them on unrelated info updates", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection(), undefined, "codex-acp");
    const session = repo.createSession("/repo", "codex-acp", "conv-codex");
    session.sessionId = "s-codex";

    repo.handleSessionUpdate("codex-acp", {
      sessionId: "s-codex",
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          codex: {
            goal: {
              objective: "Land the release",
              status: "active",
              controlMethod: "_codex/session/goal_control",
            },
          },
        },
      },
    } as SessionNotification);
    expect(session.goal).toMatchObject({
      source: "codex",
      objective: "Land the release",
      status: "active",
    });

    repo.handleSessionUpdate("codex-acp", {
      sessionId: "s-codex",
      update: { sessionUpdate: "session_info_update", title: "Release work" },
    } as SessionNotification);
    expect(session.goal?.objective).toBe("Land the release");

    repo.handleSessionUpdate("codex-acp", {
      sessionId: "s-codex",
      update: {
        sessionUpdate: "session_info_update",
        _meta: { codex: { goal: null } },
      },
    } as SessionNotification);
    expect(session.goal).toBeNull();
  });

  it("pauses and clears Codex goals through their native control extension", async () => {
    const request = vi.fn().mockResolvedValue({});
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ request }), undefined, "codex-acp");
    const session = repo.createSession("/repo", "codex-acp", "conv-codex");
    session.sessionId = "s-codex";
    session.goal = {
      source: "codex",
      objective: "Land the release",
      status: "active",
      controlMethod: "_codex/session/goal_control",
    };

    await session.pauseGoal();
    await session.clearGoal();

    expect(request).toHaveBeenNthCalledWith(1, "_codex/session/goal_control", {
      sessionId: "s-codex",
      action: "pause",
    });
    expect(request).toHaveBeenNthCalledWith(2, "_codex/session/goal_control", {
      sessionId: "s-codex",
      action: "clear",
    });
    expect(session.pendingGoalAction).toBeNull();
  });

  it("clears an in-flight goal action when the agent exits", async () => {
    let rejectRequest!: (error: Error) => void;
    const request = vi.fn(
      () =>
        new Promise<Record<string, never>>((_, reject) => {
          rejectRequest = reject;
        }),
    );
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ request }), undefined, "codex-acp");
    const session = repo.createSession("/repo", "codex-acp", "conv-codex");
    session.sessionId = "s-codex";
    session.goal = {
      source: "codex",
      objective: "Land the release",
      status: "active",
      controlMethod: "_codex/session/goal_control",
    };

    const pauseResult = session.pauseGoal().catch((error: unknown) => error);
    await vi.waitFor(() => expect(session.pendingGoalAction).toBe("pause"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    repo.handleAgentServerDidExit("codex-acp");
    expect(session.pendingGoalAction).toBeNull();
    expect(session.goal).toBeNull();

    rejectRequest(new Error("agent exited"));
    expect(await pauseResult).toBeInstanceOf(Error);
    expect(session.pendingGoalAction).toBeNull();

    session.setGoal({
      source: "codex",
      objective: "Land the release",
      status: "active",
      controlMethod: "_codex/session/goal_control",
    });
    expect(session.pendingGoalAction).toBeNull();
  });

  it("uses goal commands to resume Codex and clear Claude", async () => {
    const codexPrompt = vi
      .fn()
      .mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse);
    const codexRepo = new ACPSessionRepositoryWriter();
    await connectRepo(codexRepo, mockConnection({ prompt: codexPrompt }), undefined, "codex-acp");
    const codex = codexRepo.createSession("/repo", "codex-acp", "conv-codex");
    codex.sessionId = "s-codex";
    codex.sessionInfo = buildSessionInfo("s-codex", "/repo", "native_session");
    codex.goal = {
      source: "codex",
      objective: "Land the release",
      status: "paused",
      controlMethod: "_codex/session/goal_control",
    };

    await codex.resumeGoal();
    expect(codexPrompt).toHaveBeenCalledWith({
      sessionId: "s-codex",
      prompt: [textBlock("/goal resume")],
    });

    const claudePrompt = vi
      .fn()
      .mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse);
    const claudeRepo = new ACPSessionRepositoryWriter();
    await connectRepo(
      claudeRepo,
      mockConnection({ prompt: claudePrompt }),
      undefined,
      "claude-acp",
    );
    const claude = claudeRepo.createSession("/repo", "claude-acp", "conv-claude");
    claude.sessionId = "s-claude";
    claude.sessionInfo = buildSessionInfo("s-claude", "/repo", "native_session");
    claude.goal = {
      source: "claude",
      objective: "Prepare the branch",
      status: "active",
    };

    await claude.clearGoal();
    expect(claudePrompt).toHaveBeenCalledWith({
      sessionId: "s-claude",
      prompt: [textBlock("/goal clear")],
    });
    expect(claude.goal).toBeNull();
  });

  it("mirrors a Claude goal while its native command is active", async () => {
    let resolveGoalPrompt!: (response: PromptResponse) => void;
    const prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PromptResponse>((resolve) => {
            resolveGoalPrompt = resolve;
          }),
      )
      .mockResolvedValueOnce({ stopReason: "end_turn" } satisfies PromptResponse);
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt }), undefined, "claude-acp");
    const session = repo.createSession("/repo", "claude-acp", "conv-claude-goal");

    const sendGoal = session.serialize((gen) =>
      session.sendCore(gen, "/goal Land the release", undefined),
    );
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());

    expect(session.goal).toEqual({
      source: "claude",
      objective: "Land the release",
      status: "active",
    });

    resolveGoalPrompt({ stopReason: "cancelled" });
    await sendGoal;
    expect(session.goal?.objective).toBe("Land the release");

    await session.prompt("Finish the release");
    expect(session.goal).toBeNull();
  });

  it("keeps native Claude prompt suggestions enabled when loading a session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    await connectRepo(repo, conn);

    await repo.loadSessionRecord(
      "s-claude",
      "/repo",
      [],
      { conversationId: "conv-claude" },
      "claude-acp",
    );

    expect(conn.loadSession).toHaveBeenCalledWith({
      sessionId: "s-claude",
      cwd: "/repo",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: { promptSuggestions: true },
          emitRawSDKMessages: [{ type: "prompt_suggestion" }, { type: "active_goal" }],
        },
      },
    });
  });

  it("keeps native prompt suggestions enabled when loading an aliased Claude session", async () => {
    const repo = new ACPSessionRepositoryWriter(
      undefined,
      undefined,
      (agentServer) => agentServer === "my-claude",
    );
    const conn = mockConnection();
    await connectRepo(repo, conn, undefined, "my-claude");

    await repo.loadSessionRecord(
      "s-claude",
      "/repo",
      [],
      { conversationId: "conv-claude" },
      "my-claude",
    );

    expect(conn.loadSession).toHaveBeenCalledWith({
      sessionId: "s-claude",
      cwd: "/repo",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: { promptSuggestions: true },
          emitRawSDKMessages: [{ type: "prompt_suggestion" }, { type: "active_goal" }],
        },
      },
    });
  });

  it("keeps native prompt suggestions enabled when resuming an aliased Claude session", async () => {
    const repo = new ACPSessionRepositoryWriter(
      undefined,
      undefined,
      (agentServer) => agentServer === "my-claude",
    );
    const conn = mockConnection();
    await connectRepo(
      repo,
      conn,
      {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
        },
      } as InitializeResponse,
      "my-claude",
    );
    const session = await repo.loadSessionRecord(
      "s-claude",
      "/repo",
      [],
      { conversationId: "conv-claude" },
      "my-claude",
    );
    expect(session).not.toBeNull();
    vi.mocked(conn.resumeSession).mockClear();

    await session!.serialize((gen) => session!.refreshMCPServers(gen));

    expect(conn.resumeSession).toHaveBeenCalledWith({
      sessionId: "s-claude",
      cwd: "/repo",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: { promptSuggestions: true },
          emitRawSDKMessages: [{ type: "prompt_suggestion" }, { type: "active_goal" }],
        },
      },
    });
  });

  it("surfaces a config-apply failure as a prompt error and still announces the session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      newSession: vi.fn().mockResolvedValue({
        sessionId: "s-new",
        configOptions: [
          {
            id: "model",
            type: "select" as const,
            name: "Model",
            category: "model",
            options: [
              { name: "model-a", value: "model-a" },
              { name: "model-b", value: "model-b" },
            ],
            currentValue: "model-b",
          },
        ],
      }),
      setSessionConfigOption: vi.fn().mockRejectedValue(new Error("cannot load model model-a")),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", "local", "conv-1");
    // Draft has selected model-a; the agent session comes up on model-b, so
    // sending applies the selection via setSessionConfigOption (which fails).
    session.configOptions = [
      {
        id: "model",
        type: "select" as const,
        name: "Model",
        category: "model",
        options: [
          { name: "model-a", value: "model-a" },
          { name: "model-b", value: "model-b" },
        ],
        currentValue: "model-a",
      },
    ];
    const listener = vi.fn();
    repo.emitter.addEventListener(ACP_SESSION_NEW_EVENT, listener);

    const created = await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(created).toBeNull();
    // The session was created and announced before the failing config step.
    expect(session.sessionId).toBe("s-new");
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ sessionId: "s-new", conversationId: "conv-1" }),
      }),
    );
    // The failure is visible instead of an unhandled rejection.
    expect(session.promptError?.prompt).toBe("hello");
    expect(session.promptError?.error.message).toContain("cannot load model model-a");
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-new",
      configId: "model",
      value: "model-a",
    });
    // We bailed before prompting and left the session idle.
    expect(conn.prompt).not.toHaveBeenCalled();
    expect(session.isSending).toBe(false);
    expect(session.setupStatus).toBeNull();
  });

  it("keeps the draft's model selection visible while the first prompt applies it", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const modelOption = (currentValue: string) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: [
        { name: "model-a", value: "model-a" },
        { name: "model-b", value: "model-b" },
      ],
      currentValue,
    });
    let resolveSet: (value: unknown) => void = () => {};
    const conn = mockConnection({
      newSession: vi.fn().mockResolvedValue({
        sessionId: "s-new",
        configOptions: [modelOption("model-b")],
      }),
      setSessionConfigOption: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSet = resolve;
          }),
      ),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.configOptions = [modelOption("model-a")];

    const send = session.serialize((gen) => session.sendCore(gen, "hello", undefined));
    await vi.waitFor(() => expect(conn.setSessionConfigOption).toHaveBeenCalled());
    // The session/new response carried the agent default (model-b); the picker
    // must keep showing the draft's selection while it is re-applied.
    expect(session.configOptions).toEqual([modelOption("model-a")]);
    resolveSet({});
    await send;

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-new",
      configId: "model",
      value: "model-a",
    });
    expect(session.configOptions).toEqual([modelOption("model-a")]);
    expect(conn.prompt).toHaveBeenCalledWith({
      sessionId: "s-new",
      prompt: [textBlock("hello")],
    });
  });

  it("preserves discovered local models across bootstrap, later changes, and resume", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const gemma = "mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit";
    const laguna = "poolside/Laguna-S-2.1-NVFP4-mlx";
    const modelOption = (currentValue: string, values: string[]) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: values.map((value) => ({ name: value, value })),
      currentValue,
    });
    const conn = mockConnection({
      newSession: vi.fn().mockResolvedValue({
        sessionId: "s-new",
        // The standalone local agent advertises only the model from its
        // bootstrap environment even though the helper catalog knows both.
        configOptions: [modelOption(gemma, [gemma])],
      }),
      resumeSession: vi.fn().mockResolvedValue({
        configOptions: [modelOption(gemma, [gemma])],
      }),
      setSessionConfigOption: vi.fn().mockImplementation(({ value }: { value: string }) =>
        Promise.resolve({
          // Its mutation response can be narrow too; the picker must keep the
          // helper catalog after the selected model has been applied.
          configOptions: [modelOption(value, [value])],
        }),
      ),
    });
    await connectRepo(
      repo,
      conn,
      {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {} },
        },
      } as InitializeResponse,
      "local",
    );
    repo.agents.configCacheByAgentServer = {
      local: {
        agentServer: "local",
        configOptions: [modelOption(laguna, [gemma, laguna])],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: new Date().toISOString(),
      },
    };
    const session = repo.createSession("/repo", "local", "conv-1");

    await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-new",
      configId: "model",
      value: laguna,
    });
    expect(session.configOptions).toEqual([modelOption(laguna, [gemma, laguna])]);
    expect(conn.prompt).toHaveBeenCalledWith({
      sessionId: "s-new",
      prompt: [textBlock("hello")],
    });

    await session.setConfigOption("model", gemma);
    expect(session.configOptions).toEqual([modelOption(gemma, [gemma, laguna])]);
    await session.setConfigOption("model", laguna);
    expect(session.configOptions).toEqual([modelOption(laguna, [gemma, laguna])]);

    vi.mocked(conn.setSessionConfigOption).mockClear();
    await repo.refreshMCPServersForAllSessions();

    expect(conn.resumeSession).toHaveBeenCalled();
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-new",
      configId: "model",
      value: laguna,
    });
    expect(session.configOptions).toEqual([modelOption(laguna, [gemma, laguna])]);
  });

  it("preserves a discovered local model when the config probe finishes before first send", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const gemma = "mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit";
    const laguna = "poolside/Laguna-S-2.1-NVFP4-mlx";
    const modelOption = (currentValue: string, values: string[]) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: values.map((value) => ({ name: value, value })),
      currentValue,
    });
    const newSession = vi.fn(async (params: { _meta?: Record<string, unknown> | null }) =>
      params._meta?.["camber/configProbe"]
        ? { sessionId: "s-probe", configOptions: [modelOption(gemma, [gemma])] }
        : { sessionId: "s-new", configOptions: [modelOption(gemma, [gemma])] },
    );
    const conn = mockConnection({
      newSession: newSession as unknown as ClientSideConnection["newSession"],
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [modelOption(laguna, [laguna])],
      }),
    });
    await connectRepo(repo, conn, undefined, "local");
    repo.agents.configCacheByAgentServer = {
      local: {
        agentServer: "local",
        configOptions: [modelOption(laguna, [gemma, laguna])],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: new Date().toISOString(),
      },
    };

    const session = repo.createSession("/repo", "local", "conv-1");
    await vi.waitFor(() =>
      expect(newSession).toHaveBeenCalledWith(
        expect.objectContaining({ _meta: { "camber/configProbe": true } }),
      ),
    );
    await vi.waitFor(() =>
      expect(session.configOptions).toEqual([modelOption(laguna, [gemma, laguna])]),
    );

    repo.handleSessionUpdate("local", {
      sessionId: "s-probe",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption(gemma, [gemma])],
      },
    } as SessionNotification);
    expect(session.configOptions).toEqual([modelOption(laguna, [gemma, laguna])]);

    await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-new",
      configId: "model",
      value: laguna,
    });
    expect(session.configOptions).toEqual([modelOption(laguna, [gemma, laguna])]);
    expect(conn.prompt).toHaveBeenCalled();
  });

  it("applies a discovered local model when bootstrap options omit the model", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const gemma = "mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit";
    const laguna = "poolside/Laguna-S-2.1-NVFP4-mlx";
    const modelOption = (currentValue: string, values: string[]) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: values.map((value) => ({ name: value, value })),
      currentValue,
    });
    const conn = mockConnection({
      newSession: vi.fn().mockResolvedValue({ sessionId: "s-new" }),
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [modelOption(laguna, [laguna])],
      }),
    });
    await connectRepo(repo, conn, undefined, "local");
    repo.agents.configCacheByAgentServer = {
      local: {
        agentServer: "local",
        configOptions: [modelOption(laguna, [gemma, laguna])],
        availableCommands: [],
        modes: null,
        promptCapabilities: null,
        agentInfo: null,
        cachedAt: new Date().toISOString(),
      },
    };
    const session = repo.createSession("/repo", "local", "conv-1");

    await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-new",
      configId: "model",
      value: laguna,
    });
    expect(session.configOptions).toEqual([modelOption(laguna, [gemma, laguna])]);
    expect(conn.prompt).toHaveBeenCalled();
  });

  it("folds the failed draft into the next send when session creation errored", async () => {
    const repo = new ACPSessionRepositoryWriter();
    // Background config probes also call newSession; fail only the first real
    // session creation so the probe cannot consume the queued failure.
    let failedRealSessionOnce = false;
    const conn = mockConnection({
      newSession: vi.fn(async (params: { _meta?: Record<string, unknown> | null }) => {
        if (params._meta?.["camber/configProbe"]) return { sessionId: "s-probe" };
        if (!failedRealSessionOnce) {
          failedRealSessionOnce = true;
          throw new Error("agent failed to start");
        }
        return { sessionId: "s-new" };
      }) as unknown as ClientSideConnection["newSession"],
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");

    const failed = await session.serialize((gen) =>
      session.sendCore(gen, "original longer message", undefined),
    );
    expect(failed).toBeNull();
    expect(session.sessionId).toBeNull();
    expect(session.pendingDraftSend?.text).toBe("original longer message");

    const created = await session.serialize((gen) => session.sendCore(gen, "go", undefined));

    expect(created).toBe("s-new");
    // The original message reaches the agent ahead of the follow-up prompt.
    expect(conn.prompt).toHaveBeenCalledTimes(1);
    expect(conn.prompt).toHaveBeenCalledWith({
      sessionId: "s-new",
      prompt: [textBlock("original longer message"), textBlock("go")],
    });
    expect(session.pendingDraftSend).toBeNull();
    // The transcript keeps both user messages without duplicating either.
    expect(session.events.filter((event) => event.eventKind === "user_message")).toEqual([
      expect.objectContaining({ content: [textBlock("original longer message")] }),
      expect.objectContaining({ content: [textBlock("go")] }),
    ]);
  });

  it("folds an errored first prompt into the next send", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      prompt: vi
        .fn()
        .mockRejectedValueOnce(new Error("model overloaded"))
        .mockResolvedValueOnce({ stopReason: "end_turn" } satisfies PromptResponse),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");

    await session.serialize((gen) => session.sendCore(gen, "original longer message", undefined));
    expect(session.promptError?.prompt).toBe("original longer message");

    await session.serialize((gen) => session.sendCore(gen, "go", undefined));

    // The errored prompt never reached the agent, so it rides along with the
    // next prompt instead of being silently dropped.
    expect(conn.prompt).toHaveBeenLastCalledWith({
      sessionId: "s-new",
      prompt: [textBlock("original longer message"), textBlock("go")],
    });
    expect(session.promptError).toBeNull();
    expect(session.events.filter((event) => event.eventKind === "user_message")).toEqual([
      expect.objectContaining({ content: [textBlock("original longer message")] }),
      expect.objectContaining({ content: [textBlock("go")] }),
    ]);
  });

  it("keeps the original prompt when the user reprompts after a config-apply failure", async () => {
    const modelOptions = (currentValue: string) => [
      {
        id: "model",
        type: "select" as const,
        name: "Model",
        category: "model" as const,
        options: [
          { name: "model-a", value: "model-a" },
          { name: "model-b", value: "model-b" },
        ],
        currentValue,
      },
    ];
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      newSession: vi.fn().mockResolvedValue({
        sessionId: "s-new",
        configOptions: modelOptions("model-b"),
      }),
      setSessionConfigOption: vi
        .fn()
        .mockRejectedValueOnce(new Error("cannot load model model-a"))
        .mockResolvedValue({ configOptions: modelOptions("model-b") }),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.configOptions = modelOptions("model-a");

    // First send creates the session but fails applying the drafted model.
    await session.serialize((gen) => session.sendCore(gen, "original longer message", undefined));
    expect(session.promptError?.prompt).toBe("original longer message");
    expect(conn.prompt).not.toHaveBeenCalled();

    // The user switches model and prompts again instead of pressing retry.
    await session.setConfigOption("model", "model-b");
    await session.serialize((gen) => session.sendCore(gen, "go", undefined));

    expect(conn.prompt).toHaveBeenCalledTimes(1);
    expect(conn.prompt).toHaveBeenCalledWith({
      sessionId: "s-new",
      prompt: [textBlock("original longer message"), textBlock("go")],
    });
    expect(session.promptError).toBeNull();
  });

  it("sends host context with project guidelines for agent on the first desktop prompt", async () => {
    const initialAppState = get(appState);
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    helperJsonrpcCall.mockImplementation(async (method: string) => {
      if (method === "camber/acpNav/getProjectSettings") {
        return {
          settings: {
            path: "/repo",
            setupScript: "",
            teardownScript: "",
            userPrompt: "Always reply like a pirate.",
          },
        };
      }
      return { entry: null };
    });
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        promptCapabilities: { embeddedContext: true },
      },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");

    try {
      appState.update((state) => ({
        ...state,
        environment: {
          ...state.environment,
          assistantHost: "desktop",
          assistantVersion: "4.3.8",
        },
      }));

      await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

      expect(helperJsonrpcCall).toHaveBeenCalledWith("camber/acpNav/getProjectSettings", {
        path: "/repo",
      });
      expect(conn.prompt).toHaveBeenCalledWith({
        sessionId: "s-new",
        prompt: [
          textBlock("hello"),
          expect.objectContaining({
            type: "resource",
            resource: expect.objectContaining({
              uri: HOST_CONTEXT_RESOURCE_URI,
              mimeType: "text/markdown",
              text: expect.stringContaining("Camber Assistant version: 4.3.8"),
            }),
          }),
        ],
      });
      const prompt = vi.mocked(conn.prompt).mock.calls[0]?.[0].prompt ?? [];
      const hostContext = prompt[1] as { resource?: { text?: string } };
      expect(hostContext.resource?.text).toContain("<camber-system-instructions>");
      expect(hostContext.resource?.text).toContain(
        "<project-instructions>\nAlways reply like a pirate.\n</project-instructions>",
      );
      expect(session.events).toEqual([
        expect.objectContaining({
          eventKind: "user_message",
          content: [{ type: "text", text: "hello" }],
        }),
      ]);
    } finally {
      appState.set(initialAppState);
    }
  });

  it("keeps a first-turn Claude slash command standalone", async () => {
    const initialAppState = get(appState);
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    helperJsonrpcCall.mockImplementation(async (method: string) => {
      if (method === "camber/acpNav/getProjectSettings") {
        return {
          settings: {
            path: "/repo",
            setupScript: "",
            teardownScript: "",
            userPrompt: "Always reply like a pirate.",
          },
        };
      }
      return { entry: null };
    });
    await connectRepo(
      repo,
      conn,
      {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          promptCapabilities: { embeddedContext: true },
        },
      } as InitializeResponse,
      "claude-acp",
    );
    const session = repo.createSession("/repo", "claude-acp", "conv-claude");

    try {
      appState.update((state) => ({
        ...state,
        environment: {
          ...state.environment,
          assistantHost: "desktop",
          assistantVersion: "4.3.8",
        },
      }));

      await session.serialize((gen) =>
        session.sendCore(gen, "/goal Finish the migration", undefined),
      );

      expect(conn.prompt).toHaveBeenCalledWith({
        sessionId: "s-new",
        prompt: [textBlock("/goal Finish the migration")],
      });
      expect(conn.newSession).toHaveBeenCalledWith(
        expect.objectContaining({
          _meta: expect.objectContaining({
            claudeCode: expect.objectContaining({
              options: expect.objectContaining({
                promptSuggestions: true,
                appendSystemPrompt: expect.stringContaining("Camber Assistant version: 4.3.8"),
              }),
            }),
          }),
        }),
      );
      const sessionMeta = vi.mocked(conn.newSession).mock.calls[0]?.[0]._meta as {
        claudeCode?: { options?: { appendSystemPrompt?: string } };
      };
      expect(sessionMeta.claudeCode?.options?.appendSystemPrompt).toContain(
        "<project-instructions>\nAlways reply like a pirate.\n</project-instructions>",
      );
    } finally {
      appState.set(initialAppState);
    }
  });

  it("hides host context blocks when reconstructing user messages", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");

    session.addUserMessage([
      { type: "text", text: "hello" },
      hostContextBlock({
        assistantVersion: "4.3.8",
        userPrompt: "Always reply like a pirate.",
      }),
    ]);

    expect(session.events).toEqual([
      expect.objectContaining({
        eventKind: "user_message",
        content: [{ type: "text", text: "hello" }],
      }),
    ]);
  });

  it("does not send host context when embedded context is unsupported", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        promptCapabilities: { embeddedContext: false },
      },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");

    await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(conn.prompt).toHaveBeenCalledWith({
      sessionId: "s-new",
      prompt: [textBlock("hello")],
    });
    expect(helperJsonrpcCall).not.toHaveBeenCalledWith("camber/acpNav/getProjectSettings", {
      path: "/repo",
    });
  });

  it("does not resend host context after the first prompt", async () => {
    const initialAppState = get(appState);
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    helperJsonrpcCall.mockResolvedValue({
      settings: { path: "/repo", setupScript: "", teardownScript: "", userPrompt: "" },
    });
    await connectRepo(repo, conn, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        promptCapabilities: { embeddedContext: true },
      },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");

    try {
      appState.update((state) => ({
        ...state,
        environment: {
          ...state.environment,
          assistantHost: "desktop",
        },
      }));

      await session.serialize((gen) => session.sendCore(gen, "hello", undefined));
      await session.prompt("again");

      expect(conn.prompt).toHaveBeenLastCalledWith({
        sessionId: "s-new",
        prompt: [textBlock("again")],
      });
    } finally {
      appState.set(initialAppState);
    }
  });

  it("shows agent auth when first send fails with a nested 401", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      newSession: vi.fn().mockRejectedValue(
        new ACPError({
          code: -32603,
          message: "Internal error",
          data: { error: "starting conversation: API request failed with status 401" },
        }),
      ),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", "claude-acp", "conv-1");

    const created = await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(created).toBeNull();
    expect(repo.agents.authRequiredForAgent("claude-acp")).toBe(true);
    expect(session.sessionId).toBeNull();
    expect(session.promptError).toBeNull();
    expect(conn.prompt).not.toHaveBeenCalled();
  });

  it("shows agent auth when a prompt fails with a 401 Error", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      prompt: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Internal error: Failed to authenticate. API Error: 401 Invalid authentication credentials",
          ),
        ),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", "claude-acp", "conv-1");
    session.sessionId = "s-existing";

    await session.prompt("hello");

    expect(repo.agents.authRequiredForAgent("claude-acp")).toBe(true);
    expect(session.promptError).toBeNull();
    expect(conn.prompt).toHaveBeenCalledWith({
      sessionId: "s-existing",
      prompt: [textBlock("hello")],
    });
  });

  it("restores the ACP session before retrying a failed prompt after restarting the agent", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    const restart = vi.fn().mockResolvedValue(undefined);
    repo.agents.setConnectionPool({
      connect: vi.fn().mockResolvedValue({
        conn,
        initializeResponse: {
          protocolVersion: 1,
          authMethods: [],
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { list: {} },
          },
        },
      }),
      restart,
    } as unknown as ACPConnectionPool);
    await repo.agents.connect();
    const session = repo.createSession("/repo", "codex-acp", "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");
    session.promptError = {
      prompt: "hello",
      content: [{ type: "text", text: "hello" }],
      error: new ACPError({ code: -32603, message: "peer disconnected before response" }),
    };

    await session.retryLastPrompt();

    expect(restart).toHaveBeenCalledWith("codex-acp");
    expect(conn.loadSession).toHaveBeenCalledWith({
      sessionId: "s-existing",
      cwd: "/repo",
      mcpServers: [],
    });
    expect(conn.prompt).toHaveBeenCalledWith({
      sessionId: "s-existing",
      prompt: [textBlock("hello")],
    });
  });

  it("reapplies the conversation config after restoring a session on agent restart", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "permission_mode",
            type: "select" as const,
            name: "Approval Preset",
            options: [
              { name: "Default", value: "default" },
              { name: "Full Access", value: "full_access" },
            ],
            currentValue: "default",
          },
        ],
      }),
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "permission_mode",
            type: "select" as const,
            name: "Approval Preset",
            options: [
              { name: "Default", value: "default" },
              { name: "Full Access", value: "full_access" },
            ],
            currentValue: "full_access",
          },
        ],
      }),
    });
    await connectRepo(repo, conn);
    await repo.agents.connectServer("codex-acp");
    const session = repo.createSession("/repo", "codex-acp", "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");
    session.configOptions = [
      {
        id: "permission_mode",
        type: "select" as const,
        name: "Approval Preset",
        options: [
          { name: "Default", value: "default" },
          { name: "Full Access", value: "full_access" },
        ],
        currentValue: "full_access",
      },
    ];
    session.restoreRequired = true;

    await session.serialize(async (gen) => {
      const restored = await session.loader.restoreAfterReconnect(gen, conn);
      expect(restored).toBe(true);
    });

    expect(conn.loadSession).toHaveBeenCalledWith({
      sessionId: "s-existing",
      cwd: "/repo",
      mcpServers: [],
    });
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-existing",
      configId: "permission_mode",
      value: "full_access",
    });
    expect(session.configOptions).toEqual([
      expect.objectContaining({ id: "permission_mode", currentValue: "full_access" }),
    ]);
  });

  it("keeps restart config restoration scoped to the restored session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "permission_mode",
            type: "select" as const,
            name: "Approval Preset",
            options: [
              { name: "Default", value: "default" },
              { name: "Full Access", value: "full_access" },
            ],
            currentValue: "default",
          },
        ],
      }),
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "permission_mode",
            type: "select" as const,
            name: "Approval Preset",
            options: [
              { name: "Default", value: "default" },
              { name: "Full Access", value: "full_access" },
            ],
            currentValue: "full_access",
          },
        ],
      }),
    });
    await connectRepo(repo, conn);
    await repo.agents.connectServer("codex-acp");
    const first = repo.createSession("/repo/a", "codex-acp", "conv-1");
    first.sessionId = "s-first";
    first.sessionInfo = buildSessionInfo("s-first", "/repo/a", "native_session");
    first.configOptions = [
      {
        id: "permission_mode",
        type: "select" as const,
        name: "Approval Preset",
        options: [
          { name: "Default", value: "default" },
          { name: "Full Access", value: "full_access" },
        ],
        currentValue: "full_access",
      },
    ];
    const second = repo.createSession("/repo/b", "codex-acp", "conv-2");
    second.sessionId = "s-second";
    second.sessionInfo = buildSessionInfo("s-second", "/repo/b", "native_session");
    second.configOptions = [
      {
        id: "permission_mode",
        type: "select" as const,
        name: "Approval Preset",
        options: [
          { name: "Default", value: "default" },
          { name: "Full Access", value: "full_access" },
        ],
        currentValue: "default",
      },
    ];
    first.restoreRequired = true;
    second.restoreRequired = true;

    await first.serialize(async (gen) => {
      await first.loader.restoreAfterReconnect(gen, conn);
    });

    expect(conn.setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-first",
      configId: "permission_mode",
      value: "full_access",
    });
    expect(first.configOptions).toEqual([
      expect.objectContaining({ id: "permission_mode", currentValue: "full_access" }),
    ]);
    expect(second.configOptions).toEqual([
      expect.objectContaining({ id: "permission_mode", currentValue: "default" }),
    ]);
  });

  it("reapplies the conversation mode after restoring a session on agent restart", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [],
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
      }),
    });
    await connectRepo(repo, conn);
    await repo.agents.connectServer("codex-acp");
    const session = repo.createSession("/repo", "codex-acp", "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");
    session.modes = {
      currentModeId: "plan",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    };
    session.restoreRequired = true;

    await session.serialize(async (gen) => {
      const restored = await session.loader.restoreAfterReconnect(gen, conn);
      expect(restored).toBe(true);
    });

    expect(conn.setSessionMode).toHaveBeenCalledWith({
      sessionId: "s-existing",
      modeId: "plan",
    });
    expect(session.modes?.currentModeId).toBe("plan");
  });

  it("sends the first prompt of a session created after the agent restarted", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      newSession: vi.fn().mockResolvedValue({ sessionId: "s-fresh" }),
      // Codex only writes a rollout once a turn starts, so loading a session
      // that has never been prompted fails outright.
      loadSession: vi.fn().mockRejectedValue(new Error("no rollout found for thread id s-fresh")),
      prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse),
    });
    await connectRepo(repo, conn);
    await repo.agents.connectServer("codex-acp");
    const existing = repo.createSession("/repo", "codex-acp", "conv-existing");
    existing.sessionId = "s-existing";
    existing.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");

    // Switching away closes idle sessions, which can take the agent process
    // down with them.
    repo.handleAgentServerDidExit("codex-acp");
    expect(existing.restoreRequired).toBe(true);

    // A conversation started afterwards runs on the fresh process and has no
    // agent-side state to restore, so its first prompt must go straight out
    // instead of being swallowed by a doomed session/load.
    const fresh = repo.createSession("/repo", "codex-acp", "conv-fresh");
    await fresh.serialize((gen) => fresh.sendCore(gen, "hello", undefined));

    expect(fresh.restoreRequired).toBe(false);
    expect(conn.loadSession).not.toHaveBeenCalled();
    expect(conn.prompt).toHaveBeenCalledTimes(1);
    expect(fresh.loadState.status).not.toBe("failure");
  });

  it("restores config and retries once when a prompt hits a stale agent session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      prompt: vi
        .fn()
        .mockRejectedValueOnce(new ACPError({ code: -32002, message: "Resource not found" }))
        .mockResolvedValueOnce({ stopReason: "end_turn" } satisfies PromptResponse),
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "permission_mode",
            type: "select" as const,
            name: "Approval Preset",
            options: [
              { name: "Default", value: "default" },
              { name: "Full Access", value: "full_access" },
            ],
            currentValue: "default",
          },
        ],
      }),
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "permission_mode",
            type: "select" as const,
            name: "Approval Preset",
            options: [
              { name: "Default", value: "default" },
              { name: "Full Access", value: "full_access" },
            ],
            currentValue: "full_access",
          },
        ],
      }),
    });
    await connectRepo(repo, conn);
    await repo.agents.connectServer("codex-acp");
    const session = repo.createSession("/repo", "codex-acp", "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");
    session.configOptions = [
      {
        id: "permission_mode",
        type: "select" as const,
        name: "Approval Preset",
        options: [
          { name: "Default", value: "default" },
          { name: "Full Access", value: "full_access" },
        ],
        currentValue: "full_access",
      },
    ];

    await session.prompt("hello");

    expect(conn.loadSession).toHaveBeenCalledWith({
      sessionId: "s-existing",
      cwd: "/repo",
      mcpServers: [],
    });
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-existing",
      configId: "permission_mode",
      value: "full_access",
    });
    expect(conn.prompt).toHaveBeenCalledTimes(2);
    expect(session.promptError).toBeNull();
    expect(session.configOptions).toEqual([
      expect.objectContaining({ id: "permission_mode", currentValue: "full_access" }),
    ]);
  });

  it("emits session:turn-completed when a prompt completes normally", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    const listener = vi.fn();
    repo.emitter.addEventListener(ACP_SESSION_TURN_COMPLETED_EVENT, listener);

    await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { sessionId: "s-new", agentServer: DEFAULT_AGENT_SERVER },
      }),
    );
  });

  it("does not emit session:turn-completed when the prompt is cancelled", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      prompt: vi.fn().mockResolvedValue({ stopReason: "cancelled" } satisfies PromptResponse),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    const listener = vi.fn();
    repo.emitter.addEventListener(ACP_SESSION_TURN_COMPLETED_EVENT, listener);

    await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(listener).not.toHaveBeenCalled();
  });

  it("clears compaction state when a prompt fails without a completed update", async () => {
    const repo = new ACPSessionRepositoryWriter();
    let session: ReturnType<typeof repo.createSession>;
    const prompt = vi.fn(async () => {
      repo.handleCompactionUpdate(DEFAULT_AGENT_SERVER, {
        id: "compaction-failed",
        phase: "started",
      });
      expect(session.compacting).toBe(true);
      throw new Error("summarizer failed");
    });
    await connectRepo(repo, mockConnection({ prompt }));
    session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-compaction-failure");
    session.sessionId = "s-existing";

    await session.prompt("compact");

    expect(session.compacting).toBe(false);
    expect(session.promptError?.error.message).toContain("summarizer failed");
  });

  it("sends an enqueued prompt after cancelling the current prompt from the composer", async () => {
    let resolveCurrentPrompt!: () => void;
    const prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PromptResponse>((resolve) => {
            resolveCurrentPrompt = () => resolve({ stopReason: "cancelled" });
          }),
      )
      .mockResolvedValueOnce({ stopReason: "end_turn" } satisfies PromptResponse);
    const cancel = vi.fn().mockResolvedValue({});
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt, cancel }));
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");

    const currentPrompt = session.serialize((gen) =>
      session.sendCore(gen, "current prompt", undefined, undefined, "/repo"),
    );
    await vi.waitFor(() => expect(session.isPrompting).toBe(true));
    session.enqueuePrompt({
      text: "queued follow-up",
      content: [textBlock("queued follow-up")],
      cwd: "/repo",
    });

    await session.cancel({ sendQueuedPrompt: true });
    expect(session.queuedPrompt).toBeNull();
    expect(prompt).toHaveBeenCalledOnce();

    resolveCurrentPrompt();
    await currentPrompt;
    await session.queue.operationQueue;
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledWith({ sessionId: "s-existing" });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenNthCalledWith(2, {
      sessionId: "s-existing",
      prompt: [textBlock("queued follow-up")],
    });
    expect(session.queuedPrompt).toBeNull();
  });

  it("sends multiple enqueued prompts in FIFO order", async () => {
    let resolveCurrentPrompt!: () => void;
    const prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PromptResponse>((resolve) => {
            resolveCurrentPrompt = () => resolve({ stopReason: "end_turn" });
          }),
      )
      .mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse);
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt }));
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");

    const currentPrompt = session.serialize((gen) =>
      session.sendCore(gen, "current prompt", undefined, undefined, "/repo"),
    );
    await vi.waitFor(() => expect(session.isPrompting).toBe(true));
    session.enqueuePrompt({
      text: "first queued follow-up",
      content: [textBlock("first queued follow-up")],
      cwd: "/repo",
    });
    session.enqueuePrompt({
      text: "second queued follow-up",
      content: [textBlock("second queued follow-up")],
      cwd: "/repo",
    });

    expect(session.queuedPrompts).toHaveLength(2);
    expect(session.queuedPrompts[0].id).not.toBe(session.queuedPrompts[1].id);

    resolveCurrentPrompt();
    await currentPrompt;
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(3));
    await session.queue.operationQueue;

    expect(prompt).toHaveBeenNthCalledWith(2, {
      sessionId: "s-existing",
      prompt: [textBlock("first queued follow-up")],
    });
    expect(prompt).toHaveBeenNthCalledWith(3, {
      sessionId: "s-existing",
      prompt: [textBlock("second queued follow-up")],
    });
    expect(session.queuedPrompts).toEqual([]);
  });

  it("steers an active prompt without cancelling or starting another prompt", async () => {
    let resolveCurrentPrompt!: () => void;
    const prompt = vi.fn(
      () =>
        new Promise<PromptResponse>((resolve) => {
          resolveCurrentPrompt = () => resolve({ stopReason: "end_turn" });
        }),
    );
    const request = vi.fn().mockResolvedValue({ outcome: "injected" });
    const cancel = vi.fn().mockResolvedValue({});
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt, request, cancel }), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
      _meta: { steering: { supported: true } },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");

    const currentPrompt = session.serialize((gen) =>
      session.sendCore(gen, "current prompt", undefined, undefined, "/repo"),
    );
    await vi.waitFor(() => expect(session.isPrompting).toBe(true));

    await expect(
      session.steerPrompt("focus on tests", [textBlock("focus on tests")]),
    ).resolves.toBe("injected");

    expect(request).toHaveBeenCalledWith("_session/steering", {
      sessionId: "s-existing",
      prompt: [textBlock("focus on tests")],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledOnce();
    const userMessages = session.events.filter((event) => event.eventKind === "user_message");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).not.toHaveProperty("steer");
    expect(userMessages[1]).toMatchObject({
      content: [{ type: "text", text: "focus on tests" }],
      steer: true,
    });

    resolveCurrentPrompt();
    await currentPrompt;
  });

  it("falls back to an ordinary prompt when the steer lands after the turn ended", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse);
    const request = vi.fn().mockResolvedValue({ outcome: "promptRequired" });
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt, request }), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
      _meta: { steering: { supported: true } },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");
    session.isPrompting = true;
    session.enqueuePrompt({
      text: "queued follow-up",
      content: [textBlock("queued follow-up")],
      cwd: "/repo",
    });

    await expect(
      session.steerPrompt("focus on tests", [textBlock("focus on tests")]),
    ).resolves.toBe("promptRequired");
    await session.queue.operationQueue;

    expect(session.promptError).toBeNull();
    // The fallback re-delivers the steered message first — marked so the
    // helper does not mirror it to other surfaces a second time — and only
    // then advances the ordinary queue.
    expect(prompt).toHaveBeenNthCalledWith(1, {
      sessionId: "s-existing",
      prompt: [textBlock("focus on tests")],
      _meta: { "camber/steer_fallback": true },
    });
    expect(prompt).toHaveBeenNthCalledWith(2, {
      sessionId: "s-existing",
      prompt: [textBlock("queued follow-up")],
    });
    const userMessages = session.events.filter((event) => event.eventKind === "user_message");
    const steered = userMessages.filter((event) =>
      event.content.some((block) => block.type === "text" && block.text === "focus on tests"),
    );
    expect(steered).toHaveLength(1);
  });

  it("leaves a retryable prompt error when an agent exit abandons the steer fallback", async () => {
    let resolveCurrentPrompt!: () => void;
    const prompt = vi.fn(
      () =>
        new Promise<PromptResponse>((resolve) => {
          resolveCurrentPrompt = () => resolve({ stopReason: "end_turn" });
        }),
    );
    let resolveSteer!: () => void;
    const request = vi.fn(
      () =>
        new Promise<{ outcome: string }>((resolve) => {
          resolveSteer = () => resolve({ outcome: "promptRequired" });
        }),
    );
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt, request }), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
      _meta: { steering: { supported: true } },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");

    const currentPrompt = session.serialize((gen) =>
      session.sendCore(gen, "current prompt", undefined, undefined, "/repo"),
    );
    await vi.waitFor(() => expect(session.isPrompting).toBe(true));

    const steering = session.steerPrompt("focus on tests", [textBlock("focus on tests")]);
    await vi.waitFor(() => expect(session.isSteering).toBe(true));
    resolveSteer();
    // The fallback prompt is now queued behind the still-running turn; the
    // agent dies before it can run, so the fallback bails on the stale
    // generation and the steered message's only remaining trace must be a
    // retryable prompt error.
    await vi.waitFor(() => expect(session.isSteering).toBe(false));
    repo.handleAgentServerDidExit(DEFAULT_AGENT_SERVER, "exit status 2");
    resolveCurrentPrompt();
    await currentPrompt;

    await expect(steering).resolves.toBe("promptRequired");
    expect(prompt).toHaveBeenCalledOnce();
    expect(session.promptError).toMatchObject({
      prompt: "focus on tests",
      content: [textBlock("focus on tests")],
    });
  });

  it("treats a steered turn the agent started itself as delivered", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse);
    const request = vi.fn().mockResolvedValue({ outcome: "startedNewTurn" });
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt, request }), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
      _meta: { steering: { supported: true } },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");
    session.isPrompting = true;

    await expect(
      session.steerPrompt("focus on tests", [textBlock("focus on tests")]),
    ).resolves.toBe("startedNewTurn");

    expect(session.promptError).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("surfaces unknown steering outcomes as a prompt error naming the outcome", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse);
    const request = vi.fn().mockResolvedValue({ outcome: "mystery" });
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt, request }), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
      _meta: { steering: { supported: true } },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");
    session.isPrompting = true;

    await expect(
      session.steerPrompt("focus on tests", [textBlock("focus on tests")]),
    ).resolves.toBeNull();

    expect(session.promptError?.error.message).toContain("mystery");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("ignores a stale steer completion after the agent server exits", async () => {
    let resolveSteer!: () => void;
    const request = vi.fn(
      () =>
        new Promise<{ outcome: "injected" }>((resolve) => {
          resolveSteer = () => resolve({ outcome: "injected" });
        }),
    );
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse);
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt, request }), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
      _meta: { steering: { supported: true } },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");
    session.isPrompting = true;
    session.enqueuePrompt({
      text: "queued after restart",
      content: [textBlock("queued after restart")],
      cwd: "/repo",
    });

    const generation = session.generation;
    const steering = session.steerPrompt("focus on tests", [textBlock("focus on tests")]);
    await vi.waitFor(() => expect(session.isSteering).toBe(true));

    repo.handleAgentServerDidExit(DEFAULT_AGENT_SERVER, "exit status 2");
    expect(session.generation).toBe(generation + 1);
    expect(session.isPromptActive).toBe(false);

    resolveSteer();
    await expect(steering).resolves.toBeNull();
    await session.queue.operationQueue;

    expect(session.steeringRequestsInFlight).toBe(0);
    expect(session.queuedPrompts).toMatchObject([{ text: "queued after restart" }]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("steers and clears an enqueued prompt without sending it twice", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "injected" });
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ request }), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
      _meta: { steering: { supported: true } },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");
    session.isPrompting = true;
    session.enqueuePrompt({
      text: "first queued follow-up",
      content: [textBlock("first queued follow-up")],
      cwd: "/repo",
    });
    session.enqueuePrompt({
      text: "steered follow-up",
      content: [textBlock("steered follow-up")],
      cwd: "/repo",
    });
    const steeredId = session.queuedPrompts[1].id;

    await expect(session.steerQueuedPrompt(steeredId)).resolves.toBe("injected");

    expect(session.queuedPrompts).toMatchObject([
      {
        text: "first queued follow-up",
        content: [textBlock("first queued follow-up")],
      },
    ]);
    expect(request).toHaveBeenCalledWith("_session/steering", {
      sessionId: "s-existing",
      prompt: [textBlock("steered follow-up")],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
  });

  it("advances one unrelated prompt after the current prompt and steering both settle", async () => {
    let resolveCurrentPrompt!: () => void;
    let resolveSteer!: () => void;
    const prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PromptResponse>((resolve) => {
            resolveCurrentPrompt = () => resolve({ stopReason: "end_turn" });
          }),
      )
      .mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse);
    const request = vi.fn(
      () =>
        new Promise<{ outcome: "injected" }>((resolve) => {
          resolveSteer = () => resolve({ outcome: "injected" });
        }),
    );
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt, request }), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
      _meta: { steering: { supported: true } },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");

    const currentPrompt = session.serialize((gen) =>
      session.sendCore(gen, "current prompt", undefined, undefined, "/repo"),
    );
    await vi.waitFor(() => expect(session.isPrompting).toBe(true));
    session.enqueuePrompt({
      text: "first queued follow-up",
      content: [textBlock("first queued follow-up")],
      cwd: "/repo",
    });
    session.enqueuePrompt({
      text: "second queued follow-up",
      content: [textBlock("second queued follow-up")],
      cwd: "/repo",
    });

    const steering = session.steerPrompt("focus on tests", [textBlock("focus on tests")]);
    await vi.waitFor(() => expect(session.isSteering).toBe(true));

    resolveCurrentPrompt();
    await currentPrompt;
    expect(session.isPrompting).toBe(false);
    expect(session.isSteering).toBe(true);

    resolveSteer();
    await steering;
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(3));
    await session.queue.operationQueue;

    expect(prompt).toHaveBeenNthCalledWith(2, {
      sessionId: "s-existing",
      prompt: [textBlock("first queued follow-up")],
    });
    expect(prompt).toHaveBeenNthCalledWith(3, {
      sessionId: "s-existing",
      prompt: [textBlock("second queued follow-up")],
    });
    expect(session.queuedPrompts).toEqual([]);
  });

  it("advances one unrelated prompt after steering and then the current prompt settle", async () => {
    let resolveCurrentPrompt!: () => void;
    const prompt = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PromptResponse>((resolve) => {
            resolveCurrentPrompt = () => resolve({ stopReason: "end_turn" });
          }),
      )
      .mockResolvedValue({ stopReason: "end_turn" } satisfies PromptResponse);
    const request = vi.fn().mockResolvedValue({ outcome: "injected" });
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ prompt, request }), {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {},
      _meta: { steering: { supported: true } },
    } as InitializeResponse);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");

    const currentPrompt = session.serialize((gen) =>
      session.sendCore(gen, "current prompt", undefined, undefined, "/repo"),
    );
    await vi.waitFor(() => expect(session.isPrompting).toBe(true));
    session.enqueuePrompt({
      text: "first queued follow-up",
      content: [textBlock("first queued follow-up")],
      cwd: "/repo",
    });
    session.enqueuePrompt({
      text: "second queued follow-up",
      content: [textBlock("second queued follow-up")],
      cwd: "/repo",
    });

    await expect(
      session.steerPrompt("focus on tests", [textBlock("focus on tests")]),
    ).resolves.toBe("injected");

    resolveCurrentPrompt();
    await currentPrompt;
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(3));
    await session.queue.operationQueue;

    expect(prompt).toHaveBeenNthCalledWith(2, {
      sessionId: "s-existing",
      prompt: [textBlock("first queued follow-up")],
    });
    expect(prompt).toHaveBeenNthCalledWith(3, {
      sessionId: "s-existing",
      prompt: [textBlock("second queued follow-up")],
    });
    expect(session.queuedPrompts).toEqual([]);
  });

  it("does not steer Pool sessions without the native extension", async () => {
    const request = vi.fn().mockResolvedValue({ outcome: "injected" });
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ request }));
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    session.sessionId = "s-existing";
    session.sessionInfo = buildSessionInfo("s-existing", "/repo", "native_session");
    session.isPrompting = true;

    await expect(
      session.steerPrompt("focus on tests", [textBlock("focus on tests")]),
    ).resolves.toBe(null);

    expect(request).not.toHaveBeenCalled();
  });

  it("uses prompt fallback titles for Camber ACP sessions", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER);

    await session.serialize((gen) => session.sendCore(gen, "hello world", undefined));

    await vi.waitFor(() => {
      expect(session.sessionInfo?.title).toBe("hello world");
    });
  });

  it("uses prompt fallback titles for third-party ACP sessions", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection();
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", "third-party");

    await session.serialize((gen) => session.sendCore(gen, "hello world", undefined));

    expect(session.sessionInfo?.title).toBe("hello world");
  });

  it("finalizes a title-only Devin message when the first prompt ends", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      prompt: vi.fn(async ({ sessionId }: { sessionId: string }) => {
        repo.handleSessionUpdate("devin", sessionNotification("title: Greeting", sessionId));
        return { stopReason: "end_turn" } satisfies PromptResponse;
      }),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", "devin");

    await session.serialize((gen) => session.sendCore(gen, "hello world", undefined));

    expect(session.sessionInfo?.title).toBe("Greeting");
    expect(session.events.at(-1)).toMatchObject({
      eventKind: "agent_message",
      content: [{ type: "text", text: "" }],
    });
  });

  it("keeps the conversation id stable before the first prompt completes", async () => {
    const repo = new ACPSessionRepositoryWriter();
    let resolvePrompt!: () => void;
    const conn = mockConnection({
      prompt: vi.fn(
        () =>
          new Promise<PromptResponse>((resolve) => {
            resolvePrompt = () => resolve({ stopReason: "end_turn" });
          }),
      ),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");

    const send = session.serialize((gen) =>
      session.sendCore(gen, "hello", undefined, undefined, "", undefined),
    );

    await vi.waitFor(() => {
      expect(session.sessionId).toBe("s-new");
    });
    expect(session.isPrompting).toBe(true);
    expect(repo.getSessionByConversationId("conv-1")).toBe(session);

    resolvePrompt();
    await send;
  });

  it("routes live session updates to their target session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();

    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, sessionNotification("live"));

    expect(session!.events).toHaveLength(1);
    expect(session!.events[0]).toMatchObject({ eventKind: "agent_message" });
  });

  it("retries session/load with fallback cwds when the original directory fails", async () => {
    const loadSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("cwd does not exist"))
      .mockResolvedValueOnce({});
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ loadSession } as Partial<ClientSideConnection>));

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/gone-worktree",
      [],
      { readOnly: true },
      DEFAULT_AGENT_SERVER,
      { fallbackCwds: ["/gone-worktree", "/repo"] },
    );

    expect(session).not.toBeNull();
    expect(loadSession).toHaveBeenCalledTimes(2);
    expect(loadSession).toHaveBeenNthCalledWith(1, {
      sessionId: "s-loaded",
      cwd: "/gone-worktree",
      mcpServers: [],
    });
    expect(loadSession).toHaveBeenNthCalledWith(2, {
      sessionId: "s-loaded",
      cwd: "/repo",
      mcpServers: [],
    });
    // The read-only seed survives the load so the pane disables prompting.
    expect(session!.sessionInfo?.readOnly).toBe(true);
  });

  it("makes a cached read-only inspection writable when it is reopened after restore", async () => {
    const loadSession = vi.fn().mockResolvedValue({});
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ loadSession } as Partial<ClientSideConnection>));

    const preview = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-loaded", readOnly: true },
      DEFAULT_AGENT_SERVER,
      { readOnlyInspection: true },
    );

    expect(preview?.sessionInfo?.readOnly).toBe(true);

    const restored = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-loaded", readOnly: false },
      DEFAULT_AGENT_SERVER,
    );

    expect(restored).toBe(preview);
    expect(restored?.sessionInfo?.readOnly).toBe(false);
    expect(loadSession).toHaveBeenCalledTimes(1);
  });

  it("preserves agent-authored read-only state when reopening a cached session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);

    const readOnlySession = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-loaded", readOnly: true },
      DEFAULT_AGENT_SERVER,
    );
    await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-loaded", readOnly: false },
      DEFAULT_AGENT_SERVER,
    );

    expect(readOnlySession?.sessionInfo?.readOnly).toBe(true);
  });

  it("never persists sidebar metadata for read-only sessions", async () => {
    const navConversation = {
      id: "conv-archived",
      workspacePath: "/repo",
      agentServer: DEFAULT_AGENT_SERVER,
      sessionId: "s-loaded",
      cwd: "/repo",
      active: false,
      archived: true,
      workingDirectories: ["/repo"],
    };
    helperJsonrpcCall.mockImplementation(async (method: unknown) =>
      String(method).includes("acpNav/list") ? { conversations: [navConversation] } : {},
    );
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { readOnly: true },
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();
    helperJsonrpcCall.mockClear();

    // Replayed tool activity would normally persist sidebar metadata; the nav
    // upsert force-reactivates conversations, silently un-archiving this one.
    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, toolNotification());
    session!.metadataManager.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session!.metadata.edited).toHaveLength(1);
    const calledMethods = helperJsonrpcCall.mock.calls.map((call) => String(call[0]));
    expect(calledMethods.filter((method) => method.includes("upsertConversation"))).toEqual([]);
  });

  it("fails the load when every cwd candidate is rejected", async () => {
    const loadSession = vi.fn().mockRejectedValue(new Error("no such directory"));
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo, mockConnection({ loadSession } as Partial<ClientSideConnection>));

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/gone-worktree",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
      { fallbackCwds: ["/repo", "/other"] },
    );

    expect(session).toBeNull();
    expect(loadSession).toHaveBeenCalledTimes(3);
  });

  it("updates session metadata from live tool events", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();

    repo.handleSessionUpdate(DEFAULT_AGENT_SERVER, toolNotification());

    expect(session!.metadata.edited).toEqual([{ fileName: "app.ts", filePath: "./src/app.ts" }]);
  });

  it("stores permission requests on the target session and resolves selections", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();

    const response = repo.handleRequestPermission(DEFAULT_AGENT_SERVER, permissionRequest());

    expect(session!.pendingPermissionRequests).toHaveLength(1);
    repo.selectPermissionOption(session!.pendingPermissionRequests[0]!.id, "allow-once", [
      "tool:allow",
    ]);

    await expect(response).resolves.toEqual({
      outcome: {
        outcome: "selected",
        optionId: "allow-once",
        _meta: { [ACP_PERMISSION_OVERRIDE_RULES_META_KEY]: ["tool:allow"] },
      },
    });
    expect(session!.pendingPermissionRequests).toHaveLength(0);
  });

  it("holds permission requests for unknown sessions instead of cancelling them", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);

    const response = repo.handleRequestPermission(
      DEFAULT_AGENT_SERVER,
      permissionRequest({ sessionId: "s-not-open-here" }),
    );

    // The request must not resolve on its own: an instant "cancelled" would
    // win the helper's first-response-wins broadcast and kill the prompt on
    // every other surface.
    let settled = false;
    void response.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(repo.pendingApprovals).toHaveLength(1);
    expect(repo.unboundPermissionRequestsFor("s-not-open-here", DEFAULT_AGENT_SERVER)).toHaveLength(
      1,
    );

    repo.selectPermissionOption(repo.pendingApprovals[0]!.id, "allow-once");
    await expect(response).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(repo.pendingApprovals).toHaveLength(0);
  });

  it("cancels unbound permission requests when the session is invalidated", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);

    const response = repo.handleRequestPermission(
      DEFAULT_AGENT_SERVER,
      permissionRequest({ sessionId: "s-not-open-here" }),
    );
    expect(repo.pendingApprovals).toHaveLength(1);

    repo.cancelPermissionRequests("s-not-open-here", DEFAULT_AGENT_SERVER);

    await expect(response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(repo.pendingApprovals).toHaveLength(0);
  });

  it("includes live-session permission requests in pendingApprovals", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();

    void repo.handleRequestPermission(DEFAULT_AGENT_SERVER, permissionRequest());

    expect(session!.pendingPermissionRequests).toHaveLength(1);
    expect(repo.pendingApprovals).toHaveLength(1);
    expect(repo.pendingApprovals[0]!.id).toBe(session!.pendingPermissionRequests[0]!.id);
  });

  it("dismisses a bound permission answered on another surface", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();

    const response = repo.handleRequestPermission(DEFAULT_AGENT_SERVER, permissionRequest());
    expect(session!.pendingPermissionRequests).toHaveLength(1);

    // Another surface answered the broadcast; the helper tells us to dismiss it.
    repo.resolvePermissionExternally("s-loaded", DEFAULT_AGENT_SERVER, "tool-1");

    await expect(response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(session!.pendingPermissionRequests).toHaveLength(0);
  });

  it("dismisses a held unbound permission answered on another surface", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);

    const response = repo.handleRequestPermission(
      DEFAULT_AGENT_SERVER,
      permissionRequest({ sessionId: "s-not-open-here" }),
    );
    expect(repo.pendingApprovals).toHaveLength(1);

    repo.resolvePermissionExternally("s-not-open-here", DEFAULT_AGENT_SERVER, "tool-1");

    await expect(response).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(repo.pendingApprovals).toHaveLength(0);
  });

  it("ignores an external resolve for an unrelated tool call", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    void repo.handleRequestPermission(DEFAULT_AGENT_SERVER, permissionRequest());

    repo.resolvePermissionExternally("s-loaded", DEFAULT_AGENT_SERVER, "some-other-tool");

    expect(session!.pendingPermissionRequests).toHaveLength(1);
  });

  it("reconciles helper-pushed approvals into the live session and answers via respond RPC", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();

    const approval = {
      agentServer: DEFAULT_AGENT_SERVER,
      sessionId: "s-loaded",
      kind: "permission" as const,
      id: "tc-1",
      permission: {
        toolCall: { toolCallId: "tc-1", title: "Create hello.txt", kind: "edit" },
        options: [
          { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
          { optionId: "reject-once", kind: "reject_once", name: "Deny" },
        ],
      },
    };
    repo.reconcileApprovals([approval]);

    expect(session!.pendingPermissionRequests).toHaveLength(1);
    const request = session!.pendingPermissionRequests[0]!;
    expect(request.approval).toMatchObject({ kind: "permission", id: "tc-1" });
    expect(request.toolCall.title).toBe("Create hello.txt");
    expect(repo.pendingApprovals).toHaveLength(1);

    // Re-delivery of the same set (reconnect) is idempotent: same single card,
    // same object identity.
    repo.reconcileApprovals([approval]);
    expect(session!.pendingPermissionRequests).toHaveLength(1);
    expect(session!.pendingPermissionRequests[0]).toBe(request);

    helperJsonrpcCall.mockClear();
    helperJsonrpcCall.mockResolvedValue({ outcome: "accepted" });
    repo.selectPermissionOption(request.id, "allow-once", ["tool:allow"]);
    await vi.waitFor(() => {
      expect(session!.pendingPermissionRequests).toHaveLength(0);
    });
    expect(helperJsonrpcCall).toHaveBeenCalledWith("camber/acp/approvals/respond", {
      agentServer: DEFAULT_AGENT_SERVER,
      sessionId: "s-loaded",
      kind: "permission",
      id: "tc-1",
      optionId: "allow-once",
      overrideRules: ["tool:allow"],
    });
  });

  it.each(["invalid", "rejected"] as const)(
    "restores an optimistically removed approval after a %s response",
    async (failure) => {
      const repo = new ACPSessionRepositoryWriter();
      await connectRepo(repo);
      const session = await repo.loadSessionRecord(
        "s-loaded",
        "/repo",
        [],
        undefined,
        DEFAULT_AGENT_SERVER,
      );
      expect(session).not.toBeNull();

      const approval = {
        agentServer: DEFAULT_AGENT_SERVER,
        sessionId: "s-loaded",
        kind: "permission" as const,
        id: "tc-retry",
        permission: {
          toolCall: { toolCallId: "tc-retry", title: "Run command", kind: "execute" },
          options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }],
        },
      };
      repo.reconcileApprovals([approval]);
      const request = session!.pendingPermissionRequests[0]!;

      const consoleError =
        failure === "rejected" ? vi.spyOn(console, "error").mockImplementation(() => {}) : null;
      helperJsonrpcCall.mockImplementation(async (method: string) => {
        if (method === "camber/acp/approvals/respond") {
          if (failure === "rejected") throw new Error("transport closed");
          return { outcome: "invalid" };
        }
        return {};
      });

      try {
        repo.selectPermissionOption(request.id, "allow-once");

        await vi.waitFor(() => {
          expect(session!.pendingPermissionRequests).toHaveLength(1);
        });
        expect(helperJsonrpcCall).not.toHaveBeenCalledWith("camber/acp/approvals/list", {});
      } finally {
        consoleError?.mockRestore();
      }
    },
  );

  it("does not restore a failed response after a newer approval snapshot", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    expect(session).not.toBeNull();

    const approval = {
      agentServer: DEFAULT_AGENT_SERVER,
      sessionId: "s-loaded",
      kind: "permission" as const,
      id: "tc-race",
      permission: {
        toolCall: { toolCallId: "tc-race", title: "Run command", kind: "execute" },
        options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }],
      },
    };
    repo.reconcileApprovals([approval]);
    const request = session!.pendingPermissionRequests[0]!;

    let rejectRespond!: (error: Error) => void;
    helperJsonrpcCall.mockReturnValue(
      new Promise((_, reject) => {
        rejectRespond = reject;
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      repo.selectPermissionOption(request.id, "allow-once");
      repo.reconcileApprovals([]);
      rejectRespond(new Error("transport closed"));

      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
      expect(session!.pendingPermissionRequests).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("holds reconciled approvals unbound for conversations not open here and drops them on removal", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);

    const approval = {
      agentServer: DEFAULT_AGENT_SERVER,
      sessionId: "s-not-open-here",
      kind: "permission" as const,
      id: "tc-9",
      permission: {
        toolCall: { toolCallId: "tc-9", title: "Run command", kind: "execute" },
        options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }],
      },
    };
    repo.reconcileApprovals([approval]);
    expect(repo.pendingApprovals).toHaveLength(1);
    expect(repo.unboundPermissionRequestsFor("s-not-open-here", DEFAULT_AGENT_SERVER)).toHaveLength(
      1,
    );

    // Answered on another surface → the next push no longer contains it.
    repo.reconcileApprovals([]);
    expect(repo.pendingApprovals).toHaveLength(0);
    expect(repo.unboundPermissionRequestsFor("s-not-open-here", DEFAULT_AGENT_SERVER)).toHaveLength(
      0,
    );
  });

  it("preserves legacy and debug permission requests across approval reconciles", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);
    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      undefined,
      DEFAULT_AGENT_SERVER,
    );
    // Legacy SDK-delivered request (old helper): no approval key.
    void repo.handleRequestPermission(DEFAULT_AGENT_SERVER, permissionRequest());
    expect(session!.pendingPermissionRequests).toHaveLength(1);

    repo.reconcileApprovals([]);

    expect(session!.pendingPermissionRequests).toHaveLength(1);
    expect(session!.pendingPermissionRequests[0]!.approval).toBeUndefined();
  });

  it("reconciles elicitation approvals into the elicitation repository", async () => {
    const conversationStatus = new ACPConversationStatusRepositoryWriter();
    const elicitation = new ElicitationRepository(conversationStatus.publicAPI());
    const repo = new ACPSessionRepositoryWriter(conversationStatus.publicAPI(), elicitation);
    await connectRepo(repo);

    repo.reconcileApprovals([
      {
        agentServer: DEFAULT_AGENT_SERVER,
        sessionId: "s-1",
        kind: "elicitation" as const,
        id: "e-1",
        elicitation: {
          sessionId: "s-1",
          mode: "form" as const,
          message: "Need input",
          elicitationId: "e-1",
        },
      },
    ]);
    expect(elicitation.firstPendingForChat("s-1", DEFAULT_AGENT_SERVER)?.elicitationId).toBe("e-1");

    // Answering routes through the respond RPC and clears locally.
    helperJsonrpcCall.mockClear();
    helperJsonrpcCall.mockResolvedValue({ outcome: "accepted" });
    elicitation.decline("e-1");
    expect(elicitation.isElicitationPending("e-1")).toBe(false);
    expect(helperJsonrpcCall).toHaveBeenCalledWith(
      "camber/acp/approvals/respond",
      expect.objectContaining({ kind: "elicitation", id: "e-1", action: "decline" }),
    );

    // Removal push for an already-answered elicitation is a no-op.
    repo.reconcileApprovals([]);
    expect(elicitation.isElicitationPending("e-1")).toBe(false);
  });

  it("folds a held permission into its session once the conversation is live", async () => {
    const repo = new ACPSessionRepositoryWriter();
    await connectRepo(repo);

    void repo.handleRequestPermission(
      DEFAULT_AGENT_SERVER,
      permissionRequest({ sessionId: "s-held" }),
    );
    expect(repo.unboundPermissionRequestsFor("s-held", DEFAULT_AGENT_SERVER)).toHaveLength(1);

    const session = await repo.loadSessionRecord(
      "s-held",
      "/repo",
      [],
      { conversationId: "conv-held" },
      DEFAULT_AGENT_SERVER,
    );
    repo.publishLiveStatuses();

    // The single source of truth is now the session's own list; the waiting
    // indicator reads from it, so both agree.
    expect(session!.pendingPermissionRequests).toHaveLength(1);
    expect(repo.unboundPermissionRequestsFor("s-held", DEFAULT_AGENT_SERVER)).toHaveLength(0);
    expect(repo.getConversationStatus("s-held", DEFAULT_AGENT_SERVER)).toMatchObject({
      waitingForUser: true,
    });
  });

  it("loads ACP debug dumps as a returned read-only session", async () => {
    const repo = new ACPSessionRepositoryWriter();
    let loadedDetail: ACPDebugDumpLoadedEventDetail | null = null;
    repo.emitter.addEventListener(ACP_DEBUG_DUMP_LOADED_EVENT, (event) => {
      loadedDetail = (event as CustomEvent<ACPDebugDumpLoadedEventDetail>).detail;
    });

    const session = await repo.loadDebugDump(
      [
        {
          _direction: "incoming",
          method: "session/update",
          params: sessionNotification("from dump", "dump-session"),
        },
      ],
      DEFAULT_AGENT_SERVER,
    );

    expect(session.sessionId).toBe("dump-session");
    expect(session.sessionInfo?.readOnly).toBe(true);
    expect(session.events).toHaveLength(1);
    expect(loadedDetail).toEqual({
      agentServer: DEFAULT_AGENT_SERVER,
      conversationId: session.conversationId,
      sessionId: "dump-session",
    });
  });

  it("re-applies persisted session config on load", async () => {
    const repo = new ACPSessionRepositoryWriter();
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("acpNav/list")) {
        return {
          projects: [],
          conversations: [
            {
              id: "conv-1",
              workspacePath: "/repo",
              agentServer: DEFAULT_AGENT_SERVER,
              sessionId: "s-loaded",
              cwd: "/repo",
              active: true,
              archived: false,
              workingDirectories: ["/repo"],
              metadata: {
                processes: [],
                explored: [],
                edited: [],
                sessionConfig: { selections: { model: "model-b" }, modeId: "plan" },
              },
            },
          ],
        };
      }
      return {};
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "model",
            type: "select" as const,
            name: "Model",
            currentValue: "model-a",
            options: [
              { value: "model-a", name: "A" },
              { value: "model-b", name: "B" },
            ],
          },
        ],
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
      }),
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "model",
            type: "select" as const,
            name: "Model",
            currentValue: "model-b",
            options: [
              { value: "model-a", name: "A" },
              { value: "model-b", name: "B" },
            ],
          },
        ],
      }),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-1" },
      DEFAULT_AGENT_SERVER,
    );

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-loaded",
      configId: "model",
      value: "model-b",
    });
    expect(conn.setSessionMode).toHaveBeenCalledWith({
      sessionId: "s-loaded",
      modeId: "plan",
    });
    expect(session?.configOptions[0]?.currentValue).toBe("model-b");
    expect(session?.modes?.currentModeId).toBe("plan");
  });

  it("cold-loads a discovered local model from cached catalog definitions", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const gemma = "mlx-community/gemma-4-e4b-it-qat-OptiQ-4bit";
    const laguna = "poolside/Laguna-S-2.1-NVFP4-mlx";
    const modelOption = (currentValue: string, values: string[]) => ({
      id: "model",
      type: "select" as const,
      name: "Model",
      category: "model" as const,
      options: values.map((value) => ({ name: value, value })),
      currentValue,
    });
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("acpNav/list")) {
        return {
          projects: [],
          conversations: [
            {
              id: "conv-1",
              workspacePath: "/repo",
              agentServer: "local",
              sessionId: "s-loaded",
              cwd: "/repo",
              active: true,
              archived: false,
              workingDirectories: ["/repo"],
              metadata: {
                processes: [],
                explored: [],
                edited: [],
                sessionConfig: { selections: { model: laguna }, modeId: null },
              },
            },
          ],
        };
      }
      if (String(method).includes("acpNav/getConfigCache")) {
        return {
          entry: {
            agentServer: "local",
            configOptions: [modelOption(gemma, [gemma, laguna])],
            availableCommands: [],
            modes: null,
            promptCapabilities: null,
            agentInfo: null,
            cachedAt: new Date().toISOString(),
          },
        };
      }
      return {};
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [modelOption(gemma, [gemma])],
      }),
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [modelOption(laguna, [laguna])],
      }),
    });
    await connectRepo(repo, conn, undefined, "local");
    expect(repo.agents.cachedConfigFor("local")).toBeUndefined();

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-1" },
      "local",
    );

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-loaded",
      configId: "model",
      value: laguna,
    });
    expect(session?.configOptions).toEqual([modelOption(laguna, [gemma, laguna])]);
  });

  it("skips persisted selections that no longer exist", async () => {
    const repo = new ACPSessionRepositoryWriter();
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("acpNav/list")) {
        return {
          projects: [],
          conversations: [
            {
              id: "conv-1",
              workspacePath: "/repo",
              agentServer: DEFAULT_AGENT_SERVER,
              sessionId: "s-loaded",
              cwd: "/repo",
              active: true,
              archived: false,
              workingDirectories: ["/repo"],
              metadata: {
                processes: [],
                explored: [],
                edited: [],
                sessionConfig: { selections: { model: "model-gone" }, modeId: "gone-mode" },
              },
            },
          ],
        };
      }
      return {};
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "model",
            type: "select" as const,
            name: "Model",
            currentValue: "model-a",
            options: [
              { value: "model-a", name: "A" },
              { value: "model-b", name: "B" },
            ],
          },
        ],
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
      }),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-1" },
      DEFAULT_AGENT_SERVER,
    );

    expect(conn.setSessionConfigOption).not.toHaveBeenCalled();
    expect(conn.setSessionMode).not.toHaveBeenCalled();
    expect(session).not.toBeNull();
  });

  it("persists session config when an option changes", async () => {
    const repo = new ACPSessionRepositoryWriter();
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("acpNav/list")) {
        return {
          projects: [],
          conversations: [
            {
              id: "conv-1",
              workspacePath: "/repo",
              agentServer: DEFAULT_AGENT_SERVER,
              sessionId: "s-loaded",
              cwd: "/repo",
              active: true,
              archived: false,
              workingDirectories: ["/repo"],
              metadata: { processes: [], explored: [], edited: [] },
            },
          ],
        };
      }
      return {};
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "model",
            type: "select" as const,
            name: "Model",
            currentValue: "model-a",
            options: [
              { value: "model-a", name: "A" },
              { value: "model-b", name: "B" },
            ],
          },
        ],
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
      }),
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "model",
            type: "select" as const,
            name: "Model",
            currentValue: "model-b",
            options: [
              { value: "model-a", name: "A" },
              { value: "model-b", name: "B" },
            ],
          },
        ],
      }),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-1" },
      DEFAULT_AGENT_SERVER,
    );

    vi.mocked(helperJsonrpcCall).mockClear();
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("acpNav/list")) {
        return {
          projects: [],
          conversations: [
            {
              id: "conv-1",
              workspacePath: "/repo",
              agentServer: DEFAULT_AGENT_SERVER,
              sessionId: "s-loaded",
              cwd: "/repo",
              active: true,
              archived: false,
              workingDirectories: ["/repo"],
              metadata: { processes: [], explored: [], edited: [] },
            },
          ],
        };
      }
      return {};
    });

    await session!.setConfigOption("model", "model-b");

    await vi.waitFor(() => {
      const upsertCall = vi
        .mocked(helperJsonrpcCall)
        .mock.calls.find(([method]) => String(method).includes("acpNav/upsertConversation"));
      expect(upsertCall).toBeDefined();
      const params = upsertCall![1] as { conversation: { metadata: { sessionConfig?: unknown } } };
      expect(params.conversation.metadata.sessionConfig).toEqual({
        selections: { model: "model-b" },
        modeId: "default",
      });
    });
  });

  it("sends a typed boolean payload when toggling a boolean config option", async () => {
    const repo = new ACPSessionRepositoryWriter();
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "fast",
            type: "boolean" as const,
            name: "Fast mode",
            currentValue: false,
          },
        ],
      }),
      setSessionConfigOption: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "fast",
            type: "boolean" as const,
            name: "Fast mode",
            currentValue: true,
          },
        ],
      }),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-1" },
      DEFAULT_AGENT_SERVER,
    );

    await session!.setBooleanConfigOption("fast", true);

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-loaded",
      configId: "fast",
      value: true,
      type: "boolean",
    });
    const fast = session!.configOptions.find((option) => option.id === "fast");
    expect(fast).toMatchObject({ type: "boolean", currentValue: true });
  });

  it("re-applies persisted model, thought level, and mode-as-config-option selections on load", async () => {
    const repo = new ACPSessionRepositoryWriter();
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("acpNav/list")) {
        return {
          projects: [],
          conversations: [
            {
              id: "conv-1",
              workspacePath: "/repo",
              agentServer: DEFAULT_AGENT_SERVER,
              sessionId: "s-loaded",
              cwd: "/repo",
              active: true,
              archived: false,
              workingDirectories: ["/repo"],
              metadata: {
                processes: [],
                explored: [],
                edited: [],
                sessionConfig: {
                  selections: { model: "model-b", thought_level: "high", mode: "plan" },
                  modeId: "plan",
                },
              },
            },
          ],
        };
      }
      return {};
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "model",
            type: "select" as const,
            category: "model",
            name: "Model",
            currentValue: "model-a",
            options: [
              { value: "model-a", name: "A" },
              { value: "model-b", name: "B" },
            ],
          },
          {
            id: "thought_level",
            type: "select" as const,
            category: "thought_level",
            name: "Thought level",
            currentValue: "medium",
            options: [
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "mode",
            type: "select" as const,
            category: "mode",
            name: "Mode",
            currentValue: "default",
            options: [
              { value: "default", name: "Default" },
              { value: "plan", name: "Plan" },
            ],
          },
        ],
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
      }),
      setSessionConfigOption: vi.fn().mockResolvedValue({}),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-1" },
      DEFAULT_AGENT_SERVER,
    );

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-loaded",
      configId: "model",
      value: "model-b",
    });
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-loaded",
      configId: "thought_level",
      value: "high",
    });
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-loaded",
      configId: "mode",
      value: "plan",
    });
    // Mode was restored through its config option, not session/set_mode.
    expect(conn.setSessionMode).not.toHaveBeenCalled();

    const byId = new Map(session?.configOptions.map((option) => [option.id, option]));
    expect((byId.get("model") as { currentValue?: string })?.currentValue).toBe("model-b");
    expect((byId.get("thought_level") as { currentValue?: string })?.currentValue).toBe("high");
    expect((byId.get("mode") as { currentValue?: string })?.currentValue).toBe("plan");
    expect(session?.modes?.currentModeId).toBe("plan");
  });

  it("persists draft session config even when the first prompt fails", async () => {
    const repo = new ACPSessionRepositoryWriter();
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("acpNav/list")) {
        return {
          projects: [],
          conversations: [
            {
              id: "conv-1",
              workspacePath: "/repo",
              agentServer: DEFAULT_AGENT_SERVER,
              sessionId: "s-new",
              cwd: "/repo",
              active: true,
              archived: false,
              workingDirectories: ["/repo"],
              metadata: { processes: [], explored: [], edited: [] },
            },
          ],
        };
      }
      return {};
    });
    const conn = mockConnection({
      newSession: vi.fn().mockResolvedValue({
        sessionId: "s-new",
        configOptions: [
          {
            id: "model",
            type: "select" as const,
            name: "Model",
            category: "model",
            options: [
              { name: "model-a", value: "model-a" },
              { name: "model-b", value: "model-b" },
            ],
            currentValue: "model-b",
          },
        ],
      }),
      prompt: vi.fn().mockRejectedValue(new Error("first prompt failed")),
    });
    await connectRepo(repo, conn);
    const session = repo.createSession("/repo", DEFAULT_AGENT_SERVER, "conv-1");
    // Draft has selected model-a; the agent session comes up on model-b.
    session.configOptions = [
      {
        id: "model",
        type: "select" as const,
        name: "Model",
        category: "model",
        options: [
          { name: "model-a", value: "model-a" },
          { name: "model-b", value: "model-b" },
        ],
        currentValue: "model-a",
      },
    ];

    await session.serialize((gen) => session.sendCore(gen, "hello", undefined));

    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "s-new",
      configId: "model",
      value: "model-a",
    });
    // The draft selection reaches storage without waiting for a transcript
    // flush that the failed prompt never produced.
    await vi.waitFor(() => {
      const upsertCall = vi
        .mocked(helperJsonrpcCall)
        .mock.calls.find(([method]) => String(method).includes("acpNav/upsertConversation"));
      expect(upsertCall).toBeDefined();
      const params = upsertCall![1] as { conversation: { metadata: { sessionConfig?: unknown } } };
      expect(params.conversation.metadata.sessionConfig).toEqual({
        selections: { model: "model-a" },
        modeId: null,
      });
    });
  });

  it("re-persists a normalized snapshot after load drops stale selections", async () => {
    const repo = new ACPSessionRepositoryWriter();
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("acpNav/list")) {
        return {
          projects: [],
          conversations: [
            {
              id: "conv-1",
              workspacePath: "/repo",
              agentServer: DEFAULT_AGENT_SERVER,
              sessionId: "s-loaded",
              cwd: "/repo",
              active: true,
              archived: false,
              workingDirectories: ["/repo"],
              metadata: {
                processes: [],
                explored: [],
                edited: [],
                sessionConfig: { selections: { model: "model-gone" }, modeId: "gone-mode" },
              },
            },
          ],
        };
      }
      return {};
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: "model",
            type: "select" as const,
            name: "Model",
            currentValue: "model-a",
            options: [
              { value: "model-a", name: "A" },
              { value: "model-b", name: "B" },
            ],
          },
        ],
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
      }),
    });
    await connectRepo(repo, conn);

    await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-1" },
      DEFAULT_AGENT_SERVER,
    );

    await vi.waitFor(() => {
      const upsertCalls = vi
        .mocked(helperJsonrpcCall)
        .mock.calls.filter(([method]) => String(method).includes("acpNav/upsertConversation"));
      expect(upsertCalls.length).toBeGreaterThan(0);
      const params = upsertCalls[upsertCalls.length - 1]![1] as {
        conversation: { metadata: { sessionConfig?: unknown } };
      };
      expect(params.conversation.metadata.sessionConfig).toEqual({
        selections: { model: "model-a" },
        modeId: "default",
      });
    });
  });

  it("clears the stored session config when the agent reports no config surface on load", async () => {
    const repo = new ACPSessionRepositoryWriter();
    helperJsonrpcCall.mockImplementation(async (method: unknown) => {
      if (String(method).includes("acpNav/list")) {
        return {
          projects: [],
          conversations: [
            {
              id: "conv-1",
              workspacePath: "/repo",
              agentServer: DEFAULT_AGENT_SERVER,
              sessionId: "s-loaded",
              cwd: "/repo",
              active: true,
              archived: false,
              workingDirectories: ["/repo"],
              metadata: {
                processes: [],
                explored: [],
                edited: [],
                sessionConfig: { selections: { model: "model-b" }, modeId: "plan" },
              },
            },
          ],
        };
      }
      return {};
    });
    const conn = mockConnection({
      loadSession: vi.fn().mockResolvedValue({}),
    });
    await connectRepo(repo, conn);

    const session = await repo.loadSessionRecord(
      "s-loaded",
      "/repo",
      [],
      { conversationId: "conv-1" },
      DEFAULT_AGENT_SERVER,
    );

    expect(session?.metadata.sessionConfig).toBeUndefined();
    await vi.waitFor(() => {
      const upsertCalls = vi
        .mocked(helperJsonrpcCall)
        .mock.calls.filter(([method]) => String(method).includes("acpNav/upsertConversation"));
      expect(upsertCalls.length).toBeGreaterThan(0);
      const params = upsertCalls[upsertCalls.length - 1]![1] as {
        conversation: { metadata: { sessionConfig?: unknown } };
      };
      expect(params.conversation.metadata.sessionConfig).toBeUndefined();
    });
  });
});
