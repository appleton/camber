import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import { camberAcpNavList } from "@camber/helperapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_SERVER } from "../agentServers";
import {
  AggregatedSessionListSource,
  emptyAggregatedSessionList,
  supportsSessionDelete,
  type AggregatedSessionList,
} from "./HistoryRepository.svelte";
import { ACPLocalHistoryRepositoryWriter } from "./LocalHistoryRepository.svelte";

vi.mock("@camber/helperapi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@camber/helperapi")>()),
  camberAcpNavList: vi.fn(),
}));

const navListMock = vi.mocked(camberAcpNavList);

// Nav state with every listed session archived, so they all appear in the
// archive view.
function archivedNavState() {
  return {
    projects: [{ path: "/workspace", name: "workspace", isWorktree: false }],
    conversations: ["s-native", "conversation:agentic", "conversation:legacy"].map((sessionId) => ({
      id: sessionId,
      workspacePath: "/workspace",
      agentServer: "poolside",
      sessionId,
      cwd: "/workspace",
      title: sessionId,
      updatedAt: "2026-03-30T10:00:00Z",
      active: false,
      archived: true,
      workingDirectories: ["/workspace"],
    })),
  };
}

beforeEach(() => {
  navListMock.mockReset();
  navListMock.mockResolvedValue(archivedNavState() as never);
});

function mockConnection(overrides: Partial<ClientSideConnection> = {}): ClientSideConnection {
  return {
    listSessions: vi.fn().mockResolvedValue({
      sessions: [
        {
          sessionId: "s-native",
          cwd: "/workspace",
          title: "Native chat",
          updatedAt: "2026-03-30T10:00:00Z",
          _meta: {
            "camber/source": "native_session",
            "camber/read_only": false,
          },
        },
        {
          sessionId: "conversation:agentic",
          cwd: "/workspace",
          title: "Agentic conversation",
          updatedAt: "2026-03-30T09:00:00Z",
          _meta: {
            "camber/source": "conversation",
            "camber/read_only": true,
            "camber/conversation_id": "agentic",
            "camber/conversation_kind": "agentic",
          },
        },
        {
          sessionId: "conversation:legacy",
          cwd: "/workspace",
          title: "Legacy chat",
          updatedAt: "2026-03-30T08:00:00Z",
          _meta: {
            "camber/source": "conversation",
            "camber/read_only": true,
            "camber/conversation_id": "legacy",
            "camber/conversation_kind": "legacy",
          },
        },
      ],
    }),
    ...overrides,
  } as unknown as ClientSideConnection;
}

const listableCapabilities = {
  agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
} as never;

function defaultListSource() {
  return new AggregatedSessionListSource(
    () => [DEFAULT_AGENT_SERVER],
    async () => mockConnection(),
    () => listableCapabilities,
  );
}

function agentListWith(
  sessions: AggregatedSessionList["sessions"],
  completeServers = [DEFAULT_AGENT_SERVER],
): AggregatedSessionList {
  return { sessions, failures: [], listedServers: completeServers, completeServers };
}

