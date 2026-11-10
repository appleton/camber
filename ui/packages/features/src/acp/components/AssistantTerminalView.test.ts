import type { AssistantTerminalTab } from "@camber/rpc";
import { render, waitFor } from "@testing-library/svelte";
import { Terminal } from "@xterm/xterm";
import { tick, type ComponentProps } from "svelte";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { AssistantTerminalRepositoryWriter } from "../features/AssistantTerminalRepository.svelte";
import { initializeStatefulModule } from "../hostRpc";
import Harness from "./AssistantTerminalView.test.svelte";

// Capability queries a TUI typically sends at startup. xterm answers each of
// them through onData when they are parsed.
const CAPABILITY_QUERIES = "\x1b[c\x1b[?2026$p\x1b]11;?\x07";
// DSR "report device status" — xterm replies "\x1b[0n". Sent through the live
// path after a replay, its reply doubles as a barrier: xterm parses writes in
// order, so once this reply arrives the replayed buffer has been fully parsed.
const LIVE_PROBE = "\x1b[5n";
const LIVE_PROBE_REPLY = "\x1b[0n";

describe("AssistantTerminalView", () => {
  let hostMessageSender: ReturnType<typeof vi.fn>;
  let focusTerminal: MockInstance<Terminal["focus"]>;

  beforeAll(() => {
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
    // jsdom cannot host xterm's renderer, but the parser (and its onData query
    // replies) runs fine without a mounted element.
    vi.spyOn(Terminal.prototype, "open").mockImplementation(() => {});
    focusTerminal = vi.spyOn(Terminal.prototype, "focus").mockImplementation(() => {});
  });

  beforeEach(() => {
    hostMessageSender = vi.fn().mockResolvedValue(undefined);
    initializeStatefulModule(hostMessageSender);
    focusTerminal.mockClear();
  });

  function makeRepo(tabId: string, buffer: string) {
    const repo = new AssistantTerminalRepositoryWriter();
    const tab: AssistantTerminalTab = {
      id: tabId,
      title: "zsh",
      cwd: "/workspace",
      worktreePath: "/workspace",
      createdAt: new Date().toISOString(),
    };
    repo.tabs = [tab];
    repo.buffers = { [tabId]: buffer };
    repo.bufferStartOffsets = { [tabId]: 0 };
    return repo;
  }

  function ptyWrites() {
    return hostMessageSender.mock.calls.filter(([method]) => method === "writeAssistantTerminal");
  }

  it("does not send xterm's replies to replayed capability queries back to the PTY", async () => {
    const repo = makeRepo("t1", `$ claude\r\n${CAPABILITY_QUERIES}`);
    render(Harness, { props: { repo, terminalId: "t1" } });
    await waitFor(() =>
      expect(hostMessageSender).toHaveBeenCalledWith("resizeAssistantTerminal", expect.anything()),
    );

    repo.terminalDidWrite("t1", LIVE_PROBE);
    await waitFor(() => expect(ptyWrites()).toHaveLength(1));

    // Only the live probe's reply reached the PTY — the replies to the three
    // replayed queries were suppressed.
    expect(ptyWrites()).toEqual([["writeAssistantTerminal", ["t1", LIVE_PROBE_REPLY]]]);
  });

  it("suppresses query replies when a buffer trim jump forces a full re-write", async () => {
    const repo = makeRepo("t1", "$ ");
    render(Harness, { props: { repo, terminalId: "t1" } });
    await waitFor(() =>
      expect(hostMessageSender).toHaveBeenCalledWith("resizeAssistantTerminal", expect.anything()),
    );
    repo.terminalDidWrite("t1", LIVE_PROBE);
    await waitFor(() => expect(ptyWrites()).toHaveLength(1));

    // Jump the buffer window past everything rendered so far, as a large
    // trimmed burst of output would, forcing the reset-and-rewrite path.
    repo.bufferStartOffsets = { t1: 100_000 };
    repo.buffers = { t1: CAPABILITY_QUERIES };
    // Flush so the rewrite is enqueued before the probe: appended in the same
    // batch, the probe would be part of the rewritten buffer and its reply
    // (correctly) suppressed along with the rest.
    await tick();
    repo.terminalDidWrite("t1", LIVE_PROBE);
    await waitFor(() => expect(ptyWrites()).toHaveLength(2));

    expect(ptyWrites()[1]).toEqual(["writeAssistantTerminal", ["t1", LIVE_PROBE_REPLY]]);
  });

  describe("focus", () => {
    // requestAnimationFrame is stubbed to a timeout, so a macrotask turn is
    // enough to let any deferred focus land.
    const flushDeferredFocus = () => new Promise((resolve) => window.setTimeout(resolve, 0));

    async function renderAndWaitForTerminal(
      props: Omit<ComponentProps<typeof Harness>, "terminalId">,
    ) {
      const result = render(Harness, { props: { ...props, terminalId: "t1" } });
      await waitFor(() =>
        expect(hostMessageSender).toHaveBeenCalledWith(
          "resizeAssistantTerminal",
          expect.anything(),
        ),
      );
      await flushDeferredFocus();
      return result;
    }

    function addTab(repo: ReturnType<typeof makeRepo>, tabId: string) {
      repo.tabs = [
        ...repo.tabs,
        {
          id: tabId,
          title: "zsh",
          cwd: "/workspace",
          worktreePath: "/workspace",
          createdAt: new Date().toISOString(),
        },
      ];
      repo.buffers = { ...repo.buffers, [tabId]: "$ " };
      repo.bufferStartOffsets = { ...repo.bufferStartOffsets, [tabId]: 0 };
    }

    // Terminal.open is mocked, so the live xterm textarea never mounts; plant
    // a focusable stand-in where it would live to give the view real focus.
    function focusInsideTerminal(view: HTMLElement): HTMLTextAreaElement {
      const host = view.querySelector<HTMLElement>(".terminal-xterm");
      expect(host).not.toBeNull();
      const input = document.createElement("textarea");
      host!.appendChild(input);
      input.focus();
      expect(input).toHaveFocus();
      return input;
    }

    it("does not take focus when it renders without a focus request", async () => {
      const repo = makeRepo("t1", "$ ");
      const { rerender } = await renderAndWaitForTerminal({ repo });

      expect(focusTerminal).not.toHaveBeenCalled();

      // The same view focuses as soon as a request arrives, so it really had
      // finished rendering above — it just declined to take focus unasked.
      await rerender({ repo, terminalId: "t1", focusToken: 1 });
      await waitFor(() => expect(focusTerminal).toHaveBeenCalledTimes(1));
    });

    it("takes focus for a request made before it finished rendering", async () => {
      const repo = makeRepo("t1", "$ ");
      await renderAndWaitForTerminal({ repo, focusToken: 1 });

      await waitFor(() => expect(focusTerminal).toHaveBeenCalledTimes(1));
    });

    it("does not re-take focus when the host retitles the terminal", async () => {
      const repo = makeRepo("t1", "$ ");
      await renderAndWaitForTerminal({ repo, focusToken: 1 });
      await waitFor(() => expect(focusTerminal).toHaveBeenCalledTimes(1));

      // A long-running setup script retitles its terminal as it works, giving
      // `tab` a fresh identity. That used to re-apply the request the terminal
      // opened with and pull focus out of the prompt the user moved on to.
      repo.terminalDidUpdate({ terminalId: "t1", title: "git pull" });
      repo.terminalDidUpdate({ terminalId: "t1", title: "zsh" });
      // Two flushes: the first lets the focus effect run, the second lets any
      // focus it (wrongly) deferred through requestAnimationFrame land — the
      // effect flush schedules that timer after the first flush's own.
      await flushDeferredFocus();
      await flushDeferredFocus();

      expect(focusTerminal).toHaveBeenCalledTimes(1);
    });

    it("hands focus back when a render replaces the terminal the user was typing in", async () => {
      const repo = makeRepo("t1", "$ ");
      addTab(repo, "t2");
      const { container, rerender } = await renderAndWaitForTerminal({ repo });
      expect(focusTerminal).not.toHaveBeenCalled();
      focusInsideTerminal(container);

      // Replacing the rendered tab disposes the xterm the user was typing
      // into, dropping DOM focus to <body>; the completed render must repair
      // that — across the render restart that disposing itself triggers.
      await rerender({ repo, terminalId: "t2" });

      await waitFor(() => expect(focusTerminal).toHaveBeenCalledTimes(1));
    });

    it("keeps focus where the user moved it while a replacement render was in flight", async () => {
      const repo = makeRepo("t1", "$ ");
      addTab(repo, "t2");
      const outside = document.createElement("input");
      document.body.appendChild(outside);
      try {
        const { container, rerender } = await renderAndWaitForTerminal({ repo });
        focusInsideTerminal(container);

        await rerender({ repo, terminalId: "t2" });
        // The user reaches the prompt while the replacement is still
        // rendering; the held-focus debt must not be collected from them.
        outside.focus();

        await waitFor(() =>
          expect(hostMessageSender).toHaveBeenCalledWith(
            "resizeAssistantTerminal",
            expect.arrayContaining(["t2"]),
          ),
        );
        await flushDeferredFocus();
        await flushDeferredFocus();

        expect(focusTerminal).not.toHaveBeenCalled();
        expect(outside).toHaveFocus();
      } finally {
        outside.remove();
      }
    });
  });

  describe("mac text navigation", () => {
    let platformDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
      platformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    });

    afterEach(() => {
      if (platformDescriptor) {
        Object.defineProperty(navigator, "platform", platformDescriptor);
      } else {
        // jsdom serves platform from Navigator.prototype, so the override above
        // is an own property shadowing it; dropping that restores the getter.
        Reflect.deleteProperty(navigator, "platform");
      }
    });

    async function captureKeyEventHandler() {
      const attach = vi.spyOn(Terminal.prototype, "attachCustomKeyEventHandler");
      try {
        render(Harness, { props: { repo: makeRepo("t1", "$ "), terminalId: "t1" } });
        await waitFor(() => expect(attach).toHaveBeenCalled());
        const handler = attach.mock.calls.at(-1)?.[0];
        expect(handler).toBeDefined();
        return handler!;
      } finally {
        attach.mockRestore();
      }
    }

    function keydown(key: string, init: KeyboardEventInit) {
      const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
      return { event, stopPropagation: vi.spyOn(event, "stopPropagation") };
    }

    it("stops a mapped Cmd shortcut from escaping the terminal", async () => {
      const handler = await captureKeyEventHandler();
      const { event, stopPropagation } = keydown("ArrowLeft", { metaKey: true });

      expect(handler(event)).toBe(false);
      // Returning false skips the cancel() xterm's own key path ends with, so
      // the keydown used to bubble on to the splits container and move pane
      // focus (PE-2470).
      expect(event.defaultPrevented).toBe(true);
      expect(stopPropagation).toHaveBeenCalled();
    });

    it("leaves Option+Arrow to xterm, which cancels the event itself", async () => {
      const handler = await captureKeyEventHandler();
      const { event, stopPropagation } = keydown("ArrowLeft", { altKey: true });

      expect(handler(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(stopPropagation).not.toHaveBeenCalled();
    });
  });
});
