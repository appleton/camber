import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ACPConversationSummary } from "../../navTypes";
import ConversationRowPopoverContent from "./ConversationRowPopoverContent.svelte";

const sidebar = vi.hoisted(() => ({
  liveSessionFor: vi.fn(() => null),
}));

const getPromptContext = vi.hoisted(() => vi.fn(async () => []));

vi.mock("./SidebarController.svelte", () => ({
  getAcpSidebarController: () => sidebar,
}));

vi.mock("../../features/GithubRepository.svelte", () => ({
  getACPGithubRepo: () => ({ branchFor: () => "" }),
}));

vi.mock("../../hostRpc", () => ({
  rpc: { getPromptContext },
}));

const session: ACPConversationSummary = {
  id: "conversation-1",
  sessionId: "session-1",
  agentServer: "poolside",
  workingDirectories: ["/repo"],
  cwd: "/repo",
  title: "Conversation title",
  updatedAt: null,
  source: "native_session",
  readOnly: false,
  errorMessage: null,
  cancellationReason: null,
  conversationId: "conversation-1",
  conversationKind: "agentic",
  agentId: null,
  _meta: {},
};

describe("ConversationRowPopoverContent", () => {
  beforeEach(() => {
    sidebar.liveSessionFor.mockReturnValue(null);
    getPromptContext.mockClear();
  });

  it("breaks long edited file names", async () => {
    const fileName = "camber-whisper-server-aarch64-apple-darwin";

    render(ConversationRowPopoverContent, {
      props: {
        session: {
          ...session,
          metadata: {
            processes: [],
            explored: [],
            edited: [{ fileName, filePath: `src/${fileName}` }],
          },
        },
        agentName: "Camber",
      },
    });

    const fileNameElement = await screen.findByText(fileName);
    expect(fileNameElement).toHaveClass("min-w-0", "break-all");
    expect(fileNameElement).not.toHaveClass("shrink-0");
  });

  it("caps long activity lists", () => {
    render(ConversationRowPopoverContent, {
      props: {
        session: {
          ...session,
          metadata: {
            processes: Array.from({ length: 8 }, (_, index) => `process ${index + 1}`),
            explored: [],
            edited: [],
          },
        },
        agentName: "Camber",
      },
    });

    expect(screen.queryByText("process 1")).not.toBeInTheDocument();
    expect(screen.getByText("process 8")).toBeInTheDocument();
    expect(screen.getByText("3 more")).toBeInTheDocument();
  });

  it("fetches the branch only after project details are expanded", async () => {
    sidebar.liveSessionFor.mockReturnValue({
      configOptions: [],
      usage: { used: 0, max: 0 },
      plan: null,
      metadata: { processes: [], explored: [], edited: [] },
      isPrompting: false,
    } as never);

    render(ConversationRowPopoverContent, {
      props: { session, agentName: "Camber" },
    });

    expect(getPromptContext).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Project details" }));

    await waitFor(() => expect(getPromptContext).toHaveBeenCalledOnce());
  });
});
