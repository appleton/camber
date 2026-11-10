import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import SessionEventsRendererHarness from "./SessionEventsRenderer.test.svelte";
import type { GroupedItem } from "./SessionEventsState.svelte";

describe("SessionEventsRenderer", () => {
  it("renders a visible boundary with both ACP agent icons", () => {
    const { container } = render(SessionEventsRendererHarness, {
      props: {
        events: [],
        items: [
          {
            id: "event-0",
            kind: "event",
            index: 0,
            event: {
              eventKind: "handoff",
              sourceAgentServer: "poolside",
              sourceSessionId: "source-session",
              targetAgentServer: "codex-acp",
              createdAt: "2026-07-15T10:00:00.000Z",
            },
          },
        ],
      },
    });

    expect(screen.getByText("Camber")).toBeInTheDocument();
    expect(screen.getByText("codex-acp")).toBeInTheDocument();
    expect(screen.getByText("Session handed off")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-handoff-agent]")).toHaveLength(2);
    expect(
      container.querySelector('[data-handoff-agent="source"] [aria-hidden="true"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-handoff-agent="target"] [aria-hidden="true"]'),
    ).toBeInTheDocument();
  });

  it("renders the copy action only after the last assistant text item in a response", () => {
    const { container } = render(SessionEventsRendererHarness, {
      props: {
        events: [],
        items: [agentMessageItem(0, "First output."), agentMessageItem(1, "Final output.")],
      },
    });

    const copy = screen.getByRole("button", { name: "copy to clipboard" });
    const messages = Array.from(container.querySelectorAll<HTMLElement>("[data-agent-message]"));

    expect(messages).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "copy to clipboard" })).toHaveLength(1);
    expect(follows(copy, messages[1])).toBe(true);
    expect(copy).toHaveClass("rounded-full");
    expect(copy.closest("[data-response-actions]")).toHaveClass(
      "pointer-events-none",
      "opacity-0",
      "focus-within:pointer-events-auto",
      "focus-within:opacity-100",
      "group-hover/response:pointer-events-auto",
      "group-hover/response:opacity-100",
    );
    expect(copy.closest("[data-response-actions]")).not.toHaveClass(
      "transition-opacity",
      "duration-150",
    );
  });

  it("renders the copy action after the trailing tool row of an interrupted response", () => {
    const { container } = render(SessionEventsRendererHarness, {
      props: {
        events: [],
        items: [
          agentMessageItem(0, "Call 1 succeeded. Now calling 2nd time:"),
          toolCallItem(1, "run-1", "cancelled"),
        ],
      },
    });

    const copy = screen.getByRole("button", { name: "copy to clipboard" });
    const message = container.querySelector<HTMLElement>("[data-agent-message]");
    const tool = screen.getByText("run-1");

    expect(screen.getAllByRole("button", { name: "copy to clipboard" })).toHaveLength(1);
    expect(follows(copy, message!)).toBe(true);
    expect(follows(copy, tool)).toBe(true);
  });

  it("does not render the copy action when tools ran without any response text", () => {
    render(SessionEventsRendererHarness, {
      props: {
        events: [],
        items: [toolCallItem(0, "run-1", "cancelled")],
      },
    });

    expect(screen.queryByRole("button", { name: "copy to clipboard" })).not.toBeInTheDocument();
  });

  it("copies the response text untrimmed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      const text = "  indented code line\n\ntrailing space  ";
      render(SessionEventsRendererHarness, {
        props: {
          events: [],
          items: [agentMessageItem(0, text)],
        },
      });

      await fireEvent.click(screen.getByRole("button", { name: "copy to clipboard" }));

      expect(writeText).toHaveBeenCalledWith(text);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not render the copy action for a whitespace-only response", () => {
    render(SessionEventsRendererHarness, {
      props: {
        events: [],
        items: [agentMessageItem(0, "   \n\n  ")],
      },
    });

    expect(screen.queryByRole("button", { name: "copy to clipboard" })).not.toBeInTheDocument();
  });

  it("renders the copy action after a group that absorbed the response text (interrupted compact turn)", () => {
    render(SessionEventsRendererHarness, {
      props: {
        events: [],
        items: [
          {
            id: "group-0",
            kind: "event_group",
            live: true,
            events: [
              toolCallItem(0, "read-1", "completed").event,
              agentMessageItem(1, "Call 1 succeeded. Now calling 2nd time:").event,
              toolCallItem(2, "run-1", "cancelled").event,
            ].map((event, index) => ({ event, index })),
          },
        ],
      },
    });

    const copy = screen.getByRole("button", { name: "copy to clipboard" });
    const group = screen.getByRole("button", { name: /steps?|command|file/i });

    expect(screen.getAllByRole("button", { name: "copy to clipboard" })).toHaveLength(1);
    expect(follows(copy, group)).toBe(true);
  });

  it("renders a folded steer prompt when the tool group is expanded", async () => {
    const { container } = render(SessionEventsRendererHarness, {
      props: {
        events: [],
        items: [
          {
            id: "group-0",
            kind: "event_group",
            live: true,
            events: [
              toolCallItem(0, "read-1", "completed").event,
              {
                eventKind: "user_message" as const,
                messageId: "steer-1",
                content: [{ type: "text" as const, text: "Focus on the failing test" }],
                steer: true as const,
              },
              toolCallItem(2, "run-1", "completed").event,
            ].map((event, index) => ({ event, index })),
          },
        ],
      },
    });

    expect(container.querySelector("[data-user-message]")).not.toBeInTheDocument();
    const disclosure = container.querySelector<HTMLButtonElement>("[data-disclosure]");
    expect(disclosure).not.toBeNull();
    await fireEvent.click(disclosure!);

    expect(screen.getByText("Focus on the failing test")).toBeInTheDocument();
    expect(screen.queryByText("Steered")).not.toBeInTheDocument();
    expect(container.querySelector("[data-steer-message]")).toBeInTheDocument();
  });

  it("does not render the copy action while the response is streaming", () => {
    render(SessionEventsRendererHarness, {
      props: {
        events: [],
        isPrompting: true,
        items: [agentMessageItem(0, "Still working.")],
      },
    });

    expect(screen.queryByRole("button", { name: "copy to clipboard" })).not.toBeInTheDocument();
  });

  it("keeps completed response copy actions visible while a later response streams", () => {
    const { container } = render(SessionEventsRendererHarness, {
      props: {
        events: [],
        isPrompting: true,
        items: [
          agentMessageItem(0, "Complete output."),
          userMessageItem(1),
          agentMessageItem(2, "Streaming output."),
        ],
      },
    });

    const copies = responseCopyButtons(container);
    const messages = Array.from(container.querySelectorAll<HTMLElement>("[data-agent-message]"));

    expect(messages).toHaveLength(2);
    expect(copies).toHaveLength(1);
    expect(follows(copies[0], messages[0])).toBe(true);
    expect(follows(messages[1], copies[0])).toBe(true);
  });

  it("uses settled Markdown blocks only for the newest message in the live response", async () => {
    const { container } = render(SessionEventsRendererHarness, {
      props: {
        events: [],
        isPrompting: true,
        items: [
          agentMessageItem(0, "Previous response.\n\nStill one canonical renderer."),
          userMessageItem(1),
          agentMessageItem(2, "Settled paragraph.\n\nThe **styled live tail"),
        ],
      },
    });

    await waitFor(() => {
      const messages = container.querySelectorAll<HTMLElement>("[data-agent-message]");
      expect(messages).toHaveLength(2);
      expect(messages[0]?.querySelectorAll(":scope > .markdown > .markdown")).toHaveLength(1);
      expect(messages[1]?.querySelectorAll(":scope > .markdown > .markdown")).toHaveLength(2);
      expect(messages[1]?.querySelector("strong")?.textContent).toBe("styled live tail");
    });
  });

  // A turn should carry at most one wavy rule. An end-of-turn summary is always
  // its turn's single fold; so is compact mode's live fold, which is why it gets
  // one too. Grouped mode raises and drops several live folds while a turn
  // streams, so those stay plain.
  it.each([
    { toolActivity: "compact", live: true, expected: 1, what: "compact mode's live fold" },
    { toolActivity: "grouped", live: true, expected: 0, what: "grouped mode's live folds" },
    { toolActivity: "compact", live: false, expected: 1, what: "a compact end-of-turn summary" },
    { toolActivity: "grouped", live: false, expected: 1, what: "a grouped end-of-turn summary" },
  ] as const)("draws $expected rule(s) for $what", ({ toolActivity, live, expected }) => {
    const { container } = render(SessionEventsRendererHarness, {
      props: {
        events: [],
        toolActivity,
        items: [toolGroupItem(live)],
      },
    });

    expect(container.querySelectorAll("[data-tool-group-rule]")).toHaveLength(expected);
  });
});

