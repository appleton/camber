import { describe, expect, it } from "vitest";
import {
  conversationToNav,
  countAttentionConversations,
  navToConversationSummary,
  pendingConversationSummary,
  type ACPConversationSummary,
  type ACPNavConversation,
} from "./navTypes";

describe("navTypes", () => {
  it("clones working directories when converting a conversation to nav state", () => {
    const workingDirectories = new Proxy(["/repo"], {}) as string[];
    const nav = conversationToNav("/workspace", conversationSummary({ workingDirectories }));

    expect(nav.workingDirectories).toEqual(["/repo"]);
    expect(nav.workingDirectories).not.toBe(workingDirectories);
    expect(() => structuredClone({ conversation: nav })).not.toThrow();
  });

  it("clones working directories when converting nav state to a conversation summary", () => {
    const workingDirectories = new Proxy(["/repo"], {}) as string[];
    const summary = navToConversationSummary(navConversation({ workingDirectories }));

    expect(summary.workingDirectories).toEqual(["/repo"]);
    expect(summary.workingDirectories).not.toBe(workingDirectories);
  });

  it("maps transient live status from nav state to a conversation summary", () => {
    const liveStatus = { working: true, waitingForUser: false, unread: true };
    const summary = navToConversationSummary(navConversation({ liveStatus }));

    expect(summary.liveStatus).toEqual(liveStatus);
  });

  it("round-trips persisted session metadata through nav state", () => {
    const metadata = {
      processes: ["pnpm test"],
      explored: ["app.ts"],
      edited: [{ fileName: "app.ts", filePath: "./src/app.ts" }],
    };
    const nav = conversationToNav("/workspace", conversationSummary({ metadata }));
    const summary = navToConversationSummary(navConversation({ metadata: nav.metadata }));

    expect(nav.metadata).toEqual(metadata);
    expect(summary.metadata).toEqual(metadata);
  });

  it("normalizes session metadata before sending it to nav persistence", () => {
    const metadata = new Proxy(
      {
        processes: new Proxy(["pnpm test"], {}),
        explored: new Proxy(["app.ts"], {}),
        edited: new Proxy([{ fileName: "app.ts", filePath: "./src/app.ts" }], {}),
        transient: () => "not cloneable",
      },
      {},
    );
    const nav = conversationToNav("/workspace", conversationSummary({ metadata }));

    expect(nav.metadata).toEqual({
      processes: ["pnpm test"],
      explored: ["app.ts"],
      edited: [{ fileName: "app.ts", filePath: "./src/app.ts" }],
    });
    expect(nav.metadata).not.toBe(metadata);
    expect(() => structuredClone({ conversation: nav })).not.toThrow();
  });

  it("does not write transient live status back to nav state", () => {
    const nav = conversationToNav(
      "/workspace",
      conversationSummary({
        liveStatus: { working: true, waitingForUser: false, unread: true },
      }),
    );

    expect(nav.liveStatus).toBeUndefined();
  });

  it("clones working directories for pending conversation summaries", () => {
    const workingDirectories = new Proxy(["/repo"], {}) as string[];
    const summary = pendingConversationSummary({
      id: "conversation:pending",
      cwd: "/repo",
      workingDirectories,
    });

    expect(summary.workingDirectories).toEqual(["/repo"]);
    expect(summary.workingDirectories).not.toBe(workingDirectories);
    expect(summary.draftPromptPresent).toBe(false);
  });

  it("counts active conversations awaiting user attention", () => {
    const conversations = [
      navConversation({
        id: "conversation:approval",
        liveStatus: { working: true, waitingForUser: true, unread: false },
      }),
      navConversation({
        id: "conversation:unread",
        liveStatus: { working: false, waitingForUser: false, unread: true },
      }),
      navConversation({
        id: "conversation:working",
        liveStatus: { working: true, waitingForUser: false, unread: false },
      }),
      navConversation({
        id: "conversation:archived",
        archived: true,
        liveStatus: { working: false, waitingForUser: true, unread: false },
      }),
      navConversation({
        id: "conversation:inactive",
        active: false,
        liveStatus: { working: false, waitingForUser: false, unread: true },
      }),
    ];

    expect(countAttentionConversations(conversations)).toBe(2);
  });

  it("ignores unread sub-agents but still counts ones waiting for the user", () => {
    const conversations = [
      navConversation({
        id: "conversation:parent",
        liveStatus: { working: false, waitingForUser: false, unread: false },
      }),
      navConversation({
        id: "conversation:done-child",
        parentId: "conversation:parent",
        liveStatus: { working: false, waitingForUser: false, unread: true },
      }),
      navConversation({
        id: "conversation:blocked-child",
        parentId: "conversation:parent",
        liveStatus: { working: true, waitingForUser: true, unread: true },
      }),
      navConversation({
        id: "conversation:self-root",
        parentId: "conversation:self-root",
        liveStatus: { working: false, waitingForUser: false, unread: true },
      }),
    ];

    expect(countAttentionConversations(conversations)).toBe(2);
  });

  it("counts attention conversations with live status resolved externally", () => {
    const sessions = [
      conversationSummary({ id: "conversation:approval", sessionId: "session:approval" }),
      conversationSummary({ id: "conversation:unread", sessionId: "session:unread" }),
      conversationSummary({ id: "conversation:idle", sessionId: "session:idle" }),
      conversationSummary({ id: "conversation:pending", sessionId: null }),
    ];
    const liveStatusBySessionId = new Map([
      ["session:approval", { working: true, waitingForUser: true, unread: false }],
      ["session:unread", { working: false, waitingForUser: false, unread: true }],
      ["session:idle", { working: true, waitingForUser: false, unread: false }],
    ]);

    expect(
      countAttentionConversations(sessions, (session) =>
        session.sessionId ? liveStatusBySessionId.get(session.sessionId) : undefined,
      ),
    ).toBe(2);
  });
});

function conversationSummary(
  overrides: Partial<ACPConversationSummary> = {},
): ACPConversationSummary {
  return {
    id: "conversation:1",
    sessionId: "session:1",
    agentServer: "poolside",
    cwd: "/repo",
    workingDirectories: ["/repo"],
    title: "A conversation",
    updatedAt: "2026-05-26T09:00:00.000Z",
    source: "native_session",
    readOnly: false,
    errorMessage: null,
    cancellationReason: null,
    conversationId: null,
    conversationKind: null,
    agentId: null,
    _meta: {},
    ...overrides,
  };
}

function navConversation(overrides: Partial<ACPNavConversation> = {}): ACPNavConversation {
  return {
    id: "conversation:1",
    workspacePath: "/workspace",
    agentServer: "poolside",
    sessionId: "session:1",
    cwd: "/repo",
    title: "A conversation",
    updatedAt: "2026-05-26T09:00:00.000Z",
    active: true,
    archived: false,
    workingDirectories: ["/repo"],
    ...overrides,
  };
}
