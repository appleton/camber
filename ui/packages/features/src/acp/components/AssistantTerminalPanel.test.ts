import type { AssistantTerminalTab } from "@camber/rpc";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { Terminal } from "@xterm/xterm";
import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AssistantTerminalRepositoryWriter } from "../features/AssistantTerminalRepository.svelte";
import { initializeStatefulModule } from "../hostRpc";
import Harness from "./AssistantTerminalPanel.test.svelte";

describe("AssistantTerminalPanel", () => {
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
    // jsdom cannot host xterm's renderer, but the parser runs fine without a
    // mounted element.
    vi.spyOn(Terminal.prototype, "open").mockImplementation(() => {});
    focusTerminal = vi.spyOn(Terminal.prototype, "focus").mockImplementation(() => {});
  });

  beforeEach(() => {
    hostMessageSender = vi.fn().mockImplementation((method: string) => {
      if (method === "listAssistantTerminals") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    initializeStatefulModule(hostMessageSender);
    focusTerminal.mockClear();
  });

  function tab(id: string): AssistantTerminalTab {
    return {
      id,
      title: "zsh",
      cwd: "/workspace",
      worktreePath: "/workspace",
      createdAt: new Date().toISOString(),
    };
  }

  function makeRepo(...tabIds: string[]) {
    const repo = new AssistantTerminalRepositoryWriter();
    repo.currentWorktreePath = "/workspace";
    repo.tabs = tabIds.map(tab);
    repo.buffers = Object.fromEntries(tabIds.map((id) => [id, "$ "]));
    repo.bufferStartOffsets = Object.fromEntries(tabIds.map((id) => [id, 0]));
    return repo;
  }

  async function waitForTerminalRender(id: string) {
    await waitFor(() =>
      expect(hostMessageSender).toHaveBeenCalledWith(
        "resizeAssistantTerminal",
        expect.arrayContaining([id]),
      ),
    );
  }

  // The panel is only mounted while the user has it open, so — unlike the
  // desktop splits, where terminals appear as background tabs — its terminal
  // is entitled to focus on arrival and on every tab the user picks. The
  // view no longer focuses itself on render, so the panel must ask.
  it("focuses its terminal on arrival", async () => {
    const repo = makeRepo("t1");
    render(Harness, { props: { repo, worktreePath: "/workspace" } });
    await waitForTerminalRender("t1");

    await waitFor(() => expect(focusTerminal).toHaveBeenCalledTimes(1));
  });

  it("focuses the terminal the user selects", async () => {
    const repo = makeRepo("t1", "t2");
    render(Harness, { props: { repo, worktreePath: "/workspace" } });
    await waitForTerminalRender("t1");
    await waitFor(() => expect(focusTerminal).toHaveBeenCalledTimes(1));

    const tabs = screen.getAllByRole("tab");
    await fireEvent.click(tabs[1]!.querySelector(".terminal-tab-select")!);

    await waitForTerminalRender("t2");
    await waitFor(() => expect(focusTerminal).toHaveBeenCalledTimes(2));
  });
});