describe("AggregatedSessionListSource", () => {
  it("loads and normalizes ACP sessions", async () => {
    const source = defaultListSource();
    const { sessions, failures, completeServers } = await source.list("/workspace");

    expect(failures).toEqual([]);
    expect(completeServers).toEqual([DEFAULT_AGENT_SERVER]);
    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toMatchObject({
      sessionId: "s-native",
      source: "native_session",
      agentServer: DEFAULT_AGENT_SERVER,
      readOnly: false,
      conversationKind: null,
    });
    expect(sessions[1]).toMatchObject({
      sessionId: "conversation:agentic",
      source: "conversation",
      readOnly: true,
      conversationId: "agentic",
      conversationKind: "agentic",
    });
    expect(sessions[2]).toMatchObject({
      sessionId: "conversation:legacy",
      source: "conversation",
      readOnly: true,
      conversationId: "legacy",
      conversationKind: "legacy",
    });
    expect(sessions[2]?.title).toBe("Legacy chat");
  });

  it("skips servers that do not advertise session/list", async () => {
    const listable = mockConnection();
    const unlistable = mockConnection();
    const source = new AggregatedSessionListSource(
      () => [DEFAULT_AGENT_SERVER, "echo"],
      async (agentServer) => (agentServer === DEFAULT_AGENT_SERVER ? listable : unlistable),
      (agentServer) =>
        agentServer === DEFAULT_AGENT_SERVER
          ? listableCapabilities
          : ({
              agentCapabilities: { loadSession: false, sessionCapabilities: {} },
            } as never),
    );

    const { sessions, failures } = await source.list("/workspace");

    expect(sessions).toHaveLength(3);
    expect(sessions.every((session) => session.agentServer === DEFAULT_AGENT_SERVER)).toBe(true);
    expect(failures).toEqual([]);
    expect(unlistable.listSessions).not.toHaveBeenCalled();
  });

  it("keeps healthy servers' sessions when another server fails", async () => {
    const healthy = mockConnection();
    const broken = mockConnection({
      listSessions: vi.fn().mockRejectedValue(new Error("not authenticated")),
    } as Partial<ClientSideConnection>);
    const source = new AggregatedSessionListSource(
      () => [DEFAULT_AGENT_SERVER, "flaky"],
      async (agentServer) => (agentServer === DEFAULT_AGENT_SERVER ? healthy : broken),
      () => listableCapabilities,
    );

    const { sessions, failures, listedServers, completeServers } = await source.list("/workspace");

    expect(sessions).toHaveLength(3);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.agentServer).toBe("flaky");
    expect(failures[0]?.error.message).toContain("not authenticated");
    expect(listedServers).toEqual([DEFAULT_AGENT_SERVER]);
    expect(completeServers).toEqual([DEFAULT_AGENT_SERVER]);
  });

  it("records a failure when a server never responds", async () => {
    const hung = {
      listSessions: vi.fn().mockReturnValue(new Promise(() => {})),
    } as unknown as ClientSideConnection;
    const source = new AggregatedSessionListSource(
      () => [DEFAULT_AGENT_SERVER],
      async () => hung,
      () => listableCapabilities,
      { timeoutMs: 5 },
    );

    const { sessions, failures } = await source.list("/workspace");

    expect(sessions).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error.message).toContain("Timed out");
  });

  it("reuses the in-flight request for a hung server instead of spawning more", async () => {
    let resolveHung!: (value: { sessions: unknown[] }) => void;
    const listSessions = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => (resolveHung = resolve)));
    const source = new AggregatedSessionListSource(
      () => [DEFAULT_AGENT_SERVER],
      async () => ({ listSessions }) as unknown as ClientSideConnection,
      () => listableCapabilities,
      { timeoutMs: 5 },
    );

    // Both refreshes time out, but the hung request is shared: no
    // per-refresh amplification of pending listSessions calls.
    await source.list("/workspace");
    await source.list("/workspace");
    expect(listSessions).toHaveBeenCalledTimes(1);

    // Once the request settles, the dedupe entry clears and the next
    // refresh issues a fresh request.
    resolveHung({ sessions: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await source.list("/workspace");
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it("follows nextCursor pagination to the end of the results", async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "s-1", cwd: "/workspace" }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "s-2", cwd: "/workspace" }],
      });
    const source = new AggregatedSessionListSource(
      () => [DEFAULT_AGENT_SERVER],
      async () => ({ listSessions }) as unknown as ClientSideConnection,
      () => listableCapabilities,
    );

    const { sessions, completeServers } = await source.list("/workspace");

    expect(sessions.map((session) => session.sessionId)).toEqual(["s-1", "s-2"]);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenLastCalledWith({ cwd: "/workspace", cursor: "page-2" });
    expect(completeServers).toEqual([DEFAULT_AGENT_SERVER]);
  });

  it("stops paginating at the session cap and reports the list as incomplete", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [{ sessionId: "s-1", cwd: "/workspace" }],
      nextCursor: "more",
    });
    const source = new AggregatedSessionListSource(
      () => [DEFAULT_AGENT_SERVER],
      async () => ({ listSessions }) as unknown as ClientSideConnection,
      () => listableCapabilities,
      { maxSessionsPerServer: 1 },
    );

    const { sessions, completeServers } = await source.list("/workspace");

    expect(sessions).toHaveLength(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(completeServers).toEqual([]);
  });

  it("stops paginating when a cursor arrives with an empty page", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [],
      nextCursor: "always-more",
    });
    const source = new AggregatedSessionListSource(
      () => [DEFAULT_AGENT_SERVER],
      async () => ({ listSessions }) as unknown as ClientSideConnection,
      () => listableCapabilities,
    );

    const { sessions, completeServers } = await source.list("/workspace");

    expect(sessions).toHaveLength(0);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(completeServers).toEqual([]);
  });

  it("bounds pagination with a hard page cap even when pages keep progressing", async () => {
    let page = 0;
    const listSessions = vi.fn().mockImplementation(async () => ({
      sessions: [{ sessionId: `s-${page}`, cwd: "/workspace" }],
      nextCursor: `page-${(page += 1)}`,
    }));
    const source = new AggregatedSessionListSource(
      () => [DEFAULT_AGENT_SERVER],
      async () => ({ listSessions }) as unknown as ClientSideConnection,
      () => listableCapabilities,
    );

    const { sessions, completeServers } = await source.list("/workspace");

    expect(listSessions).toHaveBeenCalledTimes(100);
    expect(sessions).toHaveLength(100);
    expect(completeServers).toEqual([]);
  });

  it("clamps a single oversized page to the session cap and reports it incomplete", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [
        { sessionId: "s-1", cwd: "/workspace" },
        { sessionId: "s-2", cwd: "/workspace" },
        { sessionId: "s-3", cwd: "/workspace" },
      ],
    });
    const source = new AggregatedSessionListSource(
      () => [DEFAULT_AGENT_SERVER],
      async () => ({ listSessions }) as unknown as ClientSideConnection,
      () => listableCapabilities,
      { maxSessionsPerServer: 2 },
    );

    const { sessions, completeServers } = await source.list("/workspace");

    expect(sessions.map((session) => session.sessionId)).toEqual(["s-1", "s-2"]);
    // The dropped tail must not be reported as "deleted agent-side".
    expect(completeServers).toEqual([]);
  });

  it("detects session delete support from session capabilities", () => {
    expect(
      supportsSessionDelete({
        sessionCapabilities: { delete: {} },
      } as never),
    ).toBe(true);

    expect(supportsSessionDelete({ sessionCapabilities: {} } as never)).toBe(false);
    expect(supportsSessionDelete({} as never)).toBe(false);
    expect(supportsSessionDelete(null)).toBe(false);
  });
});