function toolGroupItem(live: boolean): Extract<GroupedItem, { kind: "event_group" }> {
  return {
    id: "group-0",
    kind: "event_group",
    ...(live ? { live } : {}),
    events: [0, 1].map((index) => ({
      index,
      event: {
        eventKind: "tool_call",
        toolCallId: `tool-${index}`,
        title: `Tool ${index}`,
        kind: "execute",
        status: "completed",
      },
    })),
  };
}

/** Whether `node` appears after `anchor` in document order. */
function follows(node: Element, anchor: Element): boolean {
  return !!(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** The response-footer copy buttons, excluding each user bubble's own copy action. */
function responseCopyButtons(container: HTMLElement): HTMLElement[] {
  return screen
    .getAllByRole("button", { name: "copy to clipboard" })
    .filter((button) => !button.closest("[data-user-message]") && container.contains(button));
}

function toolCallItem(
  index: number,
  title: string,
  status: "completed" | "cancelled",
): Extract<GroupedItem, { kind: "event" }> {
  return {
    id: `event-${index}`,
    kind: "event",
    index,
    event: {
      eventKind: "tool_call",
      toolCallId: title,
      title,
      kind: "execute",
      status,
    },
  };
}

function agentMessageItem(index: number, text: string): Extract<GroupedItem, { kind: "event" }> {
  return {
    id: `event-${index}`,
    kind: "event",
    index,
    event: {
      eventKind: "agent_message",
      messageId: `message-${index}`,
      content: [{ type: "text", text }],
    },
  };
}

function userMessageItem(index: number): Extract<GroupedItem, { kind: "event" }> {
  return {
    id: `event-${index}`,
    kind: "event",
    index,
    event: {
      eventKind: "user_message",
      messageId: `message-${index}`,
      content: [{ type: "text", text: "Next" }],
    },
  };
}
