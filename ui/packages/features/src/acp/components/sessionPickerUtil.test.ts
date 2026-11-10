import { describe, expect, it } from "vitest";
import type { ACPConversationSummary, ACPNavProject } from "../navTypes";
import { ACP_CHAT_WORKSPACE_PATH } from "../workspaceScope";
import { groupSessionsByProject } from "./sessionPickerUtil";

describe("groupSessionsByProject", () => {
  it("groups root and worktree sessions under the parent project", () => {
    const projects = [
      project("/code/assistant", { name: "assistant", nickname: "Camber" }),
      project("/worktrees/assistant/feature", {
        name: "feature",
        isWorktree: true,
        parentPath: "/code/assistant",
      }),
    ];
    const sessions = [
      session("root", "/code/assistant", "Root chat", "2026-05-14T00:00:00Z"),
      session("chat", "/state/chats/chat", "Projectless chat", "2026-05-16T00:00:00Z", {
        workspacePath: ACP_CHAT_WORKSPACE_PATH,
      }),
      session("worktree", "/worktrees/assistant/feature", "Worktree chat", "2026-05-15T00:00:00Z", {
        workspacePath: "/worktrees/assistant/feature",
      }),
      session("removed", "/code/old-project", "Removed project", "2026-05-13T00:00:00Z"),
    ];

    const buckets = groupSessionsByProject(sessions, "", projects);

    expect(buckets.map((bucket) => bucket.title)).toEqual(["Chats", "Camber"]);
    expect(buckets[1]?.sessions.map((item) => item.session.id)).toEqual(["worktree", "root"]);
    expect(
      buckets.flatMap((bucket) => bucket.sessions).map((item) => item.session.id),
    ).not.toContain("removed");
  });

  it("puts Chats first and sorts project buckets like the project filter", () => {
    const projects = [project("/code/zulu"), project("/code/Alpha")];
    const sessions = [
      session("zulu", "/code/zulu", "Zulu project", "2026-05-16T00:00:00Z"),
      session("alpha", "/code/Alpha", "Alpha project", "2026-05-15T00:00:00Z"),
      session("chat", "/state/chats/chat", "Projectless chat", "2026-05-14T00:00:00Z", {
        workspacePath: ACP_CHAT_WORKSPACE_PATH,
      }),
    ];

    const buckets = groupSessionsByProject(sessions, "", projects);

    expect(buckets.map((bucket) => bucket.title)).toEqual(["Chats", "Alpha", "zulu"]);
  });

  it("keeps project buckets while filtering by title", () => {
    const buckets = groupSessionsByProject(
      [
        session("alpha", "/code/alpha", "Fix authentication", "2026-05-15T00:00:00Z"),
        session("beta", "/code/beta", "Polish archive", "2026-05-14T00:00:00Z"),
      ],
      "archive",
      [project("/code/alpha"), project("/code/beta")],
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.title).toBe("beta");
    expect(buckets[0]?.sessions[0]?.session.id).toBe("beta");
  });

  it("requires a contiguous case-insensitive title match", () => {
    const buckets = groupSessionsByProject(
      [
        session("scattered", "/code/project", "Hi tell me a story", "2026-05-15T00:00:00Z"),
        session("contiguous", "/code/project", "Run TEST coverage", "2026-05-14T00:00:00Z"),
      ],
      "test",
      [project("/code/project")],
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.sessions).toEqual([
      expect.objectContaining({
        matchIndices: [4, 5, 6, 7],
        matchScore: 4,
        session: expect.objectContaining({ id: "contiguous" }),
      }),
    ]);
  });

  it("does not match text from appended host context", () => {
    const titleWithContext = [
      "Visible conversation titlecamber://host-context.md",
      '<context ref="camber://host-context.md">',
      "<camber-system-instructions>",
      "Secret context phrase",
      "</camber-system-instructions>",
      "</context>",
    ].join("\n");
    const sessions = [
      session("context", "/code/project", titleWithContext, "2026-05-15T00:00:00Z"),
    ];
    const projects = [project("/code/project")];

    expect(groupSessionsByProject(sessions, "secret", projects)).toEqual([]);
    expect(
      groupSessionsByProject(sessions, "VISIBLE CONVERSATION", projects)[0]?.sessions[0]?.session
        .id,
    ).toBe("context");
  });
});

function project(path: string, overrides: Partial<ACPNavProject> = {}): ACPNavProject {
  return {
    path,
    name: path.split("/").filter(Boolean).at(-1) ?? path,
    isWorktree: false,
    collapsed: false,
    displayOrder: 0,
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...overrides,
  };
}

function session(
  id: string,
  cwd: string,
  title: string,
  updatedAt: string,
  overrides: Partial<ACPConversationSummary> = {},
): ACPConversationSummary {
  return {
    id,
    sessionId: id,
    cwd,
    title,
    updatedAt,
    agentServer: "poolside",
    source: "native_session",
    readOnly: false,
    errorMessage: null,
    cancellationReason: null,
    conversationId: id,
    conversationKind: null,
    workingDirectories: [cwd],
    agentId: null,
    _meta: {},
    ...overrides,
  };
}