describe("ACPLocalHistoryRepositoryWriter", () => {
  it("renders archived nav conversations before agents respond", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource({ list: vi.fn().mockReturnValue(new Promise(() => {})) });

    await repo.refresh("/workspace");

    expect(repo.state.status).toBe("success");
    expect(repo.sessions).toHaveLength(3);
    expect(repo.reconciling).toBe(true);
    // Availability is unknown until the agents answer.
    expect(repo.sessions.every((session) => session.sessionAvailable === undefined)).toBe(true);
  });

  it("reconciles agent titles and flags sessions the agent no longer has", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource(defaultListSource());
    navListMock.mockResolvedValue({
      projects: [{ path: "/workspace", name: "workspace", isWorktree: false }],
      conversations: [
        {
          id: "s-native",
          workspacePath: "/workspace",
          agentServer: "poolside",
          sessionId: "s-native",
          cwd: "/workspace",
          title: "stale title",
          updatedAt: "2026-03-29T10:00:00Z",
          active: false,
          archived: true,
          workingDirectories: ["/workspace"],
        },
        {
          id: "s-gone",
          workspacePath: "/workspace",
          agentServer: "poolside",
          sessionId: "s-gone",
          cwd: "/workspace",
          title: "Deleted agent-side",
          updatedAt: "2026-03-28T10:00:00Z",
          active: false,
          archived: true,
          workingDirectories: ["/workspace"],
        },
      ],
    } as never);

    await repo.refresh("/workspace");
    await repo.reconcilePromise;

    expect(repo.state.status).toBe("success");
    const native = repo.sessions.find((session) => session.sessionId === "s-native");
    const gone = repo.sessions.find((session) => session.sessionId === "s-gone");
    expect(native?.title).toBe("Native chat");
    expect(native?.sessionAvailable).toBe(true);
    expect(gone?.sessionAvailable).toBe(false);
    expect(repo.listFailures).toEqual([]);
  });

  it("keeps a user-set nickname over the agent's title", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource(defaultListSource());
    const navState = archivedNavState();
    (navState.conversations[0] as { nickname?: string }).nickname = "My renamed chat";
    navListMock.mockResolvedValue(navState as never);

    await repo.refresh("/workspace");
    await repo.reconcilePromise;

    const renamed = repo.sessions.find((session) => session.sessionId === "s-native");
    expect(renamed?.title).toBe("My renamed chat");
  });

  it("keeps the archive usable when every agent fails to list", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource({ list: vi.fn().mockRejectedValue(new Error("boom")) });

    await repo.refresh("/workspace");
    await repo.reconcilePromise;

    expect(repo.state.status).toBe("success");
    expect(repo.sessions).toHaveLength(3);
    expect(repo.listFailures).toHaveLength(1);
    expect(repo.sessions.every((session) => session.sessionAvailable === undefined)).toBe(true);
  });

  it("surfaces failures only when no agent server produced a list", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource({
      list: vi.fn().mockResolvedValue({
        ...emptyAggregatedSessionList(),
        failures: [
          { agentServer: "flaky", error: new Error("no auth") },
          { agentServer: "dead", error: new Error("timeout") },
        ],
      }),
    });

    await repo.refresh("/workspace");
    await repo.reconcilePromise;

    expect(repo.state.status).toBe("success");
    expect(repo.listFailures.map((failure) => failure.agentServer)).toEqual(["flaky", "dead"]);
  });

  it("stays silent about failures while at least one agent server listed", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource({
      list: vi.fn().mockResolvedValue({
        ...emptyAggregatedSessionList(),
        listedServers: [DEFAULT_AGENT_SERVER],
        completeServers: [DEFAULT_AGENT_SERVER],
        failures: [{ agentServer: "flaky", error: new Error("no auth") }],
      }),
    });

    await repo.refresh("/workspace");
    await repo.reconcilePromise;

    expect(repo.state.status).toBe("success");
    expect(repo.listFailures).toEqual([]);
  });

  it("fails the page only when local nav state cannot be read", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource(defaultListSource());
    navListMock.mockRejectedValue(new Error("helper down"));

    await repo.refresh("/workspace");

    expect(repo.state.status).toBe("failure");
    expect(repo.state.status === "failure" && repo.state.error.message).toBe("helper down");
  });

  it("scopes a project filter to the project and its worktrees", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource({ list: vi.fn().mockResolvedValue(emptyAggregatedSessionList()) });
    navListMock.mockResolvedValue({
      projects: [
        { path: "/project", name: "project", isWorktree: false },
        {
          path: "/worktrees/hot-harbor",
          name: "hot-harbor",
          isWorktree: true,
          parentPath: "/project",
        },
        { path: "/other", name: "other", isWorktree: false },
      ],
      conversations: [
        conversation("in-project", "/project", "/project"),
        conversation("in-worktree", "/worktrees/hot-harbor", "/worktrees/hot-harbor"),
        conversation("elsewhere", "/other", "/other"),
      ],
    } as never);

    await repo.refresh("/project");

    expect(repo.sessions.map((session) => session.id).sort()).toEqual([
      "in-project",
      "in-worktree",
    ]);
  });

  it("includes rehomed worktree conversations whose worktree is gone", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource({ list: vi.fn().mockResolvedValue(emptyAggregatedSessionList()) });
    navListMock.mockResolvedValue({
      projects: [{ path: "/project", name: "project", isWorktree: false }],
      conversations: [
        // workspacePath was rehomed to the parent project on worktree removal;
        // cwd still points at the deleted worktree directory.
        conversation("rehomed", "/project", "/worktrees/removed-worktree"),
      ],
    } as never);

    await repo.refresh("/project");

    expect(repo.sessions.map((session) => session.id)).toEqual(["rehomed"]);
    expect(repo.sessions[0]?.cwd).toBe("/worktrees/removed-worktree");
    expect(repo.sessions[0]?.workspacePath).toBe("/project");
  });

  it("drops archived drafts that have no agent session", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource({ list: vi.fn().mockResolvedValue(emptyAggregatedSessionList()) });
    navListMock.mockResolvedValue({
      projects: [],
      conversations: [{ ...conversation("draft", "/project", "/project"), sessionId: undefined }],
    } as never);

    await repo.refresh("/project");

    expect(repo.sessions).toHaveLength(0);
  });

  it("clears the reconciling flag when a re-open is served from cache", async () => {
    let resolveFirst!: (value: AggregatedSessionList) => void;
    let resolveSecond!: (value: AggregatedSessionList) => void;
    const list = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource({ list });

    await repo.refresh("/workspace"); // reconcile #1 in flight
    await repo.refresh("/workspace"); // reconcile #2 in flight, owns the flag
    expect(repo.reconciling).toBe(true);

    // The stale reconcile seeds the cache but must not clear the flag (#2 is
    // still running).
    resolveFirst(emptyAggregatedSessionList());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repo.reconciling).toBe(true);

    // A re-open served from the fresh cache owns no reconcile; the flag must
    // not stay stuck on "Refreshing…".
    await repo.refresh("/workspace");
    expect(repo.reconciling).toBe(false);

    resolveSecond(emptyAggregatedSessionList());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repo.reconciling).toBe(false);
  });

  it("reuses the cached agent reconcile on quick re-opens", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    const list = vi.fn().mockResolvedValue(
      agentListWith([
        {
          id: "s-native",
          sessionId: "s-native",
          cwd: "/workspace",
          title: "Native chat",
          updatedAt: "2026-03-30T10:00:00Z",
          agentServer: DEFAULT_AGENT_SERVER,
          workingDirectories: ["/workspace"],
          source: "native_session",
          readOnly: false,
          errorMessage: null,
          cancellationReason: null,
          conversationId: null,
          conversationKind: null,
          agentId: null,
          _meta: {},
        },
      ]),
    );
    repo.setListSource({ list });

    await repo.refresh("/workspace");
    await repo.reconcilePromise;
    await repo.refresh("/workspace");

    expect(list).toHaveBeenCalledTimes(1);
    expect(repo.state.status).toBe("success");
    expect(
      repo.sessions.find((session) => session.sessionId === "s-native")?.sessionAvailable,
    ).toBe(true);
  });

  it("optimistically removes a deleted session from local history state", async () => {
    const repo = new ACPLocalHistoryRepositoryWriter();
    repo.setListSource(defaultListSource());
    await repo.refresh("/workspace");
    await repo.reconcilePromise;

    repo.deleteSession("s-native", DEFAULT_AGENT_SERVER);

    expect(repo.sessions.map((session) => session.sessionId)).toEqual([
      "conversation:agentic",
      "conversation:legacy",
    ]);
  });
});

function conversation(id: string, workspacePath: string, cwd: string) {
  return {
    id,
    workspacePath,
    agentServer: "poolside",
    sessionId: `session-${id}`,
    cwd,
    title: id,
    updatedAt: "2026-03-30T10:00:00Z",
    active: false,
    archived: true,
    workingDirectories: [cwd],
  };
}
