import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ACPConversationSummary } from "../../navTypes";
import ConversationRowPopover from "./ConversationRowPopover.svelte";

const sidebar = vi.hoisted(() => ({
  renameTarget: null,
  reviewSessionKey: vi.fn(() => "camber:conversation-1"),
  isRenamingConversation: vi.fn(() => false),
  openConversationPreview: vi.fn(),
  leaveConversationPreview: vi.fn(),
  cancelConversationPreviewOpen: vi.fn(),
  unmountConversationPreviewRow: vi.fn(),
  refreshConversationPreview: vi.fn(),
  closeConversationPreview: vi.fn(),
}));

vi.mock("./SidebarController.svelte", () => ({
  getAcpSidebarController: () => sidebar,
}));

vi.mock("../../features/GithubRepository.svelte", () => ({
  getACPGithubRepo: () => ({ branchFor: () => "" }),
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

describe("ConversationRowPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes the open hover popover before opening the context menu", async () => {
    const onContextMenu = vi.fn();

    render(ConversationRowPopover, {
      props: {
        session,
        agentName: "Camber",
        onOpen: vi.fn(),
        onContextMenu,
      },
    });

    await fireEvent.contextMenu(screen.getByTestId("acp-conversation-row"));

    expect(sidebar.closeConversationPreview).toHaveBeenCalledOnce();
    expect(onContextMenu).toHaveBeenCalledOnce();
  });

  it("invokes the archive action from the row", async () => {
    const onArchive = vi.fn();

    render(ConversationRowPopover, {
      props: {
        session,
        agentName: "Camber",
        onOpen: vi.fn(),
        onArchive,
      },
    });

    const archiveButton = screen.getByRole("button", {
      name: "Archive Conversation title",
    });

    await fireEvent.click(archiveButton);

    expect(onArchive).toHaveBeenCalledOnce();
  });

  it("reserves the action gutter before hover", () => {
    render(ConversationRowPopover, {
      props: {
        session,
        agentName: "Camber",
        onOpen: vi.fn(),
        onArchive: vi.fn(),
      },
    });

    const archiveButton = screen.getByRole("button", {
      name: "Archive Conversation title",
    });
    const actionGutter = archiveButton.parentElement?.parentElement;

    expect(actionGutter).toHaveClass("min-w-[2rem]");
    expect(actionGutter?.className).not.toContain("group-hover:min-w");
  });

  it("delegates mouse entry to the shared preview controller", async () => {
    render(ConversationRowPopover, {
      props: {
        session,
        agentName: "Camber",
        onOpen: vi.fn(),
      },
    });

    const wrapper = screen.getByTestId("acp-conversation-row").parentElement?.parentElement;
    expect(wrapper).not.toBeNull();

    await fireEvent.pointerEnter(wrapper!, {
      pointerType: "mouse",
      clientX: 20,
      clientY: 40,
    });

    expect(sidebar.openConversationPreview).toHaveBeenCalledOnce();
  });
});
