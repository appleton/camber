import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import type { MockInstance } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { ACPConversationSummary } from "../../navTypes";
import ConversationGroup from "./ConversationGroup.svelte";
import { rowExitAnimation } from "./rowExitAnimation.svelte";
import { ROW_EXIT_DURATION_MS } from "./rowExitTransition";

function animationDurations(animate: MockInstance<Element["animate"]>): number[] {
  return animate.mock.calls.map(([, options]) =>
    typeof options === "number" ? options : Number(options?.duration ?? Number.NaN),
  );
}

const sidebar = vi.hoisted(() => ({
  renameTarget: null,
  reviewSessionKey: vi.fn(() => "camber:conversation-1"),
  liveSessionFor: vi.fn(() => null),
  isRenamingConversation: vi.fn(() => false),
  getSessionAgentServer: vi.fn(() => "poolside"),
  agentIconColorClass: vi.fn(() => ""),
  openSession: vi.fn(),
  openConversationPreview: vi.fn(),
  leaveConversationPreview: vi.fn(),
  cancelConversationPreviewOpen: vi.fn(),
  unmountConversationPreviewRow: vi.fn(),
  refreshConversationPreview: vi.fn(),
  closeConversationPreview: vi.fn(),
  rowState: vi.fn(() => ({
    selected: false,
    agentName: "Camber",
    iconUrl: undefined,
    iconClass: "",
    titleClass: "",
    agentServer: "poolside",
    working: false,
    waitingForUser: false,
    unread: false,
  })),
}));

vi.mock("./SidebarController.svelte", () => ({
  getAcpSidebarController: () => sidebar,
}));

vi.mock("../../features/GithubRepository.svelte", () => ({
  getACPGithubRepo: () => ({ branchFor: () => "" }),
}));

function conversation(id: string): ACPConversationSummary {
  return {
    id,
    sessionId: `session-${id}`,
    agentServer: "poolside",
    workingDirectories: ["/repo"],
    cwd: "/repo",
    title: `Conversation ${id}`,
    updatedAt: null,
    source: "native_session",
    readOnly: false,
    errorMessage: null,
    cancellationReason: null,
    conversationId: id,
    conversationKind: "agentic",
    agentId: null,
    _meta: {},
  };
}

