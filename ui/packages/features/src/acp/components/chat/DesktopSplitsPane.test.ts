import { camberGitStatus } from "@camber/helperapi";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeStatefulModule } from "../../hostRpc";
import type { SessionEvent } from "../../types";
import { DesktopSplitsCache } from "./desktopSplitsCache";
import Harness from "./DesktopSplitsPane.test.svelte";

vi.mock("./ChatPane.svelte", async () => ({
  default: (await import("./DesktopSplitsPane.chat.mock.svelte")).default,
}));

vi.mock("@camber/helperapi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@camber/helperapi")>()),
  camberGitStatus: vi.fn(),
}));

describe("DesktopSplitsPane subagent tabs", () => {
  beforeAll(() => {
    Element.prototype.getAnimations = vi.fn().mockReturnValue([]);
    Element.prototype.animate = vi.fn().mockImplementation(() => ({
      cancel: vi.fn(),
      finish: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(),
      reverse: vi.fn(),
    }));
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      window.setTimeout(() => callback(performance.now()), 0);
      return 0;
    });
  });

  beforeEach(() => {
    localStorage.clear();
    initializeStatefulModule(vi.fn().mockResolvedValue(undefined));
    vi.mocked(camberGitStatus).mockResolvedValue({
      isRepo: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      stashCount: 0,
      additions: 0,
      deletions: 0,
    });
  });

  it("restores the chat tab's visible state when reselected after a subagent tab", async () => {
    const splitsCache = new DesktopSplitsCache();
    render(Harness, { props: { events: claudeEvents("in_progress"), splitsCache } });

    expect(screen.getByTestId("chat-mark-read")).toHaveAttribute("data-mark-read", "true");

    await fireEvent.click(
      await screen.findByRole("button", {
        name: "Open subagent transcript: Auth researcher, Running",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-mark-read")).toHaveAttribute("data-mark-read", "false"),
    );

    await fireEvent.click(screen.getByRole("tab", { name: "Chatting with Claude" }));
    await waitFor(() =>
      expect(screen.getByTestId("chat-mark-read")).toHaveAttribute("data-mark-read", "true"),
    );
  });

  it("creates, deduplicates, updates, closes, and reopens a Claude transcript tab", async () => {
    const splitsCache = new DesktopSplitsCache();
    const view = render(Harness, {
      props: { events: claudeEvents("in_progress"), splitsCache },
    });

    await fireEvent.click(
      await screen.findByRole("button", {
        name: "Open subagent transcript: Auth researcher, Running",
      }),
    );

    let subagentTab = await screen.findByRole("tab", { name: "Auth researcher" });
    expect(subagentTab).toHaveAttribute("aria-selected", "true");
    expect(within(subagentTab).getByTestId("desktop-subagent-tab-status")).toHaveAttribute(
      "data-status",
      "waiting",
    );
    const visibleIcon = subagentTab.querySelector<HTMLElement>(
      '.desktop-chat-tab-icon > span[style*="claude.svg"]',
    );
    expect(visibleIcon).toBeInTheDocument();
    expect(visibleIcon).toHaveClass("text-[#d97757]");
    expect(screen.getByRole("button", { name: "Close Auth researcher" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("tab", { name: "Chatting with Claude" }));
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Open subagent transcript: Auth researcher, Running",
      }),
    );
    expect(screen.getAllByRole("tab", { name: "Auth researcher" })).toHaveLength(1);
    expect(subagentDescriptors(splitsCache)).toHaveLength(1);

    await fireEvent.click(screen.getByRole("tab", { name: "Chatting with Claude" }));
    await view.rerender({ events: claudeEvents("in_progress", true) });
    await waitFor(() =>
      expect(screen.getByTestId("desktop-subagent-tab-status")).toHaveAttribute(
        "data-status",
        "waiting",
      ),
    );

    await view.rerender({ events: claudeEvents("completed", true) });
    await waitFor(() =>
      expect(screen.getByTestId("desktop-subagent-tab-status")).toHaveAttribute(
        "data-status",
        "unread",
      ),
    );

    await fireEvent.click(screen.getByRole("button", { name: "Close Auth researcher" }));
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Auth researcher" })).not.toBeInTheDocument(),
    );

    window.dispatchEvent(new CustomEvent("camber:desktop-reopen-closed-tab"));
    subagentTab = await screen.findByRole("tab", { name: "Auth researcher" });
    expect(subagentTab).toHaveAttribute("aria-selected", "true");
    expect(
      subagentTab.querySelector('.desktop-chat-tab-icon > span[style*="claude.svg"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Auth researcher" })).toBeInTheDocument();
    expect(subagentDescriptors(splitsCache)).toHaveLength(1);
  });
});

function claudeEvents(status: "in_progress" | "completed", withUpdate = false): SessionEvent[] {
  return [
    {
      eventKind: "tool_call",
      toolCallId: "task-auth",
      title: "Research auth",
      status,
      rawInput: { prompt: "Investigate authentication", description: "Auth researcher" },
      _meta: { claudeCode: { toolName: "Task", subagent: true } },
    },
    {
      eventKind: "agent_message",
      messageId: null,
      content: [{ type: "text", text: "The child transcript is here." }],
      _meta: { claudeCode: { parentToolUseId: "task-auth" } },
    },
    ...(withUpdate
      ? ([
          {
            eventKind: "agent_message",
            messageId: null,
            content: [{ type: "text", text: "The child transcript was updated." }],
            _meta: { claudeCode: { parentToolUseId: "task-auth" } },
          },
        ] satisfies SessionEvent[])
      : []),
  ];
}

function subagentDescriptors(splitsCache: DesktopSplitsCache) {
  const entry = splitsCache.get("conversation-test");
  return Object.values(entry?.descriptors ?? {}).filter(
    (descriptor) => descriptor.kind === "subagent-chat",
  );
}
