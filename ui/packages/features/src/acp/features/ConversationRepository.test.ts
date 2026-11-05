import { initializeStatefulModule as initializeHelperApi } from "@camber/helperapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_SERVER } from "../agentServers";
import { ACP_DESKTOP_CONVERSATIONS_EVENT, ACP_SESSION_CLOSE_EVENT } from "../navTypes";
import { ACPConversationRepositoryWriter } from "./ConversationRepository.svelte";

beforeEach(() => {
  initializeHelperApi({
    jsonrpcCall: vi.fn().mockResolvedValue({ projects: [], conversations: [] }),
    jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
  });
});

describe("ACPConversationRepositoryWriter", () => {
  it("previews a pending conversation before its nav upsert resolves", async () => {
    const upsert = deferredPromise<ReturnType<typeof pendingNavState>>();
    initializeHelperApi({
      jsonrpcCall: vi.fn().mockReturnValue(upsert.promise),
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });

    const repo = new ACPConversationRepositoryWriter();
    const pending = repo.upsertConversation("/workspace", {
      id: "conversation:new",
      sessionId: null,
      agentServer: DEFAULT_AGENT_SERVER,
      cwd: "/workspace",
      workingDirectories: ["/workspace"],
      title: "New conversation",
      updatedAt: "2026-03-30T10:00:00Z",
      source: "native_session",
      readOnly: false,
      errorMessage: null,
      cancellationReason: null,
      conversationId: null,
      conversationKind: null,
      agentId: null,
      _meta: {},
    });

    expect(repo.sessions.map((session) => session.id)).toEqual(["conversation:new"]);

    upsert.resolve(pendingNavState());
    await pending;

    expect(repo.sessions.map((session) => session.id)).toEqual(["conversation:new"]);
  });

  it("persists a title override that arrives while the initial conversation upsert is pending", async () => {
    const firstUpsert = deferredPromise<ReturnType<typeof navState>>();
    const jsonrpcCall = vi
      .fn()
      .mockReturnValueOnce(firstUpsert.promise)
      .mockResolvedValueOnce(navState("hello"));
    initializeHelperApi({
      jsonrpcCall,
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });

    const repo = new ACPConversationRepositoryWriter();
    const upsertPromise = repo.upsertConversation("/workspace", {
      id: "s-new",
      sessionId: "s-new",
      agentServer: DEFAULT_AGENT_SERVER,
      cwd: "/workspace",
      workingDirectories: ["/workspace"],
      title: "Untitled Conversation",
      updatedAt: "2026-03-30T10:00:00Z",
      source: "native_session",
      readOnly: false,
      errorMessage: null,
      cancellationReason: null,
      conversationId: null,
      conversationKind: null,
      agentId: null,
      _meta: {},
    });

    repo.updateSessionTitle("s-new", "hello");
    firstUpsert.resolve(navState("Untitled Conversation"));
    await upsertPromise;

    expect(jsonrpcCall).toHaveBeenCalledTimes(2);
    expect(jsonrpcCall).toHaveBeenLastCalledWith(
      "camber/acpNav/upsertConversation",
      expect.objectContaining({
        conversation: expect.objectContaining({
          sessionId: "s-new",
          title: "hello",
          workspacePath: "/workspace",
        }),
      }),
    );
    expect(repo.getSession("s-new", DEFAULT_AGENT_SERVER)?.title).toBe("hello");
  });

  it("keeps chat scope while persisting turn and generated-title updates", async () => {
    const jsonrpcCall = vi.fn().mockImplementation((method: string, params: unknown) => {
      if (method !== "camber/acpNav/upsertConversation") {
        return Promise.resolve({ projects: [], conversations: [] });
      }
      const conversation = (params as { conversation: ReturnType<typeof navConversation> })
        .conversation;
      return Promise.resolve({ projects: [], conversations: [conversation] });
    });
    initializeHelperApi({
      jsonrpcCall,
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const repo = new ACPConversationRepositoryWriter();
    repo.replaceConversations([
      {
        ...navConversation("chat-1", DEFAULT_AGENT_SERVER, "session-1"),
        workspacePath: "CHAT",
        cwd: "/state/camber/chat-1",
        workingDirectories: ["/state/camber/chat-1"],
      },
    ]);

    repo.touchSession("chat-1");
    await vi.waitFor(() => expect(jsonrpcCall).toHaveBeenCalledTimes(1));
    repo.updateSessionTitle("chat-1", "Generated title");
    await vi.waitFor(() => expect(jsonrpcCall).toHaveBeenCalledTimes(2));

    for (const [, params] of jsonrpcCall.mock.calls) {
      expect(params).toEqual(
        expect.objectContaining({
          conversation: expect.objectContaining({ workspacePath: "CHAT" }),
        }),
      );
    }
    expect(repo.sessions[0]?.workspacePath).toBe("CHAT");
  });

  it("keeps a user nickname ahead of a generated title override", async () => {
    const jsonrpcCall = vi.fn().mockImplementation((method: string, params: unknown) => {
      if (method === "camber/acpNav/renameConversation") {
        const { conversationId, nickname } = params as {
          conversationId: string;
          nickname: string;
        };
        return Promise.resolve({
          projects: [],
          conversations: [
            {
              ...navConversation(conversationId, DEFAULT_AGENT_SERVER),
              title: "hello",
              nickname,
            },
          ],
        });
      }
      return Promise.resolve({ projects: [], conversations: [] });
    });
    initializeHelperApi({
      jsonrpcCall,
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const repo = new ACPConversationRepositoryWriter();
    repo.replaceConversations([
      {
        ...navConversation("s-new", DEFAULT_AGENT_SERVER),
        title: "hello",
      },
    ]);
    repo.updateSessionTitle("s-new", "hello");

    await repo.renameConversation("s-new", "Renamed by user");

    expect(repo.sessions[0]?.title).toBe("Renamed by user");
    expect(repo.sessions[0]?.nickname).toBe("Renamed by user");
  });

  it("renames session-backed conversations when session rename is supported", async () => {
    const jsonrpcCall = vi.fn().mockImplementation((method: string, params: unknown) => {
      if (method === "camber/acpNav/renameConversation") {
        const { conversationId, nickname, title } = params as {
          conversationId: string;
          nickname: string;
          title?: string;
        };
        return Promise.resolve({
          projects: [],
          conversations: [
            {
              ...navConversation(conversationId, DEFAULT_AGENT_SERVER, "s-new"),
              title: title ?? "generated title",
              nickname,
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    initializeHelperApi({
      jsonrpcCall,
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const repo = new ACPConversationRepositoryWriter({
      capabilitiesFor: () =>
        ({
          sessionCapabilities: { rename: {} },
        }) as any,
    });
    repo.replaceConversations([
      {
        ...navConversation("s-new", DEFAULT_AGENT_SERVER, "s-new"),
        title: "Original",
      },
    ]);

    await repo.renameConversation("s-new", "Renamed session");

    expect(jsonrpcCall).toHaveBeenCalledWith(
      "camber/acpNav/renameConversation",
      expect.objectContaining({
        conversationId: "s-new",
        nickname: "Renamed session",
        title: "Renamed session",
      }),
    );
    expect(jsonrpcCall).toHaveBeenCalledWith(
      "camber/acp/_poolside/rename_session",
      expect.objectContaining({
        agentServer: DEFAULT_AGENT_SERVER,
        sessionId: "s-new",
        title: "Renamed session",
      }),
    );
    expect(repo.sessions[0]?.title).toBe("Renamed session");
    expect(repo.sessions[0]?.nickname).toBe("Renamed session");
  });

  it("refreshes conversations when rename persistence fails", async () => {
    const jsonrpcCall = vi.fn().mockImplementation((method: string) => {
      if (method === "camber/acpNav/renameConversation") {
        return Promise.reject(new Error("rename failed"));
      }
      if (method === "camber/acpNav/list") {
        return Promise.resolve({
          projects: [],
          conversations: [
            {
              ...navConversation("s-new", DEFAULT_AGENT_SERVER),
              title: "Original",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    initializeHelperApi({
      jsonrpcCall,
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const repo = new ACPConversationRepositoryWriter();
    repo.replaceConversations([
      {
        ...navConversation("s-new", DEFAULT_AGENT_SERVER),
        title: "Original",
      },
    ]);

    await expect(repo.renameConversation("s-new", "Optimistic")).rejects.toThrow("rename failed");

    expect(jsonrpcCall).toHaveBeenCalledWith("camber/acpNav/list", {});
    expect(repo.sessions[0]?.title).toBe("Original");
    expect(repo.sessions[0]?.nickname).toBeNull();
  });

  it("archives all active conversations for an agent server", async () => {
    const listState = {
      projects: [],
      conversations: [
        navConversation("camber-conv", "poolside", "s-camber"),
        navConversation("echo-conv", "echo", "s-echo"),
        navConversation("echo-pending", "echo"),
      ],
    };
    const archivedState = {
      projects: [],
      conversations: [navConversation("camber-conv", "poolside", "s-camber")],
    };
    const jsonrpcCall = vi.fn().mockImplementation((method: string) => {
      if (method === "camber/acpNav/list") {
        return Promise.resolve(listState);
      }
      return Promise.resolve(archivedState);
    });
    initializeHelperApi({
      jsonrpcCall,
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const repo = new ACPConversationRepositoryWriter();
    repo.replaceConversations([
      navConversation("camber-conv", "poolside", "s-camber"),
      navConversation("echo-conv", "echo", "s-echo"),
      navConversation("echo-pending", "echo"),
    ]);

    await repo.archiveAgentServer("echo");

    expect(repo.sessions.map((session) => session.agentServer)).toEqual(["poolside"]);
    // list + 2 archives + session/close for the one conversation with a session
    expect(jsonrpcCall).toHaveBeenCalledTimes(4);
    expect(jsonrpcCall).toHaveBeenCalledWith("camber/acpNav/list", {});
    expect(jsonrpcCall).toHaveBeenCalledWith("camber/acp/session/close", {
      agentServer: "echo",
      sessionId: "s-echo",
      cancelInFlight: true,
    });
    expect(jsonrpcCall).toHaveBeenCalledWith(
      "camber/acpNav/archiveConversation",
      expect.objectContaining({
        agentServer: "echo",
        sessionId: "s-echo",
        workspacePath: "/repo",
      }),
    );
    expect(jsonrpcCall).toHaveBeenCalledWith(
      "camber/acpNav/archiveConversation",
      expect.objectContaining({
        agentServer: "echo",
        conversationId: "echo-pending",
        workspacePath: "/repo",
      }),
    );
  });

  it("emits a close event when a session is archived", async () => {
    const repo = new ACPConversationRepositoryWriter();
    const closed = vi.fn();
    repo.emitter.addEventListener(ACP_SESSION_CLOSE_EVENT, closed);

    await repo.archiveSession("/repo", "s-echo", "echo", "echo-conv");

    expect(closed).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          sessionId: "s-echo",
          conversationId: "echo-conv",
          agentServer: "echo",
        },
      }),
    );
  });

  it("closes the agent session when archiving", async () => {
    const jsonrpcCall = vi.fn().mockResolvedValue({ projects: [], conversations: [] });
    initializeHelperApi({
      jsonrpcCall,
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const repo = new ACPConversationRepositoryWriter();

    await repo.archiveSession("/repo", "s-echo", "echo", "echo-conv");

    expect(jsonrpcCall).toHaveBeenCalledWith("camber/acp/session/close", {
      agentServer: "echo",
      sessionId: "s-echo",
      cancelInFlight: true,
    });
  });

  it("does not call session/close when archiving a pending conversation", async () => {
    const jsonrpcCall = vi.fn().mockResolvedValue({ projects: [], conversations: [] });
    initializeHelperApi({
      jsonrpcCall,
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const repo = new ACPConversationRepositoryWriter();

    await repo.archiveSession("/repo", null, "echo", "echo-pending");

    expect(jsonrpcCall).not.toHaveBeenCalledWith("camber/acp/session/close", expect.anything());
  });

  it("still archives and emits the close event when session/close fails", async () => {
    const jsonrpcCall = vi.fn().mockImplementation((method: string) => {
      if (method === "camber/acp/session/close") {
        return Promise.reject(new Error("close failed"));
      }
      return Promise.resolve({ projects: [], conversations: [] });
    });
    initializeHelperApi({
      jsonrpcCall,
      jsonrpcNotify: vi.fn().mockResolvedValue(undefined),
    });
    const repo = new ACPConversationRepositoryWriter();
    const closed = vi.fn();
    repo.emitter.addEventListener(ACP_SESSION_CLOSE_EVENT, closed);

    await repo.archiveSession("/repo", "s-echo", "echo", "echo-conv");

    expect(closed).toHaveBeenCalled();
  });

  it("emits a close event when a pending conversation is archived", async () => {
    const repo = new ACPConversationRepositoryWriter();
    const closed = vi.fn();
    repo.emitter.addEventListener(ACP_SESSION_CLOSE_EVENT, closed);

    await repo.archiveSession("/repo", null, "echo", "echo-pending");

    expect(closed).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          sessionId: null,
          conversationId: "echo-pending",
          agentServer: "echo",
        },
      }),
    );
  });

  it("previews a draft title from typed text and falls back to 'New conversation' when empty", () => {
    const repo = new ACPConversationRepositoryWriter();
    repo.replaceConversations([
      { ...navConversation("draft-1", DEFAULT_AGENT_SERVER), title: "New conversation" },
    ]);

    repo.setDraftTitle("draft-1", "Fix the flaky test\nmore detail");
    expect(repo.sessions[0]?.title).toBe("Fix the flaky test more detail");
    expect(repo.sessions[0]?.draftPromptPresent).toBe(true);

    // Whitespace-only input reverts to the default (previously left it inconsistent).
    repo.setDraftTitle("draft-1", "   ");
    expect(repo.sessions[0]?.title).toBe("New conversation");
    expect(repo.sessions[0]?.draftPromptPresent).toBe(false);

    repo.setDraftTitle("draft-1", "Draft again");
    expect(repo.sessions[0]?.title).toBe("Draft again");
    expect(repo.sessions[0]?.draftPromptPresent).toBe(true);

    // Emptying the draft reverts to the fallback.
    repo.setDraftTitle("draft-1", "");
    expect(repo.sessions[0]?.title).toBe("New conversation");
    expect(repo.sessions[0]?.draftPromptPresent).toBe(false);
  });

  it("does not preview a draft title over a user nickname", () => {
    const repo = new ACPConversationRepositoryWriter();
    repo.replaceConversations([
      {
        ...navConversation("draft-1", DEFAULT_AGENT_SERVER),
        title: "Renamed by user",
        nickname: "Renamed by user",
      },
    ]);

    repo.setDraftTitle("draft-1", "Typed prompt");

    expect(repo.sessions[0]?.title).toBe("Renamed by user");
    expect(repo.sessions[0]?.nickname).toBe("Renamed by user");
    expect(repo.sessions[0]?.draftPromptPresent).toBe(true);
  });

  it("tracks draft text for session-backed conversations without changing the title", () => {
    const repo = new ACPConversationRepositoryWriter();
    repo.replaceConversations([
      {
        ...navConversation("conversation-1", DEFAULT_AGENT_SERVER, "session-1"),
        title: "Existing title",
      },
    ]);

    repo.setDraftPromptPresence("conversation-1", true);

    expect(repo.sessions[0]?.title).toBe("Existing title");
    expect(repo.sessions[0]?.draftPromptPresent).toBe(true);

    repo.setDraftPromptPresence("conversation-1", false);
    expect(repo.sessions[0]?.title).toBe("Existing title");
    expect(repo.sessions[0]?.draftPromptPresent).toBe(false);
  });

  it("does not emit conversation state when draft prompt presence is unchanged", () => {
    const repo = new ACPConversationRepositoryWriter();
    repo.replaceConversations([
      {
        ...navConversation("conversation-1", DEFAULT_AGENT_SERVER, "session-1"),
        title: "Existing title",
      },
    ]);
    const emitted = vi.fn();
    repo.emitter.addEventListener(ACP_DESKTOP_CONVERSATIONS_EVENT, emitted);

    repo.setDraftPromptPresence("conversation-1", true);
    repo.setDraftPromptPresence("conversation-1", true);
    repo.setDraftPromptPresence("conversation-1", true);

    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it("does not emit conversation state when a draft title preview is unchanged", () => {
    const repo = new ACPConversationRepositoryWriter();
    repo.replaceConversations([
      { ...navConversation("draft-1", DEFAULT_AGENT_SERVER), title: "New conversation" },
    ]);
    const emitted = vi.fn();
    repo.emitter.addEventListener(ACP_DESKTOP_CONVERSATIONS_EVENT, emitted);

    repo.setDraftTitle("draft-1", "Draft title");
    repo.setDraftTitle("draft-1", "Draft title");
    repo.setDraftTitle("draft-1", "Draft title");

    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it("applies a draft title preview recorded before the conversation appears", () => {
    const repo = new ACPConversationRepositoryWriter();
    const emitted = vi.fn();
    repo.emitter.addEventListener(ACP_DESKTOP_CONVERSATIONS_EVENT, emitted);

    repo.setDraftTitle("draft-1", "Queued draft");
    expect(emitted).not.toHaveBeenCalled();

    repo.replaceConversations([
      { ...navConversation("draft-1", DEFAULT_AGENT_SERVER), title: "New conversation" },
    ]);

    expect(repo.sessions[0]?.title).toBe("Queued draft");
    expect(repo.sessions[0]?.draftPromptPresent).toBe(true);
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it("applies draft prompt presence recorded before the conversation appears", () => {
    const repo = new ACPConversationRepositoryWriter();
    const emitted = vi.fn();
    repo.emitter.addEventListener(ACP_DESKTOP_CONVERSATIONS_EVENT, emitted);

    repo.setDraftPromptPresence("conversation-1", true);
    expect(emitted).not.toHaveBeenCalled();

    repo.replaceConversations([
      {
        ...navConversation("conversation-1", DEFAULT_AGENT_SERVER, "session-1"),
        title: "Existing title",
      },
    ]);

    expect(repo.sessions[0]?.title).toBe("Existing title");
    expect(repo.sessions[0]?.draftPromptPresent).toBe(true);
    expect(emitted).toHaveBeenCalledTimes(1);
  });
});

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function navState(title: string) {
  return {
    projects: [],
    conversations: [
      {
        id: "s-new",
        workspacePath: "/workspace",
        agentServer: DEFAULT_AGENT_SERVER,
        sessionId: "s-new",
        cwd: "/workspace",
        title,
        updatedAt: "2026-03-30T10:00:00Z",
        active: true,
        archived: false,
        workingDirectories: ["/workspace"],
      },
    ],
  };
}

function pendingNavState() {
  return {
    projects: [],
    conversations: [
      {
        id: "conversation:new",
        workspacePath: "/workspace",
        agentServer: DEFAULT_AGENT_SERVER,
        cwd: "/workspace",
        title: "New conversation",
        updatedAt: "2026-03-30T10:00:00Z",
        active: true,
        archived: false,
        workingDirectories: ["/workspace"],
      },
    ],
  };
}

function navConversation(id: string, agentServer: string, sessionId?: string) {
  return {
    id,
    workspacePath: "/repo",
    agentServer,
    ...(sessionId ? { sessionId } : {}),
    cwd: "/repo",
    title: id,
    active: true,
    archived: false,
    workingDirectories: ["/repo"],
  };
}