describe("ConversationGroup", () => {
  // The archive animation is chosen when the row leaves the list, so the
  // sidebar's exiting state has to be readable at that moment — not captured
  // when the row first rendered.
  it("asks whether a removed row is exiting as it leaves", async () => {
    const exiting = new Set<string>();
    const isSessionExiting = vi.fn((session: ACPConversationSummary) => exiting.has(session.id));

    const { rerender } = render(ConversationGroup, {
      props: {
        sessions: [conversation("a"), conversation("b")],
        workspacePath: "/repo",
        searchQuery: "",
        expanded: true,
        visibleLimit: 5,
        onToggleExpanded: vi.fn(),
        isSessionExiting,
      },
    });

    expect(isSessionExiting).not.toHaveBeenCalled();

    exiting.add("a");
    await rerender({ sessions: [conversation("b")] });

    const archived = isSessionExiting.mock.calls.find(([session]) => session.id === "a");
    expect(archived).toBeDefined();
    expect(isSessionExiting).toHaveReturnedWith(true);
  });

  it("flies an archived row out and drops a filtered-out row instantly", async () => {
    const animate = vi.spyOn(Element.prototype, "animate");
    try {
      const exiting = new Set<string>();
      const { rerender } = render(ConversationGroup, {
        props: {
          sessions: [conversation("a"), conversation("b")],
          workspacePath: "/repo",
          searchQuery: "",
          expanded: true,
          visibleLimit: 5,
          onToggleExpanded: vi.fn(),
          isSessionExiting: (session: ACPConversationSummary) => exiting.has(session.id),
        },
      });

      exiting.add("a");
      animate.mockClear();
      await rerender({ sessions: [conversation("b")] });
      expect(animationDurations(animate)).toContain(ROW_EXIT_DURATION_MS);

      // "b" now leaves without ever being marked as exiting, standing in for a
      // search or group collapse dropping the row. A zero duration makes Svelte
      // skip the animation altogether, so the row just disappears.
      animate.mockClear();
      await rerender({ sessions: [] });
      expect(animationDurations(animate)).not.toContain(ROW_EXIT_DURATION_MS);
    } finally {
      animate.mockRestore();
    }
  });

  // Emptying a group tears down the wrapper around the row list. The outro has
  // to survive that, or archiving the only conversation in a group — the usual
  // shape of a brand new one — skips the animation.
  it("flies out the last row in a group", async () => {
    const animate = vi.spyOn(Element.prototype, "animate");
    try {
      const exiting = new Set<string>();
      const { rerender } = render(ConversationGroup, {
        props: {
          sessions: [conversation("only")],
          workspacePath: "/repo",
          searchQuery: "",
          expanded: true,
          visibleLimit: 5,
          onToggleExpanded: vi.fn(),
          isSessionExiting: (session: ACPConversationSummary) => exiting.has(session.id),
        },
      });

      exiting.add("only");
      animate.mockClear();
      await rerender({ sessions: [] });

      expect(animationDurations(animate)).toContain(ROW_EXIT_DURATION_MS);
    } finally {
      animate.mockRestore();
    }
  });

  // The empty-state hold is released by the row's own outro events, so an
  // archived row must report its outro to the shared animation state — and a
  // filtered-out row must not, or it would end someone else's hold early.
  it("reports exit outros to the shared animation state", async () => {
    const started = vi.spyOn(rowExitAnimation, "outroStarted");
    const ended = vi.spyOn(rowExitAnimation, "outroEnded");
    try {
      const exiting = new Set<string>();
      const { rerender } = render(ConversationGroup, {
        props: {
          sessions: [conversation("a"), conversation("b")],
          workspacePath: "/repo",
          searchQuery: "",
          expanded: true,
          visibleLimit: 5,
          onToggleExpanded: vi.fn(),
          isSessionExiting: (session: ACPConversationSummary) => exiting.has(session.id),
        },
      });

      exiting.add("a");
      await rerender({ sessions: [conversation("b")] });
      // The stubbed Web Animations API finishes on a microtask.
      await tick();
      expect(started).toHaveBeenCalledOnce();
      expect(ended).toHaveBeenCalledOnce();

      await rerender({ sessions: [] });
      await tick();
      expect(started).toHaveBeenCalledOnce();
      expect(ended).toHaveBeenCalledOnce();
    } finally {
      started.mockRestore();
      ended.mockRestore();
    }
  });

  // The desktop webview can start the same element's outro twice for one
  // removal, and only the surviving animation reports outroend. Counting both
  // starts would strand the shared state at one outstanding outro, leaving
  // the release to the slow watchdog instead of the animation itself.
  it("counts a double-started outro once", () => {
    const started = vi.spyOn(rowExitAnimation, "outroStarted").mockImplementation(() => {});
    const ended = vi.spyOn(rowExitAnimation, "outroEnded").mockImplementation(() => {});
    try {
      render(ConversationGroup, {
        props: {
          sessions: [conversation("a")],
          workspacePath: "/repo",
          searchQuery: "",
          expanded: true,
          visibleLimit: 5,
          onToggleExpanded: vi.fn(),
          isSessionExiting: () => true,
        },
      });

      const flyElement = document
        .querySelector('[data-testid="acp-conversation-row"]')
        ?.closest("div.group");
      expect(flyElement).not.toBeNull();

      flyElement?.dispatchEvent(new CustomEvent("outrostart"));
      flyElement?.dispatchEvent(new CustomEvent("outrostart"));
      flyElement?.dispatchEvent(new CustomEvent("outroend"));

      expect(started).toHaveBeenCalledOnce();
      expect(ended).toHaveBeenCalledOnce();
    } finally {
      started.mockRestore();
      ended.mockRestore();
    }
  });

  it("reports a row filtered out by search as not exiting", async () => {
    const isSessionExiting = vi.fn(() => false);

    const { rerender } = render(ConversationGroup, {
      props: {
        sessions: [conversation("a"), conversation("b")],
        workspacePath: "/repo",
        searchQuery: "",
        expanded: true,
        visibleLimit: 5,
        onToggleExpanded: vi.fn(),
        isSessionExiting,
      },
    });

    await rerender({ sessions: [conversation("b")] });

    expect(isSessionExiting).toHaveBeenCalled();
    expect(isSessionExiting).not.toHaveReturnedWith(true);
  });
});
