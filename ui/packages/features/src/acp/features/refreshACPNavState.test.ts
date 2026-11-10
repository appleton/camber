import { camberAcpNavList } from "@camber/helperapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACPConversationRepositoryWriter } from "./ConversationRepository.svelte";
import { ACPProjectRepositoryWriter } from "./ProjectRepository.svelte";
import { refreshACPNavState } from "./refreshACPNavState";

vi.mock("@camber/helperapi", () => ({
  camberAcpNavList: vi.fn(),
}));

describe("refreshACPNavState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes projects and conversations with one acpNav/list request", async () => {
    vi.mocked(camberAcpNavList).mockResolvedValue({
      projects: [
        {
          path: "/repo",
          name: "repo",
          isWorktree: false,
          collapsed: false,
          displayOrder: 0,
          createdAt: "2026-06-19T10:00:00Z",
          updatedAt: "2026-06-19T10:00:00Z",
        },
      ],
      conversations: [
        {
          id: "conv-1",
          workspacePath: "/repo",
          cwd: "/repo",
          agentServer: "poolside",
          sessionId: "session-1",
          title: "Conversation",
          active: true,
          archived: false,
          updatedAt: "2026-06-19T10:00:00Z",
          workingDirectories: ["/repo"],
        },
      ],
    });
    const projects = new ACPProjectRepositoryWriter();
    const conversations = new ACPConversationRepositoryWriter();

    await refreshACPNavState(projects, conversations);

    expect(camberAcpNavList).toHaveBeenCalledOnce();
    expect(projects.projects).toEqual([expect.objectContaining({ path: "/repo" })]);
    expect(conversations.sessions).toEqual([expect.objectContaining({ id: "conv-1" })]);
  });

  it("falls back to repository refresh error handling when acpNav/list fails", async () => {
    vi.mocked(camberAcpNavList).mockRejectedValue(new Error("boom"));
    const projects = {
      applyNavState: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    const conversations = {
      applyNavState: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
    };

    await refreshACPNavState(projects, conversations);

    expect(camberAcpNavList).toHaveBeenCalledOnce();
    expect(projects.applyNavState).not.toHaveBeenCalled();
    expect(conversations.applyNavState).not.toHaveBeenCalled();
    expect(projects.refresh).toHaveBeenCalledWith({ showLoading: false });
    expect(conversations.refresh).toHaveBeenCalledWith({ showLoading: false });
  });
});
